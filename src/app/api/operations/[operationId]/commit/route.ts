import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { commitTransfer } from "@/lib/bank-core";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({
  confirmed: z.literal(true),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  code: z.string().max(128).optional(),
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  type: z.enum(["TRANSFER", "CARD_LOCK", "SUBSCRIPTION_CANCEL"]),
});

async function commitCardLock(customerId: string, operationId: string, input: z.infer<typeof schema>) {
  if (!input.resourceId || !input.taskId) throw new Error("RESOURCE_REQUIRED");
  return withTransaction(async (client) => {
    const decision = await client.query<{ evidence: { cardId?: string }; task_id: string }>(
      `SELECT p.evidence,p.task_id FROM policy_decisions p JOIN agent_tasks t ON t.id=p.task_id
       WHERE p.operation_id=$1 AND p.final_level='YELLOW' AND t.customer_id=$2 FOR UPDATE OF p`,
      [operationId, customerId],
    );
    if (!decision.rowCount || decision.rows[0].evidence.cardId !== input.resourceId || decision.rows[0].task_id !== input.taskId) throw new Error("AUTHORIZATION_MISMATCH");
    const card = await client.query<{ status: string; card_name: string; masked_no: string }>(
      "SELECT status,card_name,masked_no FROM cards WHERE id=$1 AND customer_id=$2 FOR UPDATE",
      [input.resourceId, customerId],
    );
    if (!card.rows[0]) throw new Error("OPERATION_NOT_FOUND");
    if (card.rows[0].status !== "LOCKED") await client.query("UPDATE cards SET status='LOCKED' WHERE id=$1", [input.resourceId]);
    await client.query("UPDATE agent_tasks SET status='SUCCEEDED',updated_at=now() WHERE id=$1 AND customer_id=$2", [input.taskId, customerId]);
    await writeAudit({ customerId, eventType: "CARD_LOCKED", actorType: "BANK_CORE", summary: "客户确认后锁定卡片", taskId: input.taskId, operationId, evidence: { cardId: input.resourceId } }, client);
    return { operationId, status: "SUCCEEDED", card: `${card.rows[0].card_name} ${card.rows[0].masked_no}` };
  });
}

export async function POST(request: Request, context: RouteContext<"/api/operations/[operationId]/commit">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    const { operationId } = await context.params;
    if (input.type === "SUBSCRIPTION_CANCEL") throw new Error("NOT_IMPLEMENTED");
    const result = input.type === "TRANSFER"
      ? await commitTransfer(principal.customerId, operationId, { totpCode: input.totpCode ?? input.code, taskId: input.taskId })
      : await commitCardLock(principal.customerId, operationId, input);
    if ("authError" in result) return Response.json({ error: result.authError, message: "强验证失败，资金未转出" }, { status: 401 });
    return Response.json(result);
  } catch (error) {
    return apiError(error, "EXECUTION_FAILED");
  }
}
