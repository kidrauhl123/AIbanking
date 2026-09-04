import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { completeChannelBinding } from "@/lib/channels";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ token: z.string().min(40).max(200) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const { token } = schema.parse(await request.json());
    return Response.json(await completeChannelBinding(principal.customerId, token));
  } catch (error) {
    return apiError(error, "CHANNEL_BINDING_FAILED");
  }
}
