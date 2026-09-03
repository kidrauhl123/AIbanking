import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { issueVirtualCard } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ accountId: z.string().uuid(), cardName: z.string().trim().min(2).max(30) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("CARD_ISSUANCE_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    return Response.json(await issueVirtualCard(principal.customerId, input.accountId, input.cardName), { status: 201 });
  } catch (error) {
    return apiError(error, "CARD_ISSUANCE_FAILED");
  }
}
