import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import { AuthError } from "./auth";
import { query, withTransaction } from "./db";
import { writeAudit } from "./audit";

export type ChannelType = "WECOM" | "QQ";
export type AgentChannel = "PWA" | ChannelType | "MCP";

const BINDING_TTL_MS = 10 * 60 * 1000;

function secretKey(purpose: string) {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) throw new AuthError("SECURITY_CONFIGURATION_REQUIRED", 503);
  return createHash("sha256").update(`bankpilot:${purpose}:${pepper}`).digest();
}

function stableHash(value: string) {
  return createHmac("sha256", secretKey("channel-index")).update(value).digest("hex");
}

export function hashChannelValue(value: string) {
  return stableHash(normalizeExternalId(value));
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey("channel-data"), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptChannelSubject(value: string) {
  const [rawIv, rawTag, rawCiphertext] = value.split(".");
  if (!rawIv || !rawTag || !rawCiphertext) throw new Error("CHANNEL_DATA_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", secretKey("channel-data"), Buffer.from(rawIv, "base64url"));
  decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(rawCiphertext, "base64url")), decipher.final()]).toString("utf8");
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(actual: string, expected: string) {
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeExternalId(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error("CHANNEL_ID_INVALID");
  return normalized;
}

export async function createChannelBindingToken(input: {
  channelType: ChannelType;
  tenantExternalId: string;
  subjectExternalId: string;
}) {
  const tenant = normalizeExternalId(input.tenantExternalId);
  const subject = normalizeExternalId(input.subjectExternalId);
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + BINDING_TTL_MS);
  const result = await query<{ id: string }>(
    `INSERT INTO channel_binding_tokens
      (channel_type,tenant_hash,subject_hash,subject_ciphertext,secret_hash,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.channelType, stableHash(tenant), stableHash(`${tenant}:${subject}`), encrypt(subject), tokenHash(secret), expiresAt],
  );
  return {
    token: `${result.rows[0].id}.${secret}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function completeChannelBinding(customerId: string, token: string, expectedChannelType?: ChannelType) {
  const [id, secret] = token.split(".");
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "") || !secret) throw new Error("BINDING_TOKEN_INVALID");
  return withTransaction(async (client) => {
    const result = await client.query<{
      channel_type: ChannelType;
      tenant_hash: string;
      subject_hash: string;
      subject_ciphertext: string;
      secret_hash: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT channel_type,tenant_hash,subject_hash,subject_ciphertext,secret_hash,expires_at,consumed_at
       FROM channel_binding_tokens WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const binding = result.rows[0];
    if (!binding || binding.consumed_at || binding.expires_at <= new Date() || !sameHash(tokenHash(secret), binding.secret_hash)) {
      throw new Error("BINDING_TOKEN_INVALID");
    }
    if (expectedChannelType && binding.channel_type !== expectedChannelType) throw new Error("CHANNEL_BINDING_MISMATCH");

    const existing = await client.query<{ id: string; customer_id: string }>(
      `SELECT id,customer_id FROM channel_identities
       WHERE channel_type=$1 AND tenant_hash=$2 AND subject_hash=$3 FOR UPDATE`,
      [binding.channel_type, binding.tenant_hash, binding.subject_hash],
    );
    if (existing.rows[0] && existing.rows[0].customer_id !== customerId) throw new Error("CHANNEL_ALREADY_BOUND");

    const identity = existing.rows[0]
      ? await client.query<{ id: string }>(
          `UPDATE channel_identities SET status='ACTIVE',revoked_at=NULL,last_seen_at=now()
           WHERE id=$1 RETURNING id`,
          [existing.rows[0].id],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO channel_identities
            (customer_id,channel_type,tenant_hash,subject_hash,subject_ciphertext)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [customerId, binding.channel_type, binding.tenant_hash, binding.subject_hash, binding.subject_ciphertext],
        );
    await client.query("UPDATE channel_binding_tokens SET consumed_at=now() WHERE id=$1", [id]);
    await writeAudit({
      customerId,
      eventType: "CHANNEL_IDENTITY_BOUND",
      actorType: "USER",
      summary: `客户确认绑定${binding.channel_type === "QQ" ? "QQ" : "企业微信"}身份`,
      evidence: { channelType: binding.channel_type, identityId: identity.rows[0].id },
    }, client);
    return { channelType: binding.channel_type, identityId: identity.rows[0].id, status: "ACTIVE" as const };
  });
}

export async function resolveChannelIdentity(input: {
  channelType: ChannelType;
  tenantExternalId: string;
  subjectExternalId: string;
}) {
  const tenant = normalizeExternalId(input.tenantExternalId);
  const subject = normalizeExternalId(input.subjectExternalId);
  const result = await query<{ id: string; customer_id: string }>(
    `UPDATE channel_identities SET last_seen_at=now()
     WHERE channel_type=$1 AND tenant_hash=$2 AND subject_hash=$3 AND status='ACTIVE'
     RETURNING id,customer_id`,
    [input.channelType, stableHash(tenant), stableHash(`${tenant}:${subject}`)],
  );
  return result.rows[0] ?? null;
}

export async function revokeChannelIdentity(customerId: string, identityId: string) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE channel_identities SET status='REVOKED',revoked_at=now()
       WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' RETURNING id`,
      [identityId, customerId],
    );
    if (!result.rowCount) throw new Error("CHANNEL_IDENTITY_NOT_FOUND");
    await writeAudit({
      customerId,
      eventType: "CHANNEL_IDENTITY_REVOKED",
      actorType: "USER",
      summary: "客户解除外部消息渠道身份绑定",
      evidence: { identityId },
    }, client);
    return { identityId, status: "REVOKED" as const };
  });
}

export async function listChannelIdentities(customerId: string) {
  const result = await query<{
    id: string;
    channel_type: ChannelType;
    status: "ACTIVE" | "REVOKED";
    bound_at: string;
    last_seen_at: string;
    revoked_at: string | null;
  }>(
    `SELECT id,channel_type,status,bound_at::text,last_seen_at::text,revoked_at::text
     FROM channel_identities WHERE customer_id=$1 ORDER BY bound_at DESC`,
    [customerId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    channelType: row.channel_type,
    status: row.status,
    boundAt: row.bound_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }));
}

export function assertChannelAdapterRequest(request: Request, channelType: ChannelType) {
  const expected = process.env[`${channelType}_ADAPTER_TOKEN`];
  if (!expected) throw new AuthError("CHANNEL_ADAPTER_NOT_CONFIGURED", 503);
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new AuthError("INVALID_CHANNEL_ADAPTER_TOKEN");
  }
}

export async function recordChannelEvent(input: {
  identityId?: string | null;
  customerId?: string | null;
  taskId?: string | null;
  channelType: ChannelType;
  direction: "INBOUND" | "OUTBOUND";
  externalEventId?: string | null;
  eventType: string;
  payloadSummary?: Record<string, unknown>;
  outcome: string;
}, client?: PoolClient) {
  const sql = `INSERT INTO channel_events
    (channel_identity_id,customer_id,task_id,channel_type,direction,external_event_id,event_type,payload_summary,outcome)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    ON CONFLICT (channel_type,external_event_id) WHERE direction='INBOUND' AND external_event_id IS NOT NULL
    DO NOTHING RETURNING id`;
  const values = [
    input.identityId ?? null,
    input.customerId ?? null,
    input.taskId ?? null,
    input.channelType,
    input.direction,
    input.externalEventId ?? null,
    input.eventType,
    JSON.stringify(input.payloadSummary ?? {}),
    input.outcome,
  ];
  return client ? client.query(sql, values) : query(sql, values);
}

export async function enqueueChannelNotification(input: {
  channelType: ChannelType;
  identityId: string;
  customerId: string;
  taskId?: string | null;
  dedupeKey: string;
  payload: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO channel_outbox
      (channel_identity_id,customer_id,task_id,channel_type,dedupe_key,payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [input.identityId, input.customerId, input.taskId ?? null, input.channelType, input.dedupeKey, JSON.stringify(input.payload)],
  );
}

export async function claimChannelNotifications(channelType: ChannelType, limit = 10) {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      subject_ciphertext: string;
      task_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `WITH candidates AS (
         SELECT o.id FROM channel_outbox o
         WHERE o.channel_type=$1
           AND o.available_at<=now()
           AND (o.status IN ('PENDING','FAILED') OR (o.status='SENDING' AND o.claimed_at<now()-interval '2 minutes'))
           AND o.attempts<8
         ORDER BY o.created_at
         FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE channel_outbox o SET status='SENDING',claimed_at=now(),attempts=attempts+1
       FROM candidates c,channel_identities i
       WHERE o.id=c.id AND i.id=o.channel_identity_id AND i.status='ACTIVE'
       RETURNING o.id,i.subject_ciphertext,o.task_id,o.payload`,
      [channelType, Math.min(Math.max(limit, 1), 25)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      subjectExternalId: decryptChannelSubject(row.subject_ciphertext),
      taskId: row.task_id,
      payload: row.payload,
    }));
  });
}

export async function acknowledgeChannelNotification(channelType: ChannelType, id: string, delivered: boolean, error?: string) {
  const result = await query(
    `UPDATE channel_outbox SET status=$2,sent_at=CASE WHEN $2='SENT' THEN now() ELSE sent_at END,
     available_at=CASE WHEN $2='FAILED' THEN now()+interval '30 seconds' ELSE available_at END,
     claimed_at=NULL,last_error=$3 WHERE id=$1 AND channel_type=$4 AND status='SENDING' RETURNING id`,
    [id, delivered ? "SENT" : "FAILED", error?.slice(0, 300) ?? null, channelType],
  );
  if (!result.rowCount) throw new Error("OUTBOX_ITEM_NOT_FOUND");
}
