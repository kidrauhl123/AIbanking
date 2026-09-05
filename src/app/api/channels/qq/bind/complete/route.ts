import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { completeChannelBinding } from "@/lib/channels";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ token: z.string().min(40).max(200), expectedCustomerId: z.string().uuid().optional() });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const { token, expectedCustomerId } = schema.parse(await request.json());
    if (expectedCustomerId && expectedCustomerId !== principal.customerId) throw new AuthError("ACCOUNT_CHANGED", 409);
    return Response.json(await completeChannelBinding(principal.customerId, token, "QQ"));
  } catch (error) {
    return apiError(error, "CHANNEL_BINDING_FAILED");
  }
}
