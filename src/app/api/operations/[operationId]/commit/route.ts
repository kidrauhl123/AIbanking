import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { commitPreparedCardLock, commitTransfer } from "@/lib/bank-core";
import { writeAudit } from "@/lib/audit";
import { resumeAgentRuntime } from "@/lib/agent-runtime";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({
  confirmed: z.literal(true),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  code: z.string().max(128).optional(),
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  type: z.enum(["TRANSFER", "CARD_LOCK", "SUBSCRIPTION_CANCEL"]),
});

export async function POST(request: Request, context: RouteContext<"/api/operations/[operationId]/commit">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    const { operationId } = await context.params;
    if (input.type === "SUBSCRIPTION_CANCEL") throw new Error("NOT_IMPLEMENTED");
    let result;
    if (input.type === "TRANSFER") {
      result = await commitTransfer(principal.customerId, operationId, { totpCode: input.totpCode ?? input.code, taskId: input.taskId });
    } else {
      if (!input.resourceId || !input.taskId) throw new Error("RESOURCE_REQUIRED");
      result = await commitPreparedCardLock(principal.customerId, operationId, { resourceId: input.resourceId, taskId: input.taskId });
    }
    if ("authError" in result) return Response.json({ error: result.authError, message: "强验证失败，资金未转出" }, { status: 401 });
    let agent = null;
    let agentRuntime = input.taskId ? "PENDING_FINALIZATION" : "NOT_APPLICABLE";
    if (input.taskId) {
      try {
        agent = await resumeAgentRuntime({
          customerId: principal.customerId,
          taskId: input.taskId,
          operationId,
          approved: true,
        });
        agentRuntime = "COMPLETED";
      } catch (resumeError) {
        await writeAudit({
          customerId: principal.customerId,
          taskId: input.taskId,
          operationId,
          eventType: "AGENT_RESUME_DEFERRED",
          actorType: "SYSTEM",
          summary: "银行操作已完成，Agent 最终回复等待恢复",
          evidence: { error: resumeError instanceof Error ? resumeError.message : "UNKNOWN" },
        });
      }
    }
    return Response.json({ ...result, agent, agentRuntime });
  } catch (error) {
    return apiError(error, "EXECUTION_FAILED");
  }
}
