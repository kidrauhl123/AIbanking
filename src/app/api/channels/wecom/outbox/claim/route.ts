import { z } from "zod";
import { assertChannelAdapterRequest, claimChannelNotifications } from "@/lib/channels";
import { apiError } from "@/lib/http";

const schema = z.object({ limit: z.number().int().min(1).max(25).default(10) });

export async function POST(request: Request) {
  try {
    assertChannelAdapterRequest(request);
    const { limit } = schema.parse(await request.json());
    return Response.json({ items: await claimChannelNotifications(limit) });
  } catch (error) {
    return apiError(error, "OUTBOX_CLAIM_FAILED");
  }
}
