import { z } from "zod";
import { assertChannelAdapterRequest } from "@/lib/channels";
import { apiError } from "@/lib/http";
import { handleQqAction } from "@/lib/qq-gateway";

const schema = z.object({
  tenantExternalId: z.string().min(1).max(256),
  subjectExternalId: z.string().min(1).max(256),
  eventId: z.string().min(1).max(256),
  taskId: z.string().uuid(),
  operationId: z.string().min(1).max(80),
  approved: z.boolean(),
});

export async function POST(request: Request) {
  try {
    assertChannelAdapterRequest(request, "QQ");
    return Response.json(await handleQqAction(schema.parse(await request.json())));
  } catch (error) {
    return apiError(error, "CHANNEL_ACTION_FAILED");
  }
}
