import { z } from "zod";
import { AuthError, authenticateRequest, beginTotpSetup, verifyCustomerPassword } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ password: z.string().min(1).max(128) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("MFA_SETUP_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    if (!(await verifyCustomerPassword(principal.customerId, input.password))) throw new Error("AUTH_INVALID");
    return Response.json(await beginTotpSetup(principal.customerId));
  } catch (error) {
    return apiError(error, "MFA_SETUP_FAILED");
  }
}
