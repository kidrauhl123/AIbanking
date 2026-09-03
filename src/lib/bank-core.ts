import { createHash, randomInt, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { evaluateTransferRisk } from "./policy";
import { verifyCustomerTotp } from "./auth";
import { writeAudit } from "./audit";

export async function getBankingOverview(customerId: string) {
  const [customer, accounts, transactions, cards, subscriptions] = await Promise.all([
    query<{ id: string; display_name: string; phone: string; risk_profile: string; mfa_configured: boolean }>(
      `SELECT c.id,c.display_name,c.phone,c.risk_profile,(m.enabled_at IS NOT NULL) AS mfa_configured
       FROM customers c LEFT JOIN mfa_totp m ON m.customer_id=c.id WHERE c.id=$1 AND c.status='ACTIVE'`,
      [customerId],
    ),
    query(
      `SELECT id,name,account_type,account_no,masked_no,currency,available_balance_minor,status
       FROM accounts WHERE customer_id=$1 ORDER BY created_at`,
      [customerId],
    ),
    query(
      `SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.currency,bt.occurred_at,bt.is_anomaly,bt.metadata
       FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1 ORDER BY occurred_at DESC LIMIT 50`,
      [customerId],
    ),
    query(
      `SELECT id,card_name,masked_no,card_type,status,online_enabled,overseas_enabled,
              contactless_enabled,daily_limit_minor FROM cards WHERE customer_id=$1 ORDER BY card_name`,
      [customerId],
    ),
    query(
      `SELECT id,merchant_name,amount_minor,billing_cycle,next_charge_at,status
       FROM subscriptions WHERE customer_id=$1 ORDER BY next_charge_at`,
      [customerId],
    ),
  ]);
  if (!customer.rows[0]) throw new Error("CUSTOMER_UNAVAILABLE");
  const totalMinor = accounts.rows.reduce((sum, row) => sum + Number(row.available_balance_minor), 0);
  return { customer: customer.rows[0], totalMinor, accounts: accounts.rows, transactions: transactions.rows, cards: cards.rows, subscriptions: subscriptions.rows };
}

async function ensureClearingAccount(client: PoolClient) {
  await client.query(
    `INSERT INTO accounts (customer_id,name,account_type,masked_no,currency,available_balance_minor,status,system_code)
     VALUES (NULL,'现金与外部清算','SETTLEMENT','INTERNAL','CNY',0,'ACTIVE','CASH_CLEARING')
     ON CONFLICT (system_code) WHERE system_code IS NOT NULL DO NOTHING`,
  );
  const result = await client.query<{ id: string }>("SELECT id FROM accounts WHERE system_code='CASH_CLEARING' FOR UPDATE");
  return result.rows[0].id;
}

export async function recordDeposit(customerId: string, input: { accountId: string; amountMinor: number; source: "CASH" | "EXTERNAL_TRANSFER"; reference?: string | null }) {
  return withTransaction(async (client) => {
    const account = await client.query<{ id: string; name: string }>(
      `SELECT id,name FROM accounts WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR UPDATE`,
      [input.accountId, customerId],
    );
    if (!account.rows[0]) throw new Error("ACCOUNT_NOT_FOUND");
    const clearingId = await ensureClearingAccount(client);
    const operationId = `DEP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const ledger = await client.query<{ id: string; reference: string; posted_at: string }>(
      `INSERT INTO ledger_transactions (reference,transaction_type,description)
       VALUES ($1,'DEPOSIT',$2) RETURNING id,reference,posted_at::text`,
      [`LED-${operationId}`, input.source === "CASH" ? "现金存入" : "外部账户转入"],
    );
    await client.query(
      `INSERT INTO ledger_entries (ledger_transaction_id,account_id,amount_minor,direction)
       VALUES ($1,$2,$3,'CREDIT'),($1,$4,$5,'DEBIT')`,
      [ledger.rows[0].id, input.accountId, input.amountMinor, clearingId, -input.amountMinor],
    );
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [input.accountId, input.amountMinor]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [clearingId, input.amountMinor]);
    await client.query(
      `INSERT INTO bank_transactions (account_id,merchant_name,category,amount_minor,occurred_at,metadata)
       VALUES ($1,$2,'入金',$3,now(),$4::jsonb)`,
      [input.accountId, input.source === "CASH" ? "现金存入" : "外部账户转入", input.amountMinor, JSON.stringify({ operationId, reference: input.reference ?? null, source: input.source })],
    );
    await client.query(
      `INSERT INTO cash_deposits (operation_id,customer_id,account_id,amount_minor,source,reference,ledger_transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [operationId, customerId, input.accountId, input.amountMinor, input.source, input.reference ?? null, ledger.rows[0].id],
    );
    await writeAudit({ customerId, eventType: "DEPOSIT_POSTED", actorType: "BANK_CORE", summary: "客户发起的入金已记入双分录账本", operationId, evidence: { accountId: input.accountId, amountMinor: input.amountMinor, source: input.source, ledgerReference: ledger.rows[0].reference } }, client);
    return { operationId, status: "SUCCEEDED", amountMinor: input.amountMinor, receipt: ledger.rows[0] };
  });
}

type Recipient = { customer_id: string; display_name: string; phone: string; account_id: string; masked_no: string };

async function resolveRecipient(customerId: string, recipient: string) {
  const isPhone = /^\+?\d{8,15}$/.test(recipient);
  const result = await query<Recipient>(
    `SELECT c.id AS customer_id,c.display_name,c.phone,a.id AS account_id,a.masked_no
     FROM customers c JOIN accounts a ON a.customer_id=c.id AND a.account_type='CHECKING' AND a.status='ACTIVE'
     WHERE c.status='ACTIVE' AND c.id<>$1 AND ${isPhone ? "c.phone=$2" : "c.display_name=$2"}
     ORDER BY a.created_at LIMIT 2`,
    [customerId, recipient],
  );
  if (!result.rowCount) throw new Error("RECIPIENT_NOT_FOUND");
  if (!isPhone && (result.rowCount ?? 0) > 1) throw new Error("RECIPIENT_AMBIGUOUS");
  return result.rows[0];
}

export async function prepareTransfer(customerId: string, input: { fromAccountId: string; recipient: string; amountMinor: number; note?: string | null }) {
  const [sourceResult, recipient] = await Promise.all([
    query<{ id: string; name: string; masked_no: string; available_balance_minor: string }>(
      `SELECT id,name,masked_no,available_balance_minor FROM accounts
       WHERE id=$1 AND customer_id=$2 AND status='ACTIVE'`,
      [input.fromAccountId, customerId],
    ),
    resolveRecipient(customerId, input.recipient),
  ]);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("ACCOUNT_NOT_FOUND");
  if (Number(source.available_balance_minor) < input.amountMinor) throw new Error("INSUFFICIENT_FUNDS");
  const daily = await query<{ total: string }>(
    `SELECT coalesce(sum(amount_minor),0)::text AS total FROM transfers
     WHERE customer_id=$1 AND status='SUCCEEDED' AND executed_at>=date_trunc('day',now())`,
    [customerId],
  );
  const known = await query("SELECT trusted FROM beneficiaries WHERE customer_id=$1 AND settlement_account_id=$2", [customerId, recipient.account_id]);
  const risk = evaluateTransferRisk({ amountMinor: input.amountMinor, dailyTotalMinor: Number(daily.rows[0].total), trustedBeneficiary: Boolean(known.rows[0]?.trusted), trustedDevice: true });
  const operationId = `TRF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const fingerprint = createHash("sha256").update(JSON.stringify({ operationId, customerId, source: source.id, target: recipient.account_id, amountMinor: input.amountMinor, currency: "CNY" })).digest("hex");

  return withTransaction(async (client) => {
    const beneficiary = await client.query<{ id: string }>(
      `INSERT INTO beneficiaries (customer_id,name,phone,bank_name,masked_account,settlement_account_id,recipient_customer_id,trusted)
       VALUES ($1,$2,$3,'BankPilot',$4,$5,$6,false)
       ON CONFLICT (customer_id,settlement_account_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,recipient_customer_id=excluded.recipient_customer_id
       RETURNING id`,
      [customerId, recipient.display_name, recipient.phone, recipient.masked_no, recipient.account_id, recipient.customer_id],
    );
    await client.query(
      `INSERT INTO transfers
       (operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,currency,note,risk_level,required_auth,status,authorization_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,'CNY',$7,$8,$9,'AWAITING_AUTH',$10)`,
      [operationId, randomUUID(), customerId, source.id, beneficiary.rows[0].id, input.amountMinor, input.note ?? null, risk.finalLevel, risk.requiredAuth, fingerprint],
    );
    await client.query(
      `INSERT INTO policy_decisions (operation_id,base_level,final_level,matched_rules,evidence)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [operationId, risk.baseLevel, risk.finalLevel, JSON.stringify(risk.matchedRules), JSON.stringify({ amountMinor: input.amountMinor, dailyTotalMinor: Number(daily.rows[0].total), knownBeneficiary: Boolean(known.rowCount) })],
    );
    if (risk.requiredAuth === "MFA") {
      await client.query(
        `INSERT INTO authorization_challenges (customer_id,operation_id,method,code_hash,expires_at)
         VALUES ($1,$2,'TOTP',NULL,now()+interval '10 minutes')`,
        [customerId, operationId],
      );
    }
    await writeAudit({ customerId, eventType: "TRANSFER_PREPARED", actorType: "USER", summary: "客户创建转账草稿，资金尚未转出", operationId, evidence: { fromAccountId: source.id, recipientCustomerId: recipient.customer_id, amountMinor: input.amountMinor, riskLevel: risk.finalLevel, fingerprint } }, client);
    return {
      operationId,
      status: "AWAITING_AUTH" as const,
      riskLevel: risk.finalLevel,
      requiredAuth: risk.requiredAuth,
      authorizationExpiresAt: risk.requiredAuth === "MFA" ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
      details: {
        amountMinor: input.amountMinor,
        currency: "CNY",
        sourceAccount: { id: source.id, name: source.name, maskedNo: source.masked_no },
        recipient: { name: recipient.display_name, phoneMasked: `${recipient.phone.slice(0, 3)}****${recipient.phone.slice(-4)}`, maskedAccount: recipient.masked_no },
        note: input.note ?? null,
      },
    };
  });
}

type TransferRow = {
  id: string; operation_id: string; customer_id: string; from_account_id: string; beneficiary_id: string;
  amount_minor: string; currency: string; risk_level: "YELLOW" | "RED"; required_auth: "CONFIRM" | "MFA";
  status: string; authorization_fingerprint: string; beneficiary_name: string; recipient_customer_id: string;
  target_account_id: string;
};

export async function commitTransfer(customerId: string, operationId: string, input: { totpCode?: string | null; taskId?: string | null }) {
  return withTransaction(async (client) => {
    const result = await client.query<TransferRow>(
      `SELECT t.*,b.name AS beneficiary_name,b.recipient_customer_id,b.settlement_account_id AS target_account_id
       FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id
       WHERE t.operation_id=$1 AND t.customer_id=$2 FOR UPDATE OF t`,
      [operationId, customerId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("OPERATION_NOT_FOUND");
    if (row.status === "SUCCEEDED") {
      const receipt = await client.query("SELECT id,reference,posted_at FROM ledger_transactions WHERE transfer_id=$1", [row.id]);
      return { alreadyExecuted: true, operationId, status: "SUCCEEDED", receipt: receipt.rows[0] };
    }
    if (row.status !== "AWAITING_AUTH") throw new Error("OPERATION_NOT_EXECUTABLE");
    if (row.required_auth === "MFA") {
      const challenge = await client.query<{ id: string; attempts: number; expires_at: Date; status: string }>(
        `SELECT id,attempts,expires_at,status FROM authorization_challenges
         WHERE operation_id=$1 ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
        [operationId],
      );
      const auth = challenge.rows[0];
      if (!auth || auth.expires_at < new Date() || auth.status !== "PENDING") throw new Error("AUTH_EXPIRED");
      if (auth.attempts >= 3) throw new Error("AUTH_FUSE_ACTIVE");
      if (!input.totpCode || !(await verifyCustomerTotp(customerId, input.totpCode))) {
        const attempts = auth.attempts + 1;
        await client.query("UPDATE authorization_challenges SET attempts=$2,status=CASE WHEN $2>=3 THEN 'LOCKED' ELSE status END WHERE id=$1", [auth.id, attempts]);
        await writeAudit({ customerId, eventType: "MFA_REJECTED", actorType: "RISK_ENGINE", summary: "高风险交易 TOTP 验证失败", operationId, evidence: { attempts, fuseActive: attempts >= 3 } }, client);
        return { authError: attempts >= 3 ? "AUTH_FUSE_ACTIVE" : "AUTH_INVALID" } as const;
      }
      await client.query("UPDATE authorization_challenges SET status='VERIFIED',verified_at=now() WHERE id=$1", [auth.id]);
    }
    const accounts = await client.query<{ id: string; customer_id: string; available_balance_minor: string; status: string }>(
      `SELECT id,customer_id,available_balance_minor,status FROM accounts
       WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[row.from_account_id, row.target_account_id]],
    );
    const source = accounts.rows.find((item) => item.id === row.from_account_id);
    const target = accounts.rows.find((item) => item.id === row.target_account_id);
    if (!source || source.customer_id !== customerId || source.status !== "ACTIVE" || !target || target.status !== "ACTIVE") throw new Error("ACCOUNT_NOT_FOUND");
    if (Number(source.available_balance_minor) < Number(row.amount_minor)) throw new Error("INSUFFICIENT_FUNDS");
    await client.query("UPDATE transfers SET status='EXECUTING',confirmed_at=now(),version=version+1 WHERE id=$1", [row.id]);
    const ledger = await client.query<{ id: string; reference: string; posted_at: string }>(
      `INSERT INTO ledger_transactions (reference,transfer_id,transaction_type,description)
       VALUES ($1,$2,'TRANSFER',$3) RETURNING id,reference,posted_at::text`,
      [`LED-${operationId}`, row.id, `转账给${row.beneficiary_name}`],
    );
    await client.query(
      `INSERT INTO ledger_entries (ledger_transaction_id,account_id,amount_minor,direction)
       VALUES ($1,$2,$3,'DEBIT'),($1,$4,$5,'CREDIT')`,
      [ledger.rows[0].id, row.from_account_id, -Number(row.amount_minor), row.target_account_id, Number(row.amount_minor)],
    );
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [row.from_account_id, row.amount_minor]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [row.target_account_id, row.amount_minor]);
    await client.query(
      `INSERT INTO bank_transactions (account_id,merchant_name,category,amount_minor,occurred_at,metadata)
       VALUES ($1,$2,'转账',$3,now(),$4::jsonb),($5,$6,'转账',$7,now(),$4::jsonb)`,
      [row.from_account_id, `转账给${row.beneficiary_name}`, -Number(row.amount_minor), JSON.stringify({ operationId, ledgerReference: ledger.rows[0].reference }), row.target_account_id, "来自 BankPilot 用户的转账", Number(row.amount_minor)],
    );
    await client.query("UPDATE transfers SET status='SUCCEEDED',executed_at=now(),version=version+1 WHERE id=$1", [row.id]);
    if (input.taskId) await client.query("UPDATE agent_tasks SET status='SUCCEEDED',updated_at=now() WHERE id=$1 AND customer_id=$2", [input.taskId, customerId]);
    await writeAudit({ customerId, eventType: "TRANSFER_SUCCEEDED", actorType: "BANK_CORE", summary: "核心账本完成客户间双分录转账", operationId, evidence: { ledgerReference: ledger.rows[0].reference, authorizationFingerprint: row.authorization_fingerprint, balancedEntries: true } }, client);
    if (row.recipient_customer_id) {
      await writeAudit({ customerId: row.recipient_customer_id, eventType: "TRANSFER_RECEIVED", actorType: "BANK_CORE", summary: "收到 BankPilot 客户转账", operationId, evidence: { ledgerReference: ledger.rows[0].reference, amountMinor: Number(row.amount_minor) } }, client);
    }
    return { operationId, status: "SUCCEEDED", receipt: ledger.rows[0], amountMinor: Number(row.amount_minor), beneficiary: row.beneficiary_name };
  });
}

export async function getOperation(customerId: string, operationId: string) {
  const transfer = await query<{
    operation_id: string; amount_minor: string; currency: string; risk_level: "YELLOW" | "RED"; required_auth: "CONFIRM" | "MFA";
    status: string; prepared_at: string; executed_at: string | null; beneficiary_name: string; beneficiary_phone: string;
    masked_account: string; source_name: string; source_masked_no: string; note: string | null;
  }>(
    `SELECT t.operation_id,t.amount_minor,t.currency,t.risk_level,t.required_auth,t.status,t.prepared_at::text,t.executed_at::text,t.note,
            b.name AS beneficiary_name,b.phone AS beneficiary_phone,b.masked_account,a.name AS source_name,a.masked_no AS source_masked_no
     FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id JOIN accounts a ON a.id=t.from_account_id
     WHERE t.customer_id=$1 AND t.operation_id=$2`,
    [customerId, operationId],
  );
  if (!transfer.rows[0]) throw new Error("OPERATION_NOT_FOUND");
  const row = transfer.rows[0];
  return {
    operationId: row.operation_id, status: row.status, riskLevel: row.risk_level, requiredAuth: row.required_auth,
    preparedAt: row.prepared_at, executedAt: row.executed_at,
    details: {
      amountMinor: Number(row.amount_minor), currency: row.currency,
      sourceAccount: { name: row.source_name, maskedNo: row.source_masked_no },
      recipient: { name: row.beneficiary_name, phoneMasked: row.beneficiary_phone ? `${row.beneficiary_phone.slice(0, 3)}****${row.beneficiary_phone.slice(-4)}` : "—", maskedAccount: row.masked_account },
      note: row.note,
    },
  };
}

export async function issueVirtualCard(customerId: string, accountId: string, cardName: string) {
  return withTransaction(async (client) => {
    const account = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR UPDATE",
      [accountId, customerId],
    );
    if (!account.rows[0]) throw new Error("ACCOUNT_NOT_FOUND");
    const suffix = String(randomInt(0, 10_000)).padStart(4, "0");
    const card = await client.query(
      `INSERT INTO cards (customer_id,account_id,card_name,masked_no,card_type,status,daily_limit_minor)
       VALUES ($1,$2,$3,$4,'VIRTUAL','ACTIVE',100000) RETURNING id,card_name,masked_no,card_type,status,daily_limit_minor`,
      [customerId, accountId, cardName, `•••• ${suffix}`],
    );
    await writeAudit({
      customerId,
      eventType: "VIRTUAL_CARD_ISSUED",
      actorType: "BANK_CORE",
      summary: "客户确认后开立虚拟卡",
      evidence: { cardId: card.rows[0].id, accountId, storedCardData: "MASKED_ONLY", riskLevel: "YELLOW" },
    }, client);
    return card.rows[0];
  });
}

export async function lockCard(customerId: string, cardId: string) {
  const result = await query(
    `UPDATE cards SET status='LOCKED' WHERE id=$1 AND customer_id=$2 AND status='ACTIVE'
     RETURNING id,card_name,masked_no,status`,
    [cardId, customerId],
  );
  if (!result.rows[0]) throw new Error("CARD_NOT_FOUND");
  await writeAudit({ customerId, eventType: "CARD_LOCKED", actorType: "USER", summary: "客户明确确认后锁定卡片", evidence: { cardId, riskLevel: "YELLOW" } });
  return result.rows[0];
}
