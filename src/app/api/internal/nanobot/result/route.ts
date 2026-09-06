import { z } from "zod";
import { finishPreviewRun, validServiceToken } from "@/lib/nanobot-preview";
const schema = z.object({ runId: z.string().uuid(), message: z.string().max(20000), failed: z.boolean() });
export async function POST(request: Request) {
  if (!validServiceToken(request.headers.get("authorization"))) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const input = schema.parse(await request.json());
    await finishPreviewRun(input.runId, input.message, input.failed);
    return Response.json({ ok: true });
  } catch { return Response.json({ error: "RESULT_REJECTED" }, { status: 400 }); }
}
