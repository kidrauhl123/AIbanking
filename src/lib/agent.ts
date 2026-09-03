import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  composeGroundedReply,
  understandWithAI,
  type AgentUnderstanding,
  type ConversationMessage,
} from "./ai";
import { writeAudit } from "./audit";
import { query } from "./db";
import { formatMinor, type RiskLevel } from "./policy";
import { prepareTransfer } from "./bank-core";

export type AgentOperation = {
  type: "TRANSFER" | "CARD_LOCK" | "SUBSCRIPTION_CANCEL";
  operationId: string;
  title: string;
  riskLevel: RiskLevel;
  requiredAuth: "CONFIRM" | "MFA";
  details: Array<{ label: string; value: string }>;
  resourceId?: string;
  actionLabel: string;
};

export type AgentReply = {
  taskId: string;
  intent: AgentUnderstanding["intent"];
  message: string;
  operation?: AgentOperation;
  data?: Record<string, unknown>;
  suggestions?: string[];
  ai: { model: string; confidence: number };
};

type ModelMeta = {
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
};

function taskPlan(understanding: AgentUnderstanding) {
  return [
    { id: "understand_intent", tool: "ai.intent.plan", dependsOn: [] },
    ...understanding.steps.map((id, index) => ({
      id,
      tool: "planned",
      dependsOn: [index === 0 ? "understand_intent" : understanding.steps[index - 1]],
    })),
  ];
}

async function createTask(customerId: string, message: string, understanding: AgentUnderstanding, riskLevel: RiskLevel, meta: ModelMeta) {
  const result = await query<{ id: string }>(
    `INSERT INTO agent_tasks (customer_id, user_utterance, intent, status, risk_level, plan)
     VALUES ($1,$2,$3,'RUNNING',$4,$5::jsonb) RETURNING id`,
    [customerId, message, understanding.intent, riskLevel, JSON.stringify(taskPlan(understanding))],
  );
  const taskId = result.rows[0].id;
  await addNode(
    taskId,
    "understand_intent",
    "ai.intent.plan",
    [],
    { historyUsed: true },
    {
      intent: understanding.intent,
      confidence: understanding.confidence,
      entities: understanding.entities,
      plannedSteps: understanding.steps,
      model: meta.model,
      promptTokens: meta.promptTokens,
      completionTokens: meta.completionTokens,
    },
  );
  await writeAudit({
    customerId,
    eventType: "AI_PLAN_ACCEPTED",
    actorType: "AGENT",
    summary: "大模型结构化意图与计划通过 Schema 校验",
    taskId,
    evidence: { model: meta.model, intent: understanding.intent, confidence: understanding.confidence, plannedSteps: understanding.steps },
  });
  return taskId;
}

async function addNode(
  taskId: string,
  nodeKey: string,
  toolName: string,
  dependencies: string[],
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  client?: PoolClient,
) {
  const sql = `INSERT INTO task_nodes
      (task_id,node_key,tool_name,status,dependencies,input_summary,output_summary,started_at,completed_at)
     VALUES ($1,$2,$3,'SUCCEEDED',$4::jsonb,$5::jsonb,$6::jsonb,now(),now())
     ON CONFLICT (task_id,node_key) DO UPDATE SET
       tool_name=excluded.tool_name,status='SUCCEEDED',dependencies=excluded.dependencies,
       input_summary=excluded.input_summary,output_summary=excluded.output_summary,completed_at=now()`;
  const values = [taskId, nodeKey, toolName, JSON.stringify(dependencies), JSON.stringify(input), JSON.stringify(output)];
  return client ? client.query(sql, values) : query(sql, values);
}

async function completeTask(taskId: string, status = "SUCCEEDED") {
  await query("UPDATE agent_tasks SET status=$2, updated_at=now() WHERE id=$1", [taskId, status]);
}

async function aiReply(
  customerId: string,
  taskId: string,
  understanding: AgentUnderstanding,
  message: string,
  state: "COMPLETED" | "AWAITING_INPUT" | "AWAITING_CONFIRMATION" | "AWAITING_MFA",
  facts: Record<string, unknown>,
  dependency: string,
) {
  const result = await composeGroundedReply({ userMessage: message, intent: understanding.intent, state, facts });
  await addNode(
    taskId,
    "compose_response",
    "ai.response.grounded",
    [dependency],
    { factKeys: Object.keys(facts), state },
    { model: result.meta.model, promptTokens: result.meta.promptTokens, completionTokens: result.meta.completionTokens },
  );
  await writeAudit({
    customerId,
    eventType: "AI_RESPONSE_GROUNDED",
    actorType: "AGENT",
    summary: "大模型仅基于已验证银行事实生成回复",
    taskId,
    evidence: { model: result.meta.model, factKeys: Object.keys(facts), state },
  });
  return result.value;
}

async function handleBalance(customerId: string, message: string, understanding: AgentUnderstanding, meta: ModelMeta): Promise<AgentReply> {
  const taskId = await createTask(customerId, message, understanding, "GREEN", meta);
  const accounts = await query<{ name: string; masked_no: string; available_balance_minor: string }>(
    `SELECT name, masked_no, available_balance_minor
     FROM accounts WHERE customer_id=$1 AND status='ACTIVE' ORDER BY created_at`,
    [customerId],
  );
  const total = accounts.rows.reduce((sum, account) => sum + Number(account.available_balance_minor), 0);
  await addNode(taskId, "resolve_customer", "identity.resolve", ["understand_intent"], {}, { customerId });
  await addNode(taskId, "read_accounts", "core.accounts.read", ["resolve_customer"], {}, { count: accounts.rowCount });
  await writeAudit({
    customerId,
    eventType: "QUERY_EXECUTED",
    actorType: "AGENT",
    summary: "Agent 在绿色权限下读取账户余额",
    taskId,
    evidence: { fields: ["available_balance_minor"], accountCount: accounts.rowCount },
  });
  const facts = {
    totalAvailableBalanceMinor: total,
    currency: "CNY",
    accounts: accounts.rows.map((account) => ({
      name: account.name,
      maskedNo: account.masked_no,
      availableBalanceMinor: Number(account.available_balance_minor),
    })),
  };
  const response = await aiReply(customerId, taskId, understanding, message, "COMPLETED", facts, "read_accounts");
  await completeTask(taskId);
  return { taskId, intent: understanding.intent, message: response.message, suggestions: response.suggestions, data: { totalMinor: total, accounts: accounts.rows }, ai: { model: meta.model, confidence: understanding.confidence } };
}

async function handleBillAnalysis(customerId: string, message: string, understanding: AgentUnderstanding, meta: ModelMeta): Promise<AgentReply> {
  const taskId = await createTask(customerId, message, understanding, "GREEN", meta);
  const requestedRange = `${understanding.entities.timeRange ?? ""} ${message}`;
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), 1);
  let end = now;
  let rangeLabel = "本月";
  if (requestedRange.includes("去年")) {
    start = new Date(now.getFullYear() - 1, 0, 1); end = new Date(now.getFullYear(), 0, 1); rangeLabel = "去年";
  } else if (requestedRange.includes("今年") || requestedRange.includes("年度") || requestedRange.includes("全年")) {
    start = new Date(now.getFullYear(), 0, 1); rangeLabel = "今年";
  } else if (requestedRange.includes("上月")) {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 1); rangeLabel = "上月";
  }
  const categories = await query<{ category: string; total_minor: string; count: string }>(
    `SELECT category, abs(sum(amount_minor))::text AS total_minor, count(*)::text AS count
     FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND bt.amount_minor < 0
       AND bt.occurred_at >= $2 AND bt.occurred_at < $3
     GROUP BY category ORDER BY abs(sum(amount_minor)) DESC`,
    [customerId, start, end],
  );
  const anomalies = await query<{ merchant_name: string; amount_minor: string; occurred_at: string }>(
    `SELECT merchant_name, amount_minor, occurred_at::text
     FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND is_anomaly=true AND bt.occurred_at >= $2 AND bt.occurred_at < $3
     ORDER BY occurred_at DESC LIMIT 5`,
    [customerId, start, end],
  );
  const total = categories.rows.reduce((sum, row) => sum + Number(row.total_minor), 0);
  await addNode(taskId, "load_transactions", "core.transactions.read", ["understand_intent"], { requestedRange: understanding.entities.timeRange }, { categoryCount: categories.rowCount });
  await addNode(taskId, "aggregate_categories", "analytics.category.aggregate", ["load_transactions"], {}, { categories: categories.rows.length });
  await addNode(taskId, "detect_anomalies", "risk.anomaly.read", ["load_transactions"], {}, { anomalies: anomalies.rows.length });
  const facts = {
    analyzedRange: rangeLabel,
    totalExpenseMinor: total,
    currency: "CNY",
    categories: categories.rows.map((row) => ({ category: row.category, totalMinor: Number(row.total_minor), transactionCount: Number(row.count) })),
    anomalies: anomalies.rows.map((row) => ({ merchantName: row.merchant_name, amountMinor: Number(row.amount_minor), occurredAt: row.occurred_at })),
  };
  const response = await aiReply(customerId, taskId, understanding, message, "COMPLETED", facts, "detect_anomalies");
  await writeAudit({ customerId, eventType: "BILL_ANALYSIS_COMPLETED", actorType: "AGENT", summary: "完成消费分类与异常交易分析", taskId, evidence: { categoryCount: categories.rows.length, anomalyCount: anomalies.rows.length } });
  await completeTask(taskId);
  return { taskId, intent: understanding.intent, message: response.message, suggestions: response.suggestions, data: { totalMinor: total, categories: categories.rows, anomalies: anomalies.rows }, ai: { model: meta.model, confidence: understanding.confidence } };
}

async function handleSubscriptions(customerId: string, message: string, understanding: AgentUnderstanding, meta: ModelMeta): Promise<AgentReply> {
  const taskId = await createTask(customerId, message, understanding, "GREEN", meta);
  const result = await query<{ id: string; merchant_name: string; amount_minor: string; billing_cycle: string; next_charge_at: string; status: string }>(
    `SELECT id, merchant_name, amount_minor, billing_cycle, next_charge_at::text, status
     FROM subscriptions WHERE customer_id=$1 AND status='ACTIVE' ORDER BY next_charge_at`,
    [customerId],
  );
  const monthly = result.rows.reduce((sum, item) => sum + (item.billing_cycle === "YEARLY" ? Number(item.amount_minor) / 12 : Number(item.amount_minor)), 0);
  await addNode(taskId, "identify_recurring", "subscriptions.read", ["understand_intent"], {}, { count: result.rows.length });
  await addNode(taskId, "calculate_monthly_cost", "analytics.normalize_cycle", ["identify_recurring"], {}, { monthlyMinor: monthly });
  const facts = {
    activeSubscriptionCount: result.rows.length,
    normalizedMonthlyCostMinor: Math.round(monthly),
    currency: "CNY",
    subscriptions: result.rows.map((item) => ({ merchantName: item.merchant_name, amountMinor: Number(item.amount_minor), billingCycle: item.billing_cycle, nextChargeAt: item.next_charge_at })),
    cancellationStatus: "NOT_REQUESTED",
  };
  const response = await aiReply(customerId, taskId, understanding, message, "COMPLETED", facts, "calculate_monthly_cost");
  await completeTask(taskId);
  return { taskId, intent: understanding.intent, message: response.message, suggestions: response.suggestions, data: { subscriptions: result.rows, monthlyMinor: Math.round(monthly) }, ai: { model: meta.model, confidence: understanding.confidence } };
}

async function handleCardLock(customerId: string, message: string, understanding: AgentUnderstanding, meta: ModelMeta): Promise<AgentReply> {
  const taskId = await createTask(customerId, message, understanding, "YELLOW", meta);
  const card = await query<{ id: string; card_name: string; masked_no: string; status: string }>(
    `SELECT id, card_name, masked_no, status FROM cards
     WHERE customer_id=$1 ORDER BY (status='ACTIVE') DESC,(card_type='DEBIT') DESC,card_name LIMIT 1`,
    [customerId],
  );
  const selected = card.rows[0];
  if (!selected) {
    const response = await aiReply(customerId, taskId, understanding, message, "AWAITING_INPUT", { matchedCard: null, reason: "NO_DEBIT_CARD_FOUND" }, "understand_intent");
    await completeTask(taskId, "NEEDS_INPUT");
    return { taskId, intent: understanding.intent, message: response.message, suggestions: response.suggestions, ai: { model: meta.model, confidence: understanding.confidence } };
  }
  const operationId = `CARD-${randomUUID().slice(0, 8).toUpperCase()}`;
  await addNode(taskId, "resolve_card", "cards.resolve", ["understand_intent"], { requestedCard: understanding.entities.accountName }, { cardId: selected.id, currentStatus: selected.status });
  await addNode(taskId, "policy_check", "policy.evaluate", ["resolve_card"], { action: "CARD_LOCK" }, { finalLevel: "YELLOW" });
  await query(
    `INSERT INTO policy_decisions (task_id,operation_id,base_level,final_level,matched_rules,evidence)
     VALUES ($1,$2,'YELLOW','YELLOW',$3::jsonb,$4::jsonb)`,
    [taskId, operationId, JSON.stringify(["CARD_STATUS_CHANGE_REQUIRES_CONFIRMATION"]), JSON.stringify({ cardId: selected.id })],
  );
  const facts = {
    operationState: "PREPARED_NOT_EXECUTED",
    cardName: selected.card_name,
    maskedNo: selected.masked_no,
    currentStatus: selected.status,
    action: "LOCK_CARD",
    effectsAfterConfirmation: ["暂停支付", "暂停取现", "暂停线上交易"],
    riskLevel: "YELLOW",
    requiredAuthorization: "EXPLICIT_CONFIRMATION",
  };
  const response = await aiReply(customerId, taskId, understanding, message, "AWAITING_CONFIRMATION", facts, "policy_check");
  await completeTask(taskId, "AWAITING_CONFIRMATION");
  return {
    taskId,
    intent: understanding.intent,
    message: response.message,
    suggestions: response.suggestions,
    ai: { model: meta.model, confidence: understanding.confidence },
    operation: {
      type: "CARD_LOCK",
      operationId,
      title: "锁定卡片",
      riskLevel: "YELLOW",
      requiredAuth: "CONFIRM",
      resourceId: selected.id,
      actionLabel: "确认锁卡",
      details: [
        { label: "卡片", value: `${selected.card_name} ${selected.masked_no}` },
        { label: "当前状态", value: selected.status === "ACTIVE" ? "正常" : selected.status },
        { label: "影响", value: "暂停支付、取现与线上交易" },
      ],
    },
  };
}

async function handleTransfer(customerId: string, message: string, understanding: AgentUnderstanding, meta: ModelMeta): Promise<AgentReply> {
  const taskId = await createTask(customerId, message, understanding, "YELLOW", meta);
  const amountMinor = understanding.entities.amountMinor;
  const recipient = understanding.entities.beneficiaryName;
  if (!amountMinor || !recipient) {
    const missing = [!amountMinor ? "amount" : null, !recipient ? "beneficiary" : null].filter(Boolean);
    await addNode(taskId, "collect_missing_fields", "dialogue.slot_fill", ["understand_intent"], { extractedEntities: understanding.entities }, { missing });
    const response = await aiReply(customerId, taskId, understanding, message, "AWAITING_INPUT", { missingFields: missing, modelClarification: understanding.clarification, operationExecuted: false }, "collect_missing_fields");
    await completeTask(taskId, "NEEDS_INPUT");
    return { taskId, intent: understanding.intent, message: response.message, suggestions: response.suggestions, ai: { model: meta.model, confidence: understanding.confidence } };
  }
  const source = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE customer_id=$1 AND status='ACTIVE'
     AND (($2::text IS NULL AND account_type='CHECKING') OR name=$2) ORDER BY created_at LIMIT 1`,
    [customerId, understanding.entities.accountName],
  );
  if (!source.rows[0]) {
    const response = await aiReply(customerId, taskId, understanding, message, "AWAITING_INPUT", { missingFields: ["validSourceAccount"], operationExecuted: false }, "understand_intent");
    await completeTask(taskId, "NEEDS_INPUT");
    return { taskId, intent: understanding.intent, message: response.message, suggestions: response.suggestions, ai: { model: meta.model, confidence: understanding.confidence } };
  }
  const prepared = await prepareTransfer(customerId, { fromAccountId: source.rows[0].id, recipient, amountMinor });
  await query("UPDATE policy_decisions SET task_id=$1 WHERE operation_id=$2", [taskId, prepared.operationId]);
  await addNode(taskId, "parse_transfer", "ai.entities.validated", ["understand_intent"], { extractedEntities: understanding.entities }, { amountMinor, recipient });
  await addNode(taskId, "resolve_beneficiary", "core.beneficiary.resolve", ["parse_transfer"], { recipient }, { resolved: true });
  await addNode(taskId, "check_balance", "core.balance.check", ["resolve_beneficiary"], { amountMinor }, { sufficient: true });
  await addNode(taskId, "policy_check", "policy.evaluate", ["check_balance"], { operationId: prepared.operationId }, { finalLevel: prepared.riskLevel, requiredAuth: prepared.requiredAuth });
  const facts = { operationState: "PREPARED_NOT_EXECUTED", ...prepared.details, riskLevel: prepared.riskLevel, requiredAuthorization: prepared.requiredAuth, operationExecuted: false };
  const response = await aiReply(customerId, taskId, understanding, message, prepared.requiredAuth === "MFA" ? "AWAITING_MFA" : "AWAITING_CONFIRMATION", facts, "policy_check");
  await completeTask(taskId, "AWAITING_AUTH");
  return {
    taskId,
    intent: understanding.intent,
    message: response.message,
    suggestions: response.suggestions,
    ai: { model: meta.model, confidence: understanding.confidence },
    operation: {
      type: "TRANSFER",
      operationId: prepared.operationId,
      title: "转账确认",
      riskLevel: prepared.riskLevel,
      requiredAuth: prepared.requiredAuth,
      actionLabel: prepared.requiredAuth === "MFA" ? "复核密码并转账" : "确认转账",
      details: [
        { label: "金额", value: formatMinor(amountMinor) },
        { label: "收款人", value: `${prepared.details.recipient.name} ${prepared.details.recipient.phoneMasked}` },
        { label: "付款账户", value: `${prepared.details.sourceAccount.name} ${prepared.details.sourceAccount.maskedNo}` },
        { label: "安全级别", value: prepared.riskLevel === "RED" ? "红色 · 强验证" : "黄色 · 明确确认" },
      ],
    },
  };
}

async function handleUnknown(customerId: string, message: string, understanding: AgentUnderstanding, meta: ModelMeta): Promise<AgentReply> {
  const taskId = await createTask(customerId, message, understanding, "GREEN", meta);
  await addNode(taskId, "clarify_intent", "ai.dialogue.clarify", ["understand_intent"], { confidence: understanding.confidence }, { clarificationRequired: true });
  const response = await aiReply(customerId, taskId, understanding, message, "AWAITING_INPUT", { modelClarification: understanding.clarification, allowedCapabilities: ["余额查询", "账单分析", "转账", "订阅识别", "卡片锁定"], operationExecuted: false }, "clarify_intent");
  await completeTask(taskId, "NEEDS_INPUT");
  return { taskId, intent: "UNKNOWN", message: response.message, suggestions: response.suggestions, ai: { model: meta.model, confidence: understanding.confidence } };
}

export async function runAgent(customerId: string, message: string, history: ConversationMessage[] = []): Promise<AgentReply> {
  const normalized = message.trim().slice(0, 500);
  const planned = await understandWithAI(normalized, history);
  const understanding = planned.value.confidence < 0.55
    ? { ...planned.value, intent: "UNKNOWN" as const, steps: ["clarify_intent" as const] }
    : planned.value;
  switch (understanding.intent) {
    case "BALANCE": return handleBalance(customerId, normalized, understanding, planned.meta);
    case "BILL_ANALYSIS": return handleBillAnalysis(customerId, normalized, understanding, planned.meta);
    case "SUBSCRIPTIONS": return handleSubscriptions(customerId, normalized, understanding, planned.meta);
    case "CARD_LOCK": return handleCardLock(customerId, normalized, understanding, planned.meta);
    case "TRANSFER": return handleTransfer(customerId, normalized, understanding, planned.meta);
    case "UNKNOWN": return handleUnknown(customerId, normalized, understanding, planned.meta);
  }
}
