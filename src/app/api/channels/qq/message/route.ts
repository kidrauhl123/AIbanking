import { z } from "zod";
import { assertChannelAdapterRequest } from "@/lib/channels";
import { apiError } from "@/lib/http";
import { handleQqMessage } from "@/lib/qq-gateway";

const schema = z.object({
  tenantExternalId: z.string().min(1).max(256),
  subjectExternalId: z.string().min(1).max(256),
  conversationExternalId: z.string().min(1).max(256),
  eventId: z.string().min(1).max(256),
  message: z.string().trim().min(1).max(500),
});

export async function POST(request: Request) {
  try {
    assertChannelAdapterRequest(request, "QQ");
    return Response.json(await handleQqMessage(schema.parse(await request.json())));
  } catch (error) {
    return apiError(error, "CHANNEL_MESSAGE_FAILED");
  }
}
