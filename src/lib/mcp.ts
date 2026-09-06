import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { AuthPrincipal, ApiScope } from "./auth";
import { getBankingOverview, getOperation, prepareTransfer } from "./bank-core";
import { query } from "./db";

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

async function recordInvocation(principal: AuthPrincipal, toolName: string, input: Record<string, unknown>, outcome: string, operationId?: string) {
  await query(
    `INSERT INTO mcp_invocations (customer_id,client_id,tool_name,input_summary,outcome,operation_id)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [principal.customerId, principal.clientId ?? null, toolName, JSON.stringify(input), outcome, operationId ?? null],
  );
}

function can(principal: AuthPrincipal, scope: ApiScope) {
  return principal.scopes.has("*") || principal.scopes.has(scope);
}

export function createBankingMcpServer(principal: AuthPrincipal, origin: string) {
  const server = new McpServer({ name: "AIbanking", version: "0.2.0" });

  if (can(principal, "accounts:read")) server.registerTool(
    "banking.accounts.list",
    {
      title: "读取我的银行账户",
      description: "返回当前已授权客户的账户、币种、状态和可用余额。只读。",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const overview = await getBankingOverview(principal.customerId);
      const output = { accounts: overview.accounts, totalMinor: overview.totalMinor, currency: "CNY" };
      await recordInvocation(principal, "banking.accounts.list", {}, "SUCCEEDED");
      return result(output);
    },
  );

  if (can(principal, "transactions:read")) server.registerTool(
    "banking.transactions.list",
    {
      title: "读取我的交易流水",
      description: "返回当前已授权客户最近的真实账本流水。只读。",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const rows = await query(
        `SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.currency,bt.occurred_at,bt.metadata
         FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
         WHERE a.customer_id=$1 ORDER BY bt.occurred_at DESC LIMIT $2`,
        [principal.customerId, limit],
      );
      const output = { transactions: rows.rows };
      await recordInvocation(principal, "banking.transactions.list", { limit }, "SUCCEEDED");
      return result(output);
    },
  );

  if (can(principal, "beneficiaries:read")) server.registerTool(
    "banking.beneficiaries.list",
    {
      title: "读取我的收款人",
      description: "返回当前用户曾经核验过的 BankPilot 收款人及脱敏账户信息。只读。",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await query(
        `SELECT id,name,phone,bank_name,masked_account,trusted,created_at
         FROM beneficiaries WHERE customer_id=$1 ORDER BY created_at DESC`,
        [principal.customerId],
      );
      await recordInvocation(principal, "banking.beneficiaries.list", {}, "SUCCEEDED");
      return result({ beneficiaries: rows.rows });
    },
  );

  if (can(principal, "cards:read")) server.registerTool(
    "banking.cards.list",
    {
      title: "读取我的卡片",
      description: "返回客户名下卡片及交易开关状态。只读。",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await query(
        `SELECT id,card_name,masked_no,card_type,status,online_enabled,overseas_enabled,contactless_enabled,daily_limit_minor
         FROM cards WHERE customer_id=$1 ORDER BY card_name`,
        [principal.customerId],
      );
      await recordInvocation(principal, "banking.cards.list", {}, "SUCCEEDED");
      return result({ cards: rows.rows });
    },
  );

  if (can(principal, "subscriptions:read")) server.registerTool(
    "banking.subscriptions.list",
    {
      title: "读取订阅和代扣",
      description: "返回客户已产生的订阅和代扣记录。只读。",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await query("SELECT id,merchant_name,amount_minor,billing_cycle,next_charge_at,status FROM subscriptions WHERE customer_id=$1 ORDER BY next_charge_at", [principal.customerId]);
      await recordInvocation(principal, "banking.subscriptions.list", {}, "SUCCEEDED");
      return result({ subscriptions: rows.rows });
    },
  );

  if (can(principal, "products:read")) server.registerTool(
    "banking.investments.products.list",
    {
      title: "读取已验证理财产品",
      description: "只返回带原始来源、核验时间且当前开放的真实产品；没有合格数据时返回空数组。",
      inputSchema: { riskLevel: z.enum(["R1", "R2", "R3", "R4", "R5"]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ riskLevel }) => {
      const rows = await query(
        `SELECT external_code,name,issuer,product_type,currency,risk_level,minimum_purchase_minor,term_days,status,
                source_url,source_published_at,source_checked_at,facts
         FROM investment_products WHERE status='OPEN' AND ($1::text IS NULL OR risk_level=$1)
         ORDER BY name LIMIT 50`,
        [riskLevel ?? null],
      );
      await recordInvocation(principal, "banking.investments.products.list", { riskLevel: riskLevel ?? null }, "SUCCEEDED");
      return result({ products: rows.rows, generatedAt: new Date().toISOString() });
    },
  );

  if (can(principal, "transfers:prepare")) server.registerTool(
    "banking.transfers.prepare",
    {
      title: "创建转账草稿",
      description: "创建待授权转账，不会直接扣款。收款人可使用完整手机号或准确姓名；最终执行必须回到银行页面确认。",
      inputSchema: {
        fromAccountId: z.string().uuid(),
        recipient: z.string().trim().min(2).max(50),
        amountMinor: z.number().int().positive().max(100_000_000),
        note: z.string().trim().max(80).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const prepared = await prepareTransfer(principal.customerId, input);
        const output = { ...prepared, authorizationUrl: `${origin}/?authorize=${encodeURIComponent(prepared.operationId)}`, executionAllowed: false };
        await recordInvocation(principal, "banking.transfers.prepare", { fromAccountId: input.fromAccountId, amountMinor: input.amountMinor }, "AWAITING_USER_AUTHORIZATION", prepared.operationId);
        return result(output);
      } catch (error) {
        await recordInvocation(principal, "banking.transfers.prepare", { fromAccountId: input.fromAccountId, amountMinor: input.amountMinor }, "FAILED");
        throw error;
      }
    },
  );

  if (can(principal, "operations:read")) server.registerTool(
    "banking.operations.get",
    {
      title: "查询银行操作状态",
      description: "按操作编号查询当前客户的操作状态。只读。",
      inputSchema: { operationId: z.string().trim().min(8).max(80) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operationId }) => {
      const operation = await getOperation(principal.customerId, operationId);
      await recordInvocation(principal, "banking.operations.get", { operationId }, "SUCCEEDED", operationId);
      return result({ operation });
    },
  );

  return server;
}

export async function handleMcpRequest(request: Request, principal: AuthPrincipal) {
  const server = createBankingMcpServer(principal, process.env.BANKPILOT_PUBLIC_URL || new URL(request.url).origin);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
