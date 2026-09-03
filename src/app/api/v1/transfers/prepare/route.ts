import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { prepareTransfer } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({
  fromAccountId: z.string().uuid(),
  recipient: z.string().trim().min(2).max(50),
  amountMinor: z.number().int().positive().max(100_000_000),
  note: z.string().trim().max(80).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request, "transfers:prepare");
    const input = schema.parse(await request.json());
    return Response.json(await prepareTransfer(principal.customerId, input), { status: 201 });
  } catch (error) {
    return apiError(error, "TRANSFER_PREPARE_FAILED");
  }
}
