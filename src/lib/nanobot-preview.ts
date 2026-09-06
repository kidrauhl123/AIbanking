import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { API_SCOPES, AuthError } from "./auth";
import { query, withTransaction } from "./db";

export const NANOBOT_FAILURE = "Nanobot 本次运行未完成。可能已生成待确认草稿，但不会自动付款；请查看下方银行记录，不要重复发起相同转账。";

export function validServiceToken(value: string | null) {
  const expected = process.env.NANOBOT_SERVICE_TOKEN;
  if (!expected || expected.length < 32 || !value) return false;
  const a = Buffer.from(value), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function nanobotAvailable() {
  // Availability is deployment-wide. Account authentication remains in the API;
  // no enrollment list or client-provided customer identity is consulted.
  return Boolean(process.env.NANOBOT_SERVICE_URL && (process.env.NANOBOT_SERVICE_TOKEN?.length ?? 0) >= 32);
}

export function requireNanobot() {
  if (!nanobotAvailable()) throw new AuthError("NANOBOT_UNAVAILABLE", 503);
}

export async function expireRuns(customerId: string) {
  await withTransaction(async client => {
    const expired = await client.query<{ client_id: string }>("UPDATE nanobot_runs SET status='FAILED',reply=$2,finished_at=now() WHERE customer_id=$1 AND status='RUNNING' AND expires_at<=now() RETURNING client_id", [customerId, NANOBOT_FAILURE]);
    for (const row of expired.rows) await client.query("UPDATE api_tokens SET revoked_at=now() WHERE client_id=$1 AND revoked_at IS NULL", [row.client_id]);
  });
}

export async function connectPreview(customerId: string) {
  await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [customerId]);
    await client.query("UPDATE nanobot_consents SET revoked_at=now() WHERE customer_id=$1 AND expires_at<=now() AND revoked_at IS NULL", [customerId]);
    const inserted = await client.query("INSERT INTO nanobot_consents(customer_id) VALUES($1) ON CONFLICT (customer_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id", [customerId]);
    if (inserted.rowCount) await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary) VALUES($1,'NANOBOT_CONNECTED','USER','授权 Nanobot 查询银行数据及创建待确认转账；不授权付款')", [customerId]);
  });
}

export async function limitConsentAttempts(customerId: string) {
  await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))", [customerId]);
    const attempts = await client.query<{ count: string }>("SELECT count(*) FROM audit_events WHERE customer_id=$1 AND event_type='NANOBOT_CONNECT_ATTEMPT' AND created_at>now()-interval '15 minutes'", [customerId]);
    if (Number(attempts.rows[0].count) >= 5) throw new AuthError("NANOBOT_CONNECT_LIMIT", 429);
    await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary) VALUES($1,'NANOBOT_CONNECT_ATTEMPT','USER','尝试连接 Nanobot；不记录密码')", [customerId]);
  });
}

export async function disconnectPreview(customerId: string) {
  await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [customerId]);
    await client.query("UPDATE nanobot_consents SET revoked_at=now() WHERE customer_id=$1 AND revoked_at IS NULL", [customerId]);
    await client.query("UPDATE api_tokens SET revoked_at=now() WHERE client_id IN (SELECT client_id FROM nanobot_runs WHERE customer_id=$1) AND revoked_at IS NULL", [customerId]);
    await client.query("UPDATE nanobot_runs SET status='CANCELLED',reply='连接已撤销。已创建的银行草稿不会自动付款。',finished_at=now() WHERE customer_id=$1 AND status='RUNNING'", [customerId]);
    await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary) VALUES($1,'NANOBOT_DISCONNECTED','USER','撤销 Nanobot 银行访问授权')", [customerId]);
  });
}

export async function finishPreviewRun(runId: string, message: string, failed: boolean) {
  await withTransaction(async client => {
    const run = await client.query<{ client_id: string }>("UPDATE nanobot_runs SET status=$2,reply=$3,finished_at=now() WHERE id=$1 AND status='RUNNING' AND expires_at>now() RETURNING client_id", [runId, failed ? "FAILED" : "SUCCEEDED", failed ? NANOBOT_FAILURE : message]);
    for (const row of run.rows) await client.query("UPDATE api_tokens SET revoked_at=now() WHERE client_id=$1 AND revoked_at IS NULL", [row.client_id]);
  });
}

export async function startPreviewRun(customerId: string, input: { requestId: string; conversationId: string; message: string }) {
  await expireRuns(customerId);
  const job = await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [customerId]);
    const consent = await client.query<{ id: string }>("SELECT id FROM nanobot_consents WHERE customer_id=$1 AND revoked_at IS NULL AND expires_at>now()", [customerId]);
    if (!consent.rows[0]) throw new AuthError("NANOBOT_CONSENT_REQUIRED", 403);
    const previous = await client.query("SELECT id FROM nanobot_runs WHERE id=$1 AND customer_id=$2", [input.requestId, customerId]);
    if (previous.rowCount) return null; // Retrying a request never repeats model/tool calls.
    const active = await client.query("SELECT id FROM nanobot_runs WHERE customer_id=$1 AND status='RUNNING'", [customerId]);
    if (active.rowCount) throw new AuthError("NANOBOT_BUSY", 409);
    const count = await client.query<{ count: string }>("SELECT count(*) FROM nanobot_runs WHERE customer_id=$1 AND created_at>now()-interval '24 hours'", [customerId]);
    if (Number(count.rows[0].count) >= 50) throw new AuthError("NANOBOT_DAILY_LIMIT", 429);
    const token = `bpt_${randomBytes(32).toString("base64url")}`;
    const app = await client.query<{ id: string }>("INSERT INTO api_clients(customer_id,name,client_id) VALUES($1,'Nanobot 临时运行',$2) RETURNING id", [customerId, `bp_${randomUUID()}`]);
    await client.query("INSERT INTO api_tokens(client_id,customer_id,token_prefix,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '4 minutes')", [app.rows[0].id, customerId, token.slice(0, 12), createHash("sha256").update(token).digest("hex"), [...API_SCOPES]]);
    await client.query("INSERT INTO nanobot_runs(id,customer_id,consent_id,conversation_id,client_id,message) VALUES($1,$2,$3,$4,$5,$6)", [input.requestId, customerId, consent.rows[0].id, input.conversationId, app.rows[0].id, input.message]);
    return { runId: input.requestId, ownerId: consent.rows[0].id, conversationId: input.conversationId, bankToken: token, message: input.message };
  });
  if (job) {
    try {
      const response = await fetch(`${process.env.NANOBOT_SERVICE_URL}/runs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NANOBOT_SERVICE_TOKEN}` }, body: JSON.stringify(job), signal: AbortSignal.timeout(10_000) });
      if (response.status !== 202) throw new Error("NANOBOT_UNAVAILABLE");
    } catch {
      await finishPreviewRun(input.requestId, "", true);
    }
  }
  return { runId: input.requestId };
}

export async function previewState(customerId: string) {
  await expireRuns(customerId);
  const consent = await query<{ id: string }>("SELECT id FROM nanobot_consents WHERE customer_id=$1 AND revoked_at IS NULL AND expires_at>now()", [customerId]);
  const runs = consent.rows[0] ? await query("SELECT id,conversation_id,message,reply,status,created_at FROM nanobot_runs WHERE customer_id=$1 AND consent_id=$2 ORDER BY created_at DESC LIMIT 30", [customerId, consent.rows[0].id]) : { rows: [] };
  const events = await query("SELECT r.id AS run_id,m.tool_name,m.outcome,m.operation_id,m.created_at FROM mcp_invocations m JOIN nanobot_runs r ON r.client_id=m.client_id WHERE r.customer_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY m.created_at", [customerId, runs.rows.map(row => row.id)]);
  return { connected: Boolean(consent.rows[0]), runs: runs.rows.reverse().map(row => ({ ...row, events: events.rows.filter(e => e.run_id === row.id) })) };
}
