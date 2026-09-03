import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { DEMO_CUSTOMER_ID } from "@/lib/constants";
import { withTransaction } from "@/lib/db";

const schema = z.object({
  confirmed: z.literal(true),
  code: z.string().trim().optional(),
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  type: z.enum(["TRANSFER", "CARD_LOCK", "SUBSCRIPTION_CANCEL"]),
});

type TransferRow = {
  id: string;
  operation_id: string;
  customer_id: string;
  from_account_id: string;
  beneficiary_id: string;
  amount_minor: string;
  currency: string;
  risk_level: "YELLOW" | "RED";
  required_auth: "CONFIRM" | "MFA";
  status: string;
  authorization_fingerprint: string;
  beneficiary_name: string;
  settlement_account_id: string;
};

async function commitTransfer(operationId: string, input: z.infer<typeof schema>) {
  return withTransaction(async (client) => {
    const transfer = await client.query<TransferRow>(
      `SELECT t.*,b.name AS beneficiary_name,b.settlement_account_id
       FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id
       WHERE t.operation_id=$1 AND t.customer_id=$2 FOR UPDATE OF t`,
      [operationId, DEMO_CUSTOMER_ID],
    );
    if (!transfer.rowCount) throw new Error("OPERATION_NOT_FOUND");
    const row = transfer.rows[0];
    if (row.status === "SUCCEEDED") {
      const receipt = await client.query(`SELECT id,reference,posted_at FROM ledger_transactions WHERE transfer_id=$1`, [row.id]);
      return { alreadyExecuted: true, operationId, status: "SUCCEEDED", receipt: receipt.rows[0] };
    }
    if (row.status !== "AWAITING_AUTH") throw new Error("OPERATION_NOT_EXECUTABLE");

    if (row.required_auth === "MFA") {
      const challenge = await client.query<{ id: string; code_hash: string; attempts: number; expires_at: Date; status: string }>(
        `SELECT id,code_hash,attempts,expires_at,status FROM authorization_challenges
         WHERE operation_id=$1 ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
        [operationId],
      );
      const auth = challenge.rows[0];
      if (!auth || auth.expires_at < new Date()) throw new Error("AUTH_EXPIRED");
      if (auth.status === "LOCKED" || auth.attempts >= 3) throw new Error("AUTH_FUSE_ACTIVE");
      if (auth.status !== "PENDING") throw new Error("AUTH_EXPIRED");
      const provided = createHash("sha256").update(input.code ?? "").digest();
      const expected = Buffer.from(auth.code_hash, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        const attempts = auth.attempts + 1;
        await client.query(`UPDATE authorization_challenges SET attempts=$2,status=CASE WHEN $2>=3 THEN 'LOCKED' ELSE status END WHERE id=$1`, [auth.id, attempts]);
        await writeAudit({ eventType: "MFA_REJECTED", actorType: "RISK_ENGINE", summary: "短信验证码校验失败", taskId: input.taskId, operationId, evidence: { attempts, fuseActive: attempts >= 3 } }, client);
        return { authError: attempts >= 3 ? "AUTH_FUSE_ACTIVE" : "AUTH_INVALID" };
      }
      await client.query(`UPDATE authorization_challenges SET status='VERIFIED',verified_at=now() WHERE id=$1`, [auth.id]);
    }

    const accounts = await client.query<{ id: string; available_balance_minor: string; status: string }>(
      `SELECT id,available_balance_minor,status FROM accounts
       WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[row.from_account_id, row.settlement_account_id]],
    );
    const source = accounts.rows.find((account) => account.id === row.from_account_id);
    if (!source || source.status !== "ACTIVE") throw new Error("SOURCE_ACCOUNT_UNAVAILABLE");
    if (Number(source.available_balance_minor) < Number(row.amount_minor)) throw new Error("INSUFFICIENT_FUNDS");

    await client.query(`UPDATE transfers SET status='EXECUTING',confirmed_at=now(),version=version+1 WHERE id=$1`, [row.id]);
    if (input.taskId) {
      await client.query(
        `INSERT INTO task_nodes (task_id,node_key,tool_name,status,dependencies,input_summary,output_summary,started_at,completed_at)
         VALUES ($1,'await_authorization','authorization.verify','SUCCEEDED','["policy_check"]'::jsonb,$2::jsonb,$3::jsonb,now(),now())
         ON CONFLICT (task_id,node_key) DO UPDATE SET status='SUCCEEDED',output_summary=excluded.output_summary,completed_at=now()`,
        [input.taskId, JSON.stringify({ method: row.required_auth }), JSON.stringify({ verified: true, fingerprint: row.authorization_fingerprint })],
      );
    }
    const ledger = await client.query<{ id: string; reference: string; posted_at: string }>(
      `INSERT INTO ledger_transactions (reference,transfer_id,transaction_type,description)
       VALUES ($1,$2,'TRANSFER',$3) RETURNING id,reference,posted_at::text`,
      [`LED-${operationId}`, row.id, `转账给${row.beneficiary_name}`],
    );
    await client.query(
      `INSERT INTO ledger_entries (ledger_transaction_id,account_id,amount_minor,direction)
       VALUES ($1,$2,$3,'DEBIT'),($1,$4,$5,'CREDIT')`,
      [ledger.rows[0].id, row.from_account_id, -Number(row.amount_minor), row.settlement_account_id, Number(row.amount_minor)],
    );
    await client.query(`UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1`, [row.from_account_id, row.amount_minor]);
    await client.query(`UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1`, [row.settlement_account_id, row.amount_minor]);
    await client.query(
      `INSERT INTO bank_transactions (account_id,merchant_name,category,amount_minor,occurred_at,metadata)
       VALUES ($1,$2,'转账',$3,now(),$4::jsonb)`,
      [row.from_account_id, `转账给${row.beneficiary_name}`, -Number(row.amount_minor), JSON.stringify({ operationId, ledgerReference: ledger.rows[0].reference })],
    );
    await client.query(`UPDATE transfers SET status='SUCCEEDED',executed_at=now(),version=version+1 WHERE id=$1`, [row.id]);
    if (input.taskId) {
      await client.query(
        `INSERT INTO task_nodes (task_id,node_key,tool_name,status,dependencies,input_summary,output_summary,started_at,completed_at)
         VALUES ($1,'post_ledger','core.transfer.post','SUCCEEDED','["await_authorization"]'::jsonb,$2::jsonb,$3::jsonb,now(),now())
         ON CONFLICT (task_id,node_key) DO UPDATE SET status='SUCCEEDED',output_summary=excluded.output_summary,completed_at=now()`,
        [input.taskId, JSON.stringify({ authorizationFingerprint: row.authorization_fingerprint }), JSON.stringify({ ledgerReference: ledger.rows[0].reference })],
      );
      await client.query(`UPDATE agent_tasks SET status='SUCCEEDED',updated_at=now() WHERE id=$1`, [input.taskId]);
    }
    await writeAudit({ eventType: "TRANSFER_SUCCEEDED", actorType: "BANK_CORE", summary: "核心账本完成双分录转账", taskId: input.taskId, operationId, evidence: { ledgerReference: ledger.rows[0].reference, authorizationFingerprint: row.authorization_fingerprint, balancedEntries: true } }, client);
    return { operationId, status: "SUCCEEDED", receipt: ledger.rows[0], amountMinor: Number(row.amount_minor), beneficiary: row.beneficiary_name };
  });
}

async function commitCardLock(operationId: string, input: z.infer<typeof schema>) {
  if (!input.resourceId) throw new Error("RESOURCE_REQUIRED");
  return withTransaction(async (client) => {
    const decision = await client.query<{ evidence: { cardId?: string }; task_id: string }>(
      `SELECT evidence,task_id FROM policy_decisions
       WHERE operation_id=$1 AND final_level='YELLOW' FOR UPDATE`,
      [operationId],
    );
    if (!decision.rowCount || decision.rows[0].evidence.cardId !== input.resourceId || decision.rows[0].task_id !== input.taskId) throw new Error("AUTHORIZATION_MISMATCH");
    const card = await client.query<{ id: string; status: string; card_name: string; masked_no: string }>(
      `SELECT id,status,card_name,masked_no FROM cards WHERE id=$1 AND customer_id=$2 FOR UPDATE`,
      [input.resourceId, DEMO_CUSTOMER_ID],
    );
    if (!card.rowCount) throw new Error("OPERATION_NOT_FOUND");
    if (card.rows[0].status === "LOCKED") return { operationId, status: "SUCCEEDED", alreadyExecuted: true, card: `${card.rows[0].card_name} ${card.rows[0].masked_no}` };
    await client.query(`UPDATE cards SET status='LOCKED' WHERE id=$1`, [input.resourceId]);
    if (input.taskId) await client.query(`UPDATE agent_tasks SET status='SUCCEEDED',updated_at=now() WHERE id=$1`, [input.taskId]);
    await writeAudit({ eventType: "CARD_LOCKED", actorType: "BANK_CORE", summary: "用户确认后锁定卡片", taskId: input.taskId, operationId, evidence: { cardId: input.resourceId, previousStatus: card.rows[0].status } }, client);
    return { operationId, status: "SUCCEEDED", card: `${card.rows[0].card_name} ${card.rows[0].masked_no}` };
  });
}

export async function POST(request: Request, context: { params: Promise<{ operationId: string }> }) {
  try {
    const input = schema.parse(await request.json());
    const { operationId } = await context.params;
    const result = input.type === "TRANSFER" ? await commitTransfer(operationId, input) : input.type === "CARD_LOCK" ? await commitCardLock(operationId, input) : (() => { throw new Error("NOT_IMPLEMENTED"); })();
    if ("authError" in result) {
      return NextResponse.json({ error: result.authError, message: result.authError === "AUTH_FUSE_ACTIVE" ? "连续验证失败，操作已熔断" : "验证码不正确，资金未转出" }, { status: 401 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "EXECUTION_FAILED";
    const status = code === "OPERATION_NOT_FOUND" ? 404 : ["AUTH_INVALID", "AUTH_EXPIRED", "AUTH_FUSE_ACTIVE"].includes(code) ? 401 : 409;
    console.error(error);
    return NextResponse.json({ error: code, message: code === "AUTH_INVALID" ? "验证码不正确，资金未转出" : code === "AUTH_FUSE_ACTIVE" ? "连续验证失败，操作已熔断" : "操作未执行，请检查后重试" }, { status });
  }
}
