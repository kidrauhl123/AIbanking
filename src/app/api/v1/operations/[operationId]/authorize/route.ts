import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { commitTransfer } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ totpCode: z.string().regex(/^\d{6}$/).optional(), taskId: z.string().uuid().optional() });

export async function POST(request: Request, context: RouteContext<"/api/v1/operations/[operationId]/authorize">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    const { operationId } = await context.params;
    const result = await commitTransfer(principal.customerId, operationId, input);
    if ("authError" in result) return Response.json({ error: result.authError }, { status: 401 });
    return Response.json(result);
  } catch (error) {
    return apiError(error, "AUTHORIZATION_FAILED");
  }
}
