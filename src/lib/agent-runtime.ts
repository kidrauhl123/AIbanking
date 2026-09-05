import { randomUUID } from "node:crypto";
import {
  Annotation,
  Command,
  END,
  INTERRUPT,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  executePlannedAgent,
  planAgentRequest,
  type AgentReply,
  type ModelMeta,
} from "./agent";
import { composeGroundedReply, type AgentUnderstanding, type ConversationMessage } from "./ai";
import { writeAudit } from "./audit";
import { getOperation } from "./bank-core";
import { enqueueChannelNotification, type AgentChannel, hashChannelValue } from "./channels";
import { db, query, withTransaction } from "./db";

type AuthorizationResume = {
  approved: boolean;
  operationId: string;
};

type AuthorizationInterrupt = {
  kind: "BANK_OPERATION_AUTHORIZATION";
  taskId: string;
  operationId: string;
  riskLevel: "GREEN" | "YELLOW" | "RED";
  requiredAuth: "CONFIRM" | "MFA";
  title: string;
  details: Array<{ label: string; value: string }>;
};

const RuntimeState = Annotation.Root({
  runId: Annotation<string>,
  customerId: Annotation<string>,
  message: Annotation<string>,
  history: Annotation<ConversationMessage[]>,
  understanding: Annotation<AgentUnderstanding | null>,
  modelMeta: Annotation<ModelMeta | null>,
  reply: Annotation<AgentReply | null>,
  authorization: Annotation<AuthorizationResume | null>,
});

type RuntimeStateType = typeof RuntimeState.State;

const planNode: typeof RuntimeState.Node = async (state) => {
  const planned = await planAgentRequest(state.message, state.history);
  return {
    message: planned.normalized,
    understanding: planned.understanding,
    modelMeta: planned.meta,
  };
};

function routeIntent(state: RuntimeStateType) {
  return state.understanding?.intent.toLowerCase() ?? "unknown";
}

const executeIntentNode: typeof RuntimeState.Node = async (state) => {
  if (!state.understanding || !state.modelMeta) throw new Error("AGENT_PLAN_MISSING");
  const reply = await executePlannedAgent(state.customerId, state.message, state.understanding, state.modelMeta);
  return { reply };
};

function routeAfterIntent(state: RuntimeStateType) {
  return state.reply?.operation ? "authorization_gate" : "complete";
}

const authorizationGateNode: typeof RuntimeState.Node = async (state) => {
  const operation = state.reply?.operation;
  if (!operation || !state.reply) throw new Error("AGENT_OPERATION_MISSING");
  const decision = interrupt<AuthorizationInterrupt, AuthorizationResume>({
    kind: "BANK_OPERATION_AUTHORIZATION",
    taskId: state.reply.taskId,
    operationId: operation.operationId,
    riskLevel: operation.riskLevel,
    requiredAuth: operation.requiredAuth,
    title: operation.title,
    details: operation.details,
  });
  if (decision.operationId !== operation.operationId) throw new Error("AUTHORIZATION_MISMATCH");
  return { authorization: decision };
};

async function cancelPreparedOperation(state: RuntimeStateType) {
  const reply = state.reply;
  if (!reply?.operation) throw new Error("AGENT_OPERATION_MISSING");
  const operation = reply.operation;
  await withTransaction(async (client) => {
    if (operation.type === "TRANSFER") {
      await client.query(
        `UPDATE transfers SET status='CANCELLED',version=version+1
         WHERE operation_id=$1 AND customer_id=$2 AND status='AWAITING_AUTH'`,
        [operation.operationId, state.customerId],
      );
    }
    await client.query(
      "UPDATE agent_tasks SET status='CANCELLED',updated_at=now() WHERE id=$1 AND customer_id=$2",
      [reply.taskId, state.customerId],
    );
    await writeAudit({
      customerId: state.customerId,
      taskId: reply.taskId,
      operationId: operation.operationId,
      eventType: "AGENT_OPERATION_CANCELLED",
      actorType: "USER",
      summary: "客户拒绝待授权操作，银行核心未执行",
      evidence: { graphRunId: state.runId, operationType: operation.type },
    }, client);
  });
  const grounded = await composeGroundedReply({
    userMessage: state.message,
    intent: reply.intent,
    state: "COMPLETED",
    facts: {
      operationId: operation.operationId,
      operationState: "CANCELLED",
      operationExecuted: false,
    },
  });
  return {
    ...reply,
    message: grounded.value.message,
    suggestions: grounded.value.suggestions,
    operation: undefined,
  } satisfies AgentReply;
}

async function verifyCommittedOperation(state: RuntimeStateType) {
  const reply = state.reply;
  if (!reply?.operation) throw new Error("AGENT_OPERATION_MISSING");
  let facts: Record<string, unknown>;
  if (reply.operation.type === "TRANSFER") {
    const operation = await getOperation(state.customerId, reply.operation.operationId);
    if (operation.status !== "SUCCEEDED") throw new Error("OPERATION_NOT_EXECUTED");
    facts = {
      operationId: operation.operationId,
      operationState: operation.status,
      operationExecuted: true,
      ...operation.details,
    };
  } else if (reply.operation.type === "CARD_LOCK") {
    const card = await query<{ card_name: string; masked_no: string; status: string }>(
      `SELECT card_name,masked_no,status FROM cards
       WHERE id=$1 AND customer_id=$2`,
      [reply.operation.resourceId, state.customerId],
    );
    if (card.rows[0]?.status !== "LOCKED") throw new Error("OPERATION_NOT_EXECUTED");
    facts = {
      operationId: reply.operation.operationId,
      operationState: "SUCCEEDED",
      operationExecuted: true,
      cardName: card.rows[0].card_name,
      maskedNo: card.rows[0].masked_no,
      cardStatus: card.rows[0].status,
    };
  } else {
    throw new Error("OPERATION_TYPE_NOT_SUPPORTED");
  }
  const grounded = await composeGroundedReply({
    userMessage: state.message,
    intent: reply.intent,
    state: "COMPLETED",
    facts,
  });
  await query(
    `INSERT INTO task_nodes
      (task_id,node_key,tool_name,status,dependencies,input_summary,output_summary,started_at,completed_at)
     VALUES ($1,'verify_completion','langgraph.bank_fact.verify','SUCCEEDED',$2::jsonb,$3::jsonb,$4::jsonb,now(),now())
     ON CONFLICT (task_id,node_key) DO UPDATE SET status='SUCCEEDED',output_summary=excluded.output_summary,completed_at=now()`,
    [reply.taskId, JSON.stringify(["authorization_gate"]), JSON.stringify({ operationId: reply.operation.operationId }), JSON.stringify({ verified: true })],
  );
  return {
    ...reply,
    message: grounded.value.message,
    suggestions: grounded.value.suggestions,
    operation: undefined,
  } satisfies AgentReply;
}

const verifyCompletionNode: typeof RuntimeState.Node = async (state) => {
  if (!state.authorization) throw new Error("AUTHORIZATION_RESULT_MISSING");
  return {
    reply: state.authorization.approved
      ? await verifyCommittedOperation(state)
      : await cancelPreparedOperation(state),
  };
};

function buildGraph(checkpointer: PostgresSaver) {
  const graph = new StateGraph(RuntimeState)
    .addNode("plan", planNode)
    .addNode("balance", executeIntentNode)
    .addNode("bill_analysis", executeIntentNode)
    .addNode("subscriptions", executeIntentNode)
    .addNode("card_lock", executeIntentNode)
    .addNode("transfer", executeIntentNode)
    .addNode("unknown", executeIntentNode)
    .addNode("authorization_gate", authorizationGateNode)
    .addNode("verify_completion", verifyCompletionNode)
    .addNode("complete", (state) => ({ reply: state.reply }))
    .addEdge(START, "plan")
    .addConditionalEdges("plan", routeIntent, ["balance", "bill_analysis", "subscriptions", "card_lock", "transfer", "unknown"]);

  for (const node of ["balance", "bill_analysis", "subscriptions", "card_lock", "transfer", "unknown"] as const) {
    graph.addConditionalEdges(node, routeAfterIntent, ["authorization_gate", "complete"]);
  }
  return graph
    .addEdge("authorization_gate", "verify_completion")
    .addEdge("verify_completion", "complete")
    .addEdge("complete", END)
    .compile({ checkpointer });
}

type CompiledAgentGraph = ReturnType<typeof buildGraph>;
const globalForRuntime = globalThis as unknown as { bankpilotGraph?: Promise<CompiledAgentGraph> };

async function getAgentGraph() {
  if (!globalForRuntime.bankpilotGraph) {
    globalForRuntime.bankpilotGraph = (async () => {
      const checkpointer = new PostgresSaver(db, undefined, { schema: "langgraph" });
      await checkpointer.setup();
      return buildGraph(checkpointer);
    })();
  }
  return globalForRuntime.bankpilotGraph;
}

async function getOrCreateAgentThread(input: {
  customerId: string;
  channelType: AgentChannel;
  externalConversationId: string;
  channelIdentityId?: string | null;
}) {
  const externalHash = hashChannelValue(`${input.channelType}:${input.externalConversationId}`);
  const result = await query<{ id: string }>(
    `INSERT INTO agent_threads
      (customer_id,channel_type,channel_identity_id,external_conversation_hash)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (customer_id,channel_type,external_conversation_hash)
     DO UPDATE SET updated_at=now(),channel_identity_id=COALESCE(excluded.channel_identity_id,agent_threads.channel_identity_id)
     RETURNING id`,
    [input.customerId, input.channelType, input.channelIdentityId ?? null, externalHash],
  );
  return result.rows[0].id;
}

export async function runAgentRuntime(input: {
  customerId: string;
  message: string;
  history?: ConversationMessage[];
  channelType: AgentChannel;
  externalConversationId: string;
  channelIdentityId?: string | null;
}) {
  const agentThreadId = await getOrCreateAgentThread(input);
  const runId = randomUUID();
  const graphThreadId = randomUUID();
  await query(
    `INSERT INTO agent_runtime_runs
      (id,agent_thread_id,customer_id,graph_thread_id,channel_type,status)
     VALUES ($1,$2,$3,$4,$5,'RUNNING')`,
    [runId, agentThreadId, input.customerId, graphThreadId, input.channelType],
  );
  const graph = await getAgentGraph();
  try {
    const result = await graph.invoke({
      runId,
      customerId: input.customerId,
      message: input.message,
      history: input.history ?? [],
      understanding: null,
      modelMeta: null,
      reply: null,
      authorization: null,
    }, { configurable: { thread_id: graphThreadId } });
    const reply = result.reply;
    if (!reply) throw new Error("AGENT_REPLY_MISSING");
    const interrupted = isInterrupted(result);
    const interruptKind = reply.operation?.requiredAuth ?? null;
    await query(
      `UPDATE agent_runtime_runs SET task_id=$2,status=$3,interrupt_kind=$4,operation_id=$5,
       final_reply=$6::jsonb,updated_at=now(),completed_at=CASE WHEN $3='COMPLETED' THEN now() ELSE NULL END
       WHERE id=$1`,
      [runId, reply.taskId, interrupted ? "INTERRUPTED" : "COMPLETED", interrupted ? interruptKind : null, reply.operation?.operationId ?? null, JSON.stringify(reply)],
    );
    await writeAudit({
      customerId: input.customerId,
      taskId: reply.taskId,
      operationId: reply.operation?.operationId,
      eventType: interrupted ? "AGENT_GRAPH_INTERRUPTED" : "AGENT_GRAPH_COMPLETED",
      actorType: "AGENT",
      summary: interrupted ? "LangGraph 已持久化任务并等待银行授权" : "LangGraph 完成任务运行",
      evidence: { runId, graphThreadId, channelType: input.channelType, interruptKind },
    });
    return {
      ...reply,
      runtime: {
        runId,
        status: interrupted ? "INTERRUPTED" as const : "COMPLETED" as const,
        ...(interrupted && interruptKind ? { interruptKind } : {}),
      },
    };
  } catch (error) {
    await query(
      "UPDATE agent_runtime_runs SET status='FAILED',updated_at=now(),completed_at=now() WHERE id=$1",
      [runId],
    );
    throw error;
  }
}

export async function resumeAgentRuntime(input: {
  customerId: string;
  taskId: string;
  operationId: string;
  approved: boolean;
}) {
  const run = await query<{
    id: string;
    graph_thread_id: string;
    status: string;
    operation_id: string;
    final_reply: AgentReply | null;
    channel_type: AgentChannel;
    channel_identity_id: string | null;
  }>(
    `UPDATE agent_runtime_runs r SET status='RUNNING',updated_at=now()
     FROM agent_threads t
     WHERE r.agent_thread_id=t.id AND r.customer_id=$1 AND r.task_id=$2
       AND r.operation_id=$3 AND r.status='INTERRUPTED'
     RETURNING r.id,r.graph_thread_id,r.status,r.operation_id,r.final_reply,
       r.channel_type,t.channel_identity_id`,
    [input.customerId, input.taskId, input.operationId],
  );
  const current = run.rows[0];
  if (!current) {
    const existing = await query<{ status: string; operation_id: string; final_reply: AgentReply | null }>(
      `SELECT status,operation_id,final_reply FROM agent_runtime_runs
       WHERE customer_id=$1 AND task_id=$2`,
      [input.customerId, input.taskId],
    );
    const found = existing.rows[0];
    if (!found || found.operation_id !== input.operationId) throw new Error("AGENT_RUN_NOT_FOUND");
    if (["COMPLETED", "CANCELLED"].includes(found.status) && found.final_reply) return found.final_reply;
    throw new Error("AGENT_RUN_NOT_RESUMABLE");
  }

  const graph = await getAgentGraph();
  try {
    const result = await graph.invoke(
      new Command({ resume: { approved: input.approved, operationId: input.operationId } satisfies AuthorizationResume }),
      { configurable: { thread_id: current.graph_thread_id } },
    );
    if (isInterrupted(result) || !result.reply) throw new Error("AGENT_RESUME_INCOMPLETE");
    const finalStatus = input.approved ? "COMPLETED" : "CANCELLED";
    await query(
      `UPDATE agent_runtime_runs SET status=$2,interrupt_kind=NULL,final_reply=$3::jsonb,
       updated_at=now(),completed_at=now() WHERE id=$1 AND status='RUNNING'`,
      [current.id, finalStatus, JSON.stringify(result.reply)],
    );
    await writeAudit({
      customerId: input.customerId,
      taskId: input.taskId,
      operationId: input.operationId,
      eventType: "AGENT_GRAPH_RESUMED",
      actorType: "AGENT",
      summary: "LangGraph 从持久化授权节点恢复并核验银行结果",
      evidence: { runId: current.id, graphThreadId: current.graph_thread_id, approved: input.approved },
    });
    if (["WECOM", "QQ"].includes(current.channel_type) && current.channel_identity_id) {
      await enqueueChannelNotification({
        channelType: current.channel_type as "WECOM" | "QQ",
        identityId: current.channel_identity_id,
        customerId: input.customerId,
        taskId: input.taskId,
        dedupeKey: `agent-run:${current.id}:${finalStatus}`,
        payload: {
          type: "AGENT_RUN_RESULT",
          status: finalStatus,
          operationId: input.operationId,
          message: result.reply.message,
        },
      });
    }
    return result.reply;
  } catch (error) {
    await query(
      `UPDATE agent_runtime_runs SET status='INTERRUPTED',updated_at=now()
       WHERE id=$1 AND status='RUNNING'`,
      [current.id],
    );
    throw error;
  }
}

export async function inspectAgentRun(customerId: string, taskId: string) {
  const result = await query<{
    id: string;
    task_id: string;
    status: string;
    interrupt_kind: "CONFIRM" | "MFA" | null;
    operation_id: string | null;
    channel_type: AgentChannel;
    channel_identity_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT r.id,r.task_id,r.status,r.interrupt_kind,r.operation_id,r.channel_type,
       t.channel_identity_id,r.created_at::text,r.updated_at::text
     FROM agent_runtime_runs r JOIN agent_threads t ON t.id=r.agent_thread_id
     WHERE r.customer_id=$1 AND r.task_id=$2`,
    [customerId, taskId],
  );
  return result.rows[0] ?? null;
}

export function extractInterrupts(result: unknown) {
  if (!result || typeof result !== "object" || !(INTERRUPT in result)) return [];
  return (result as Record<typeof INTERRUPT, unknown[]>)[INTERRUPT] ?? [];
}
