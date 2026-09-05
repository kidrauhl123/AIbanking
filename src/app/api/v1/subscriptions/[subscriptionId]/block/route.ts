import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { blockSubscription } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

export async function POST(request: Request, context: RouteContext<"/api/v1/subscriptions/[subscriptionId]/block">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const { subscriptionId } = await context.params;
    if (!z.string().uuid().safeParse(subscriptionId).success) throw new Error("SUBSCRIPTION_NOT_FOUND");
    const input = await request.json().catch(() => null);
    if (input?.confirmed !== true) throw new Error("CONFIRMATION_REQUIRED");
    return Response.json(await blockSubscription(principal.customerId, subscriptionId));
  } catch (error) {
    return apiError(error, "SUBSCRIPTION_BLOCK_FAILED");
  }
}
