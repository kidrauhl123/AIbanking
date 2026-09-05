import { z } from "zod";
import { acknowledgeChannelNotification, assertChannelAdapterRequest } from "@/lib/channels";
import { apiError } from "@/lib/http";

const schema = z.object({
  id: z.string().uuid(),
  delivered: z.boolean(),
  error: z.string().max(300).optional(),
});

export async function POST(request: Request) {
  try {
    assertChannelAdapterRequest(request, "QQ");
    const input = schema.parse(await request.json());
    await acknowledgeChannelNotification("QQ", input.id, input.delivered, input.error);
    return Response.json({ status: input.delivered ? "SENT" : "RETRY_SCHEDULED" });
  } catch (error) {
    return apiError(error, "OUTBOX_ACK_FAILED");
  }
}
