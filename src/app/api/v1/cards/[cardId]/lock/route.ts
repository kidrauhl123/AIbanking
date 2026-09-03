import { AuthError, authenticateRequest } from "@/lib/auth";
import { lockCard } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

export async function POST(request: Request, context: RouteContext<"/api/v1/cards/[cardId]/lock">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("CARD_MANAGEMENT_REQUIRES_BANK_APP", 403);
    const { cardId } = await context.params;
    return Response.json(await lockCard(principal.customerId, cardId));
  } catch (error) {
    return apiError(error, "CARD_LOCK_FAILED");
  }
}
