import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = "bankpilot_session";
const SESSION_DAYS = 7;

export const API_SCOPES = [
  "accounts:read",
  "transactions:read",
  "beneficiaries:read",
  "transfers:prepare",
  "operations:read",
  "cards:read",
  "subscriptions:read",
  "products:read",
] as const;

export type ApiScope = typeof API_SCOPES[number];
export type AuthPrincipal = {
  customerId: string;
  kind: "SESSION" | "API_TOKEN";
  scopes: Set<ApiScope | "*">;
  clientId?: string;
};

export class AuthError extends Error {
  constructor(public code: string, public status = 401) {
    super(code);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(input: Buffer) {
  let bits = 0; let value = 0; let output = "";
  for (const byte of input) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string) {
  let bits = 0; let value = 0; const output: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = base32Alphabet.indexOf(char); if (index < 0) continue;
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

function mfaKey() {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) throw new AuthError("SECURITY_CONFIGURATION_REQUIRED", 503);
  return createHash("sha256").update(`bankpilot:mfa:${pepper}`).digest();
}

function encryptSecret(secret: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", mfaKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptSecret(value: string) {
  const [iv, tag, ciphertext] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", mfaKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function totp(secret: string, counter = Math.floor(Date.now() / 30_000)) {
  const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

function verifyTotp(secret: string, code: string) {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((offset) => timingSafeEqual(Buffer.from(totp(secret, counter + offset)), Buffer.from(code)));
}

function parseCookies(header: string | null) {
  const result = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName && rest.length) result.set(rawName, decodeURIComponent(rest.join("=")));
  }
  return result;
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires,
    priority: "high" as const,
  };
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const pepper = process.env.PASSWORD_PEPPER ?? "";
  const derived = await scrypt(`${password}${pepper}`, salt, 64) as Buffer;
  return { salt, hash: derived.toString("hex") };
}

export async function verifyPassword(password: string, salt: string, expectedHex: string) {
  const actual = Buffer.from((await hashPassword(password, salt)).hash, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function accountNumber() {
  return `622202${String(randomInt(0, 10_000_000_000)).padStart(10, "0")}`;
}

export async function registerCustomer(input: { displayName: string; phone: string; password: string; userAgent?: string | null }) {
  const password = await hashPassword(input.password);
  return withTransaction(async (client) => {
    try {
      const customer = await client.query<{ id: string; display_name: string; phone: string }>(
        `INSERT INTO customers (display_name,phone,risk_profile)
         VALUES ($1,$2,'UNASSESSED') RETURNING id,display_name,phone`,
        [input.displayName, input.phone],
      );
      const row = customer.rows[0];
      await client.query(
        `INSERT INTO auth_credentials (customer_id,password_salt,password_hash) VALUES ($1,$2,$3)`,
        [row.id, password.salt, password.hash],
      );
      const number = accountNumber();
      await client.query(
        `INSERT INTO accounts (customer_id,name,account_type,account_no,masked_no,currency,available_balance_minor,status)
         VALUES ($1,'活期账户','CHECKING',$2,$3,'CNY',0,'ACTIVE')`,
        [row.id, number, `•• ${number.slice(-4)}`],
      );
      await client.query(
        `INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence)
         VALUES ($1,'CUSTOMER_REGISTERED','USER','客户完成注册并开立零余额活期账户',$2::jsonb)`,
        [row.id, JSON.stringify({ accountOpening: "USER_INITIATED", initialBalanceMinor: 0 })],
      );
      const session = await createSession(row.id, input.userAgent, client);
      return { customer: row, ...session };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AuthError("PHONE_ALREADY_REGISTERED", 409);
      throw error;
    }
  });
}

async function createSession(customerId: string, userAgent?: string | null, client?: PoolClient) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const sql = `INSERT INTO user_sessions (customer_id,token_hash,user_agent,expires_at) VALUES ($1,$2,$3,$4)`;
  const values = [customerId, sha256(token), userAgent?.slice(0, 300) ?? null, expires];
  if (client) await client.query(sql, values);
  else await query(sql, values);
  return { token, expires };
}

export async function loginCustomer(input: { phone: string; password: string; userAgent?: string | null }) {
  const credential = await query<{
    customer_id: string; display_name: string; phone: string; status: string;
    password_salt: string; password_hash: string; failed_attempts: number; locked_until: Date | null;
  }>(
    `SELECT c.id AS customer_id,c.display_name,c.phone,c.status,
            a.password_salt,a.password_hash,a.failed_attempts,a.locked_until
     FROM customers c JOIN auth_credentials a ON a.customer_id=c.id WHERE c.phone=$1`,
    [input.phone],
  );
  const row = credential.rows[0];
  if (!row) throw new AuthError("INVALID_CREDENTIALS");
  if (row.status !== "ACTIVE") throw new AuthError("CUSTOMER_UNAVAILABLE", 403);
  if (row.locked_until && row.locked_until > new Date()) throw new AuthError("LOGIN_TEMPORARILY_LOCKED", 423);
  if (!(await verifyPassword(input.password, row.password_salt, row.password_hash))) {
    await query(
      `UPDATE auth_credentials SET failed_attempts=failed_attempts+1,
       locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END
       WHERE customer_id=$1`,
      [row.customer_id],
    );
    throw new AuthError("INVALID_CREDENTIALS");
  }
  await query("UPDATE auth_credentials SET failed_attempts=0,locked_until=NULL WHERE customer_id=$1", [row.customer_id]);
  const session = await createSession(row.customer_id, input.userAgent);
  await query(
    `INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence)
     VALUES ($1,'SESSION_AUTHENTICATED','SYSTEM','客户通过密码验证登录','{}'::jsonb)`,
    [row.customer_id],
  );
  return { customer: { id: row.customer_id, display_name: row.display_name, phone: row.phone }, ...session };
}

export async function logoutSession(rawToken: string | undefined) {
  if (!rawToken) return;
  await query("UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [sha256(rawToken)]);
}

export async function authenticateRequest(request: Request, requiredScope?: ApiScope): Promise<AuthPrincipal> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const raw = authorization.slice(7).trim();
    const result = await query<{ customer_id: string; scopes: ApiScope[]; client_id: string }>(
      `UPDATE api_tokens t SET last_used_at=now()
       FROM api_clients c,customers u
       WHERE t.token_hash=$1 AND t.client_id=c.id AND t.customer_id=u.id
         AND t.revoked_at IS NULL AND t.expires_at>now() AND c.status='ACTIVE' AND u.status='ACTIVE'
       RETURNING t.customer_id,t.scopes,t.client_id`,
      [sha256(raw)],
    );
    const row = result.rows[0];
    if (!row) throw new AuthError("INVALID_API_TOKEN");
    const principal: AuthPrincipal = { customerId: row.customer_id, kind: "API_TOKEN", scopes: new Set(row.scopes), clientId: row.client_id };
    if (requiredScope && !principal.scopes.has(requiredScope)) throw new AuthError("INSUFFICIENT_SCOPE", 403);
    return principal;
  }

  const raw = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (!raw) throw new AuthError("AUTHENTICATION_REQUIRED");
  const result = await query<{ customer_id: string }>(
    `UPDATE user_sessions s SET last_seen_at=now()
     FROM customers c
     WHERE s.token_hash=$1 AND s.customer_id=c.id AND s.revoked_at IS NULL
       AND s.expires_at>now() AND c.status='ACTIVE'
     RETURNING s.customer_id`,
    [sha256(raw)],
  );
  if (!result.rows[0]) throw new AuthError("SESSION_EXPIRED");
  return { customerId: result.rows[0].customer_id, kind: "SESSION", scopes: new Set(["*"]) };
}

export async function verifyCustomerPassword(customerId: string, password: string) {
  const result = await query<{ password_salt: string; password_hash: string }>(
    "SELECT password_salt,password_hash FROM auth_credentials WHERE customer_id=$1",
    [customerId],
  );
  const row = result.rows[0];
  return Boolean(row && await verifyPassword(password, row.password_salt, row.password_hash));
}

export async function beginTotpSetup(customerId: string) {
  const secret = base32Encode(randomBytes(20));
  const identity = await query<{ display_name: string; phone: string }>("SELECT display_name,phone FROM customers WHERE id=$1", [customerId]);
  if (!identity.rows[0]) throw new AuthError("CUSTOMER_UNAVAILABLE", 403);
  await query(
    `INSERT INTO mfa_totp (customer_id,encrypted_secret,enabled_at) VALUES ($1,$2,NULL)
     ON CONFLICT (customer_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,enabled_at=NULL,updated_at=now()`,
    [customerId, encryptSecret(secret)],
  );
  const label = encodeURIComponent(`BankPilot:${identity.rows[0].phone}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=BankPilot&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

export async function confirmTotpSetup(customerId: string, code: string) {
  const result = await query<{ encrypted_secret: string }>("SELECT encrypted_secret FROM mfa_totp WHERE customer_id=$1 AND enabled_at IS NULL", [customerId]);
  if (!result.rows[0] || !verifyTotp(decryptSecret(result.rows[0].encrypted_secret), code)) throw new AuthError("MFA_INVALID", 401);
  await query("UPDATE mfa_totp SET enabled_at=now(),updated_at=now() WHERE customer_id=$1", [customerId]);
  await query(`INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence) VALUES ($1,'MFA_ENABLED','USER','客户启用 TOTP 多因素认证','{}'::jsonb)`, [customerId]);
  return { enabled: true };
}

export async function verifyCustomerTotp(customerId: string, code: string) {
  const result = await query<{ encrypted_secret: string }>("SELECT encrypted_secret FROM mfa_totp WHERE customer_id=$1 AND enabled_at IS NOT NULL", [customerId]);
  return Boolean(result.rows[0] && verifyTotp(decryptSecret(result.rows[0].encrypted_secret), code));
}

export async function createApiToken(customerId: string, input: { name: string; scopes: ApiScope[] }) {
  const invalid = input.scopes.filter((scope) => !API_SCOPES.includes(scope));
  if (invalid.length) throw new AuthError("INVALID_SCOPE", 400);
  return withTransaction(async (client) => {
    const clientId = `bp_${randomBytes(8).toString("hex")}`;
    const app = await client.query<{ id: string }>(
      `INSERT INTO api_clients (customer_id,name,client_id) VALUES ($1,$2,$3) RETURNING id`,
      [customerId, input.name, clientId],
    );
    const token = `bpt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO api_tokens (client_id,customer_id,token_prefix,token_hash,scopes,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [app.rows[0].id, customerId, token.slice(0, 12), sha256(token), input.scopes, expiresAt],
    );
    await client.query(
      `INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence)
       VALUES ($1,'API_TOKEN_CREATED','USER','客户创建第三方 Agent 访问令牌',$2::jsonb)`,
      [customerId, JSON.stringify({ clientId, name: input.name, scopes: input.scopes, expiresAt })],
    );
    return { clientId, token, tokenPrefix: token.slice(0, 12), scopes: input.scopes, expiresAt };
  });
}
