import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { recordDeposit } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({
  accountId: z.string().uuid(),
  amountMinor: z.number().int().positive().max(100_000_000),
  source: z.enum(["CASH", "EXTERNAL_TRANSFER"]),
  reference: z.string().trim().max(80).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("DEPOSIT_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    return Response.json(await recordDeposit(principal.customerId, input), { status: 201 });
  } catch (error) {
    return apiError(error, "DEPOSIT_FAILED");
  }
}
