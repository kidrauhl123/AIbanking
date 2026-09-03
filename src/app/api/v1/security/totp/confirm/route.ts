import { z } from "zod";
import { AuthError, authenticateRequest, confirmTotpSetup } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("MFA_SETUP_REQUIRES_BANK_APP", 403);
    return Response.json(await confirmTotpSetup(principal.customerId, schema.parse(await request.json()).code));
  } catch (error) {
    return apiError(error, "MFA_CONFIRM_FAILED");
  }
}
