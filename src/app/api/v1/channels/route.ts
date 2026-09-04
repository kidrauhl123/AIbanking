import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { listChannelIdentities, revokeChannelIdentity } from "@/lib/channels";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ identityId: z.string().uuid() });

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    return Response.json({ channels: await listChannelIdentities(principal.customerId) });
  } catch (error) {
    return apiError(error, "CHANNELS_UNAVAILABLE");
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const { identityId } = schema.parse(await request.json());
    return Response.json(await revokeChannelIdentity(principal.customerId, identityId));
  } catch (error) {
    return apiError(error, "CHANNEL_REVOKE_FAILED");
  }
}
