import { z } from "zod";
import { authenticateRequest, AuthError, verifyCustomerPassword } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { connectPreview, disconnectPreview, limitConsentAttempts, nanobotAvailable, previewState, requireNanobot, startPreviewRun } from "@/lib/nanobot-preview";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), password: z.string().min(1).max(128), confirmed: z.literal(true) }),
  z.object({ action: z.literal("send"), requestId: z.string().uuid(), conversationId: z.string().uuid(), message: z.string().trim().min(1).max(2000) }),
]);
const messages: Record<string, string> = {
  NANOBOT_UNAVAILABLE: "Nanobot 服务暂不可用，请稍后重试。",
  NANOBOT_CONSENT_REQUIRED: "请先确认连接你的银行账户。",
  NANOBOT_BUSY: "上一条消息还在处理中，请稍候。",
  NANOBOT_DAILY_LIMIT: "今日调用次数已用完，请明天再试。",
  NANOBOT_CONNECT_LIMIT: "连接验证过于频繁，请 15 分钟后再试。",
  AUTH_INVALID: "银行密码不正确。",
};
function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ message: "请检查输入内容。" }, { status: 400 });
  const code = error instanceof AuthError ? error.code : "NANOBOT_UNAVAILABLE";
  return Response.json({ error: code, message: messages[code] ?? "暂时无法连接 Nanobot，请确认登录状态后重试。" }, { status: error instanceof AuthError ? error.status : 503 });
}
async function session(request: Request) {
  if (request.method !== "GET") assertSameOrigin(request);
  const principal = await authenticateRequest(request);
  if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
  return principal.customerId;
}
export async function GET(request: Request) {
  try {
    const id = await session(request);
    const allowed = nanobotAvailable();
    return Response.json({ allowed, ...(await previewState(id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const id = await session(request); requireNanobot();
    const input = schema.parse(await request.json());
    if (input.action === "connect") {
      await limitConsentAttempts(id);
      if (!(await verifyCustomerPassword(id, input.password))) throw new AuthError("AUTH_INVALID", 401);
      await connectPreview(id);
      return Response.json({ connected: true });
    }
    return Response.json(await startPreviewRun(id, input), { status: 202 });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try { await disconnectPreview(await session(request)); return Response.json({ connected: false }); }
  catch (error) { return errorResponse(error); }
}
