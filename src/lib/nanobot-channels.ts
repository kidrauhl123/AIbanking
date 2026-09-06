import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { AuthError } from "./auth";
import { query, withTransaction } from "./db";
import { requireNanobot, startPreviewRun } from "./nanobot-preview";

export type ImKind = "qq" | "wecom" | "weixin";
export async function readImBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("CHANNEL_INVALID_INPUT", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 12000) { await reader.cancel(); throw new AuthError("CHANNEL_INVALID_INPUT", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("CHANNEL_INVALID_INPUT", 400);
  } finally { reader.releaseLock(); }
}
type Connection = { id: string; customer_id: string; channel_type: ImKind; enabled: boolean; sender_hash: string | null; pairing_hash: string | null; pairing_valid: boolean; pairing_attempts: number };

export function imHash(value: string) {
  const secret = process.env.PASSWORD_PEPPER;
  if (!secret || secret.length < 16) throw new AuthError("SECURITY_CONFIGURATION_REQUIRED", 503);
  return createHmac("sha256", secret).update(`nanobot/im/v1/${value}`).digest("hex");
}

export async function channelRpc(connectionId: string, action: string, values: Record<string, unknown> = {}) {
  requireNanobot();
  try {
    const result = await fetch(`${process.env.NANOBOT_SERVICE_URL}/channels`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NANOBOT_SERVICE_TOKEN}` },
      body: JSON.stringify({ ...values, connectionId, action }), signal: AbortSignal.timeout(70_000), cache: "no-store",
    });
    const body = await result.json();
    if (!result.ok) throw new AuthError(body.error === "CHANNEL_CAPACITY" ? "CHANNEL_CAPACITY" : "CHANNEL_ACTION_FAILED", 503);
    return body;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("CHANNEL_ACTION_FAILED", 503);
  }
}

export async function ownedChannel(customerId: string, id: string) {
  const result = await query<Connection>("SELECT * FROM nanobot_channels WHERE id=$1 AND customer_id=$2", [id, customerId]);
  if (!result.rows[0]) throw new AuthError("CHANNEL_NOT_FOUND", 404);
  return result.rows[0];
}

export async function imState(customerId: string) {
  const result = await query("SELECT id,channel_type,enabled,sender_hash IS NOT NULL AS bound,last_seen_at,pairing_expires_at FROM nanobot_channels WHERE customer_id=$1 ORDER BY created_at", [customerId]);
  const consent = await query("SELECT id FROM nanobot_consents WHERE customer_id=$1 AND revoked_at IS NULL AND expires_at>now()", [customerId]);
  const channels = await Promise.all(result.rows.map(async row => {
    let runtime = "stopped";
    if (row.enabled) {
      try { runtime = (await channelRpc(row.id, "status")).state; }
      catch { runtime = "unavailable"; }
    }
    return { ...row, runtime };
  }));
  return { consent: Boolean(consent.rowCount), channels };
}

export async function configureIm(customerId: string, kind: ImKind, credentials: Record<string, string>) {
  const botId = kind === "qq" ? credentials.appId : kind === "wecom" ? credentials.botId : null;
  let id: string;
  try {
    id = await withTransaction(async client => {
      const result = await client.query<{ id: string }>(`INSERT INTO nanobot_channels(customer_id,channel_type,bot_hash)
        VALUES($1,$2,$3) ON CONFLICT(customer_id,channel_type) DO UPDATE SET
        enabled=true,bot_hash=excluded.bot_hash,sender_hash=NULL,pairing_hash=NULL,pairing_attempts=0,last_seen_at=NULL,updated_at=now() RETURNING id`,
        [customerId, kind, botId ? imHash(`bot/${kind}/${botId}`) : null]);
      await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary) VALUES($1,'IM_CONFIGURED','USER',$2)", [customerId, `配置个人 ${kind} 连接；日志不包含密钥`]);
      await client.query("UPDATE api_tokens SET revoked_at=now() WHERE client_id IN (SELECT client_id FROM nanobot_runs WHERE customer_id=$1 AND conversation_id=$2) AND revoked_at IS NULL", [customerId, result.rows[0].id]);
      await client.query("UPDATE nanobot_runs SET status='CANCELLED',finished_at=now(),reply='IM 配置已更换。' WHERE customer_id=$1 AND conversation_id=$2 AND status='RUNNING'", [customerId, result.rows[0].id]);
      return result.rows[0].id;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new AuthError("CHANNEL_BOT_IN_USE", 409);
    throw error;
  }
  // A failed network/start request must stay visibly unconnected, not fabricated.
  await channelRpc(id, "configure", { channelType: kind, credentials });
  return { id, ...(await issuePairing(customerId, id)) };
}

export async function issuePairing(customerId: string, id: string) {
  const row = await ownedChannel(customerId, id);
  if (!row.enabled) throw new AuthError("CHANNEL_DISABLED", 409);
  if (row.sender_hash) throw new AuthError("CHANNEL_ALREADY_BOUND", 409);
  const code = `BP-${randomBytes(6).toString("hex").toUpperCase()}`;
  await query("UPDATE nanobot_channels SET pairing_hash=$3,pairing_expires_at=now()+interval '10 minutes',pairing_attempts=0 WHERE id=$1 AND customer_id=$2", [id, customerId, imHash(`pair/${id}/${code}`)]);
  return { pairingCode: code };
}

export async function disableIm(customerId: string, id: string) {
  await ownedChannel(customerId, id);
  await withTransaction(async client => {
    await client.query("UPDATE nanobot_channels SET enabled=false,sender_hash=NULL,pairing_hash=NULL,updated_at=now() WHERE id=$1 AND customer_id=$2", [id, customerId]);
    // Stop already-issued IM tokens; don't affect unrelated PWA conversations.
    await client.query("UPDATE api_tokens SET revoked_at=now() WHERE client_id IN (SELECT client_id FROM nanobot_runs WHERE customer_id=$1 AND conversation_id=$2) AND revoked_at IS NULL", [customerId, id]);
    await client.query("UPDATE nanobot_runs SET status='CANCELLED',finished_at=now(),reply='IM 连接已解除。' WHERE customer_id=$1 AND conversation_id=$2 AND status='RUNNING'", [customerId, id]);
    await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary) VALUES($1,'IM_DISCONNECTED','USER','解除个人 IM 连接，撤销该渠道运行令牌')", [customerId]);
  });
  // DB authorization is revoked first even if the worker cannot be reached.
  try { await channelRpc(id, "delete"); return { stopped: true }; }
  catch { return { stopped: false }; }
}

export type ImMessage = { connectionId: string; senderId: string; chatId: string; messageId: string; message: string };
export async function acceptImMessage(input: ImMessage) {
  return withTransaction(async client => {
    const result = await client.query<Connection>(`SELECT *,pairing_expires_at>now() AS pairing_valid FROM nanobot_channels WHERE id=$1 FOR UPDATE`, [input.connectionId]);
    const row = result.rows[0];
    if (!row?.enabled) return null;
    const senderHash = imHash(`sender/${row.id}/${input.senderId}/${input.chatId}`);
    if (!row.sender_hash) {
      if (!input.message.trim().toUpperCase().startsWith("BP-")) return null;
      await client.query("UPDATE nanobot_channels SET pairing_attempts=pairing_attempts+1 WHERE id=$1", [row.id]);
      if (!row.pairing_valid || row.pairing_attempts >= 20 || row.pairing_hash !== imHash(`pair/${row.id}/${input.message.trim().toUpperCase()}`)) return null;
      await client.query("UPDATE nanobot_channels SET sender_hash=$2,pairing_hash=NULL,last_seen_at=now(),updated_at=now() WHERE id=$1", [row.id, senderHash]);
      await client.query("INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary) VALUES($1,'IM_PAIRED','USER',$2)", [row.customer_id, `已验证 ${row.channel_type} 私聊身份；未授予付款权限`]);
      return { paired: true as const };
    }
    if (row.sender_hash !== senderHash) return null;
    await client.query("UPDATE nanobot_channels SET last_seen_at=now() WHERE id=$1", [row.id]);
    const consent = await client.query("SELECT id FROM nanobot_consents WHERE customer_id=$1 AND revoked_at IS NULL AND expires_at>now()", [row.customer_id]);
    if (!consent.rowCount) return { authorizationRequired: true as const };
    const externalHash = imHash(`event/${row.id}/${input.senderId}/${input.messageId}`);
    const message = await client.query<{ run_id: string }>(`INSERT INTO nanobot_channel_messages(connection_id,external_hash,run_id) VALUES($1,$2,$3)
      ON CONFLICT(connection_id,external_hash) DO UPDATE SET external_hash=excluded.external_hash RETURNING run_id`, [row.id, externalHash, randomUUID()]);
    return { customerId: row.customer_id, runId: message.rows[0].run_id, connectionId: row.id };
  });
}

export async function replyToIm(input: ImMessage) {
  const accepted = await acceptImMessage(input);
  if (!accepted) return { message: "" };
  if ("paired" in accepted) return { message: "已连接你的 BankPilot 银行账户。可以发“查一下余额”开始；付款仍需在银行 APP 确认。" };
  if ("authorizationRequired" in accepted) return { message: "银行访问授权已到期或撤销，请在 BankPilot 的 AI 页面重新授权。" };
  try {
    await startPreviewRun(accepted.customerId, { requestId: accepted.runId, conversationId: accepted.connectionId, channelId: accepted.connectionId, message: input.message });
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline) {
      const run = await query<{ status: string; reply: string; enabled: boolean }>(`SELECT r.status,r.reply,
        (c.enabled AND EXISTS(SELECT 1 FROM nanobot_consents s WHERE s.id=r.consent_id AND s.revoked_at IS NULL AND s.expires_at>now())) AS enabled
        FROM nanobot_runs r JOIN nanobot_channels c ON c.id=r.conversation_id WHERE r.id=$1 AND r.customer_id=$2`, [accepted.runId, accepted.customerId]);
      const row = run.rows[0];
      if (!row?.enabled || row.status === "CANCELLED") return { message: "" };
      if (row.status !== "RUNNING") return { message: row.reply ?? "本次运行未完成，请回到银行 APP 查看。" };
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    return { message: "处理超时，请回到银行 APP 查看运行记录，避免重复发起同一笔操作。" };
  } catch (error) {
    const messages: Record<string, string> = {
      NANOBOT_BUSY: "上一条银行消息仍在处理，请稍候再发。",
      NANOBOT_DAILY_LIMIT: "今日调用次数已用完，请明天再试。",
      NANOBOT_CONSENT_REQUIRED: "请在银行 APP 的 AI 页面重新授权。",
    };
    return { message: error instanceof AuthError ? messages[error.code] ?? "银行服务暂不可用，请回到 APP 查看。" : "银行服务暂不可用，请回到 APP 查看。" };
  }
}
