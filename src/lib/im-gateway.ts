import { inspectAgentRun, resumeAgentRuntime, runAgentRuntime } from "./agent-runtime";
import { commitPreparedCardLock, commitTransfer } from "./bank-core";
import {
  createChannelBindingToken,
  recordChannelEvent,
  resolveChannelIdentity,
  type ChannelType,
} from "./channels";
import { query } from "./db";

type GatewayConfig = { channelType: ChannelType; bindingPath: `/connect/${string}` };

function configuredPublicUrl() {
  const value = process.env.BANKPILOT_PUBLIC_URL?.replace(/\/$/, "");
  if (!value) throw new Error("PUBLIC_URL_NOT_CONFIGURED");
  const parsed = new URL(value);
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("PUBLIC_URL_INVALID");
  return parsed.origin;
}

function operationLink(operationId: string, taskId: string) {
  const params = new URLSearchParams({ authorize: operationId, task: taskId });
  return `${configuredPublicUrl()}/?${params.toString()}`;
}

export type ChannelMessageInput = {
  tenantExternalId: string;
  subjectExternalId: string;
  conversationExternalId: string;
  eventId: string;
  message: string;
};

export async function handleChannelMessage(config: GatewayConfig, input: ChannelMessageInput) {
  const inbound = await recordChannelEvent({
    channelType: config.channelType,
    direction: "INBOUND",
    externalEventId: input.eventId,
    eventType: "TEXT_MESSAGE",
    payloadSummary: { characters: input.message.length },
    outcome: "RECEIVED",
  });
  if (!inbound.rowCount) return { status: "DUPLICATE" as const };

  const identity = await resolveChannelIdentity({
    channelType: config.channelType,
    tenantExternalId: input.tenantExternalId,
    subjectExternalId: input.subjectExternalId,
  });
  if (!identity) {
    const binding = await createChannelBindingToken({
      channelType: config.channelType,
      tenantExternalId: input.tenantExternalId,
      subjectExternalId: input.subjectExternalId,
    });
    const bindUrl = `${configuredPublicUrl()}${config.bindingPath}#token=${encodeURIComponent(binding.token)}`;
    await recordChannelEvent({
      channelType: config.channelType,
      direction: "OUTBOUND",
      externalEventId: input.eventId,
      eventType: "BINDING_REQUIRED",
      payloadSummary: { expiresAt: binding.expiresAt },
      outcome: "READY",
    });
    return {
      status: "BINDING_REQUIRED" as const,
      message: "请打开下方链接，在 BankPilot 登录并核对账户，再点“确认连接”。链接 10 分钟内有效。完成后回到这里重新发送你的请求。",
      bindUrl,
      expiresAt: binding.expiresAt,
    };
  }

  await query(
    `UPDATE channel_events SET channel_identity_id=$2,customer_id=$3
     WHERE channel_type=$4 AND direction='INBOUND' AND external_event_id=$1`,
    [input.eventId, identity.id, identity.customer_id, config.channelType],
  );
  if (["绑定", "/bind"].includes(input.message.trim())) {
    return { status: "COMPLETED" as const, reply: { message: "当前聊天身份已经连接 BankPilot。发送“查余额”即可开始使用；如需解绑，请打开 BankPilot 的消息渠道页面。" } };
  }
  const reply = await runAgentRuntime({
    customerId: identity.customer_id,
    message: input.message,
    channelType: config.channelType,
    externalConversationId: input.conversationExternalId,
    channelIdentityId: identity.id,
  });
  await recordChannelEvent({
    identityId: identity.id,
    customerId: identity.customer_id,
    taskId: reply.taskId,
    channelType: config.channelType,
    direction: "OUTBOUND",
    externalEventId: input.eventId,
    eventType: reply.operation ? "AUTHORIZATION_REQUEST" : "AGENT_REPLY",
    payloadSummary: {
      runtimeStatus: reply.runtime?.status,
      riskLevel: reply.operation?.riskLevel,
      operationId: reply.operation?.operationId,
    },
    outcome: "READY",
  });
  if (!reply.operation) return { status: "COMPLETED" as const, reply };
  return {
    status: "AUTHORIZATION_REQUIRED" as const,
    reply,
    authorizeUrl: reply.operation.requiredAuth === "MFA"
      ? operationLink(reply.operation.operationId, reply.taskId)
      : null,
  };
}

export type ChannelActionInput = {
  tenantExternalId: string;
  subjectExternalId: string;
  eventId: string;
  taskId: string;
  operationId: string;
  approved: boolean;
};

export async function handleChannelAction(config: GatewayConfig, input: ChannelActionInput) {
  const identity = await resolveChannelIdentity({
    channelType: config.channelType,
    tenantExternalId: input.tenantExternalId,
    subjectExternalId: input.subjectExternalId,
  });
  if (!identity) throw new Error("CHANNEL_IDENTITY_NOT_FOUND");
  const inbound = await recordChannelEvent({
    identityId: identity.id,
    customerId: identity.customer_id,
    taskId: input.taskId,
    channelType: config.channelType,
    direction: "INBOUND",
    externalEventId: input.eventId,
    eventType: input.approved ? "AUTHORIZATION_APPROVED" : "AUTHORIZATION_REJECTED",
    payloadSummary: { operationId: input.operationId },
    outcome: "RECEIVED",
  });
  if (!inbound.rowCount) return { status: "DUPLICATE" as const };

  const run = await inspectAgentRun(identity.customer_id, input.taskId);
  if (!run || run.operation_id !== input.operationId || run.channel_type !== config.channelType || run.channel_identity_id !== identity.id) {
    throw new Error("AGENT_RUN_NOT_FOUND");
  }
  if (run.status !== "INTERRUPTED") throw new Error("AGENT_RUN_NOT_RESUMABLE");
  if (!input.approved) {
    const reply = await resumeAgentRuntime({
      customerId: identity.customer_id,
      taskId: input.taskId,
      operationId: input.operationId,
      approved: false,
    });
    return { status: "CANCELLED" as const, reply };
  }
  if (run.interrupt_kind === "MFA") {
    return {
      status: "MFA_REQUIRED" as const,
      message: "这是高风险操作，必须回到 BankPilot 使用动态验证码完成强验证。",
      authorizeUrl: operationLink(input.operationId, input.taskId),
    };
  }
  if (run.interrupt_kind !== "CONFIRM") throw new Error("AUTHORIZATION_MISMATCH");

  const operation = await query<{ final_reply: { operation?: { type?: string; resourceId?: string } } }>(
    `SELECT final_reply FROM agent_runtime_runs
     WHERE customer_id=$1 AND task_id=$2 AND operation_id=$3`,
    [identity.customer_id, input.taskId, input.operationId],
  );
  const prepared = operation.rows[0]?.final_reply?.operation;
  if (prepared?.type === "TRANSFER") {
    const committed = await commitTransfer(identity.customer_id, input.operationId, { taskId: input.taskId });
    if ("authError" in committed) throw new Error(committed.authError);
  } else if (prepared?.type === "CARD_LOCK" && prepared.resourceId) {
    await commitPreparedCardLock(identity.customer_id, input.operationId, {
      taskId: input.taskId,
      resourceId: prepared.resourceId,
    });
  } else {
    throw new Error("OPERATION_TYPE_NOT_SUPPORTED");
  }
  const reply = await resumeAgentRuntime({
    customerId: identity.customer_id,
    taskId: input.taskId,
    operationId: input.operationId,
    approved: true,
  });
  return { status: "COMPLETED" as const, reply };
}
