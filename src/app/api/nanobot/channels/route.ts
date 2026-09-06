import { z } from "zod";
import { authenticateRequest, AuthError, verifyCustomerPassword } from "@/lib/auth";
import { connectPreview, limitConsentAttempts, requireNanobot } from "@/lib/nanobot-preview";
import { channelRpc, configureIm, disableIm, imState, issuePairing, ownedChannel, readImBody } from "@/lib/nanobot-channels";

const configure = z.discriminatedUnion("channelType", [
  z.object({ channelType: z.literal("qq"), credentials: z.object({ appId: z.string().trim().regex(/^\d{5,30}$/), secret: z.string().trim().min(8).max(512) }).strict() }),
  z.object({ channelType: z.literal("wecom"), credentials: z.object({ botId: z.string().trim().min(1).max(200), secret: z.string().trim().min(8).max(512) }).strict() }),
  z.object({ channelType: z.literal("weixin"), credentials: z.object({}).strict() }),
]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), password: z.string().min(1).max(128), confirmed: z.literal(true), config: configure }),
  z.object({ action: z.enum(["start", "poll", "cancel", "restart", "validate", "pair", "delete"]), connectionId: z.string().uuid(), sessionId: z.string().max(200).optional() }),
]);
async function session(request: Request) {
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const expected = process.env.BANKPILOT_PUBLIC_URL ?? new URL(request.url).origin;
    if (!origin || new URL(origin).origin !== new URL(expected).origin) throw new AuthError("INVALID_ORIGIN", 403);
  }
  const principal = await authenticateRequest(request);
  if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
  return principal.customerId;
}
const messages: Record<string, string> = {
  CHANNEL_INVALID_INPUT: "请检查提交的配置内容。",
  AUTH_INVALID: "银行密码不正确。", CHANNEL_NOT_FOUND: "没有找到你的连接。",
  CHANNEL_ACTION_FAILED: "渠道连接未完成。请检查机器人凭据或网络，然后重试；微信可重新生成二维码。",
  CHANNEL_BOT_IN_USE: "这个机器人已经连接了其他银行账户，请使用自己的机器人。",
  CHANNEL_CAPACITY: "服务器当前连接数已满，已有连接不受影响。",
  NANOBOT_UNAVAILABLE: "Nanobot 服务暂时不可用，请稍后重试。",
  CHANNEL_DISABLED: "这个连接已解除，请重新配置。", CHANNEL_ALREADY_BOUND: "已绑定，无需再次生成配对码。",
  NANOBOT_CONNECT_LIMIT: "验证次数过多，请 15 分钟后重试。",
};
function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ message: "请检查填写的配置。" }, { status: 400 });
  const code = error instanceof AuthError ? error.code : "CHANNEL_ACTION_FAILED";
  return Response.json({ error: code, message: messages[code] ?? "请确认登录状态后重试。" }, { status: error instanceof AuthError ? error.status : 503 });
}
export async function GET(request: Request) {
  try { return Response.json(await imState(await session(request)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const customerId = await session(request);
    requireNanobot();
    const input = schema.parse(await readImBody(request));
    if (input.action === "configure") {
      await limitConsentAttempts(customerId);
      if (!await verifyCustomerPassword(customerId, input.password)) throw new AuthError("AUTH_INVALID", 401);
      await connectPreview(customerId);
      return Response.json(await configureIm(customerId, input.config.channelType, input.config.credentials));
    }
    const row = await ownedChannel(customerId, input.connectionId);
    if (input.action === "delete") return Response.json(await disableIm(customerId, row.id));
    if (!row.enabled) throw new AuthError("CHANNEL_DISABLED", 409);
    if (input.action === "pair") return Response.json(await issuePairing(customerId, row.id));
    if (input.action === "start" && row.sender_hash) throw new AuthError("CHANNEL_ALREADY_BOUND", 409);
    if (["start", "poll", "cancel"].includes(input.action) && row.channel_type !== "weixin") throw new AuthError("CHANNEL_ACTION_FAILED", 400);
    return Response.json(await channelRpc(row.id, input.action, { sessionId: input.sessionId }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
