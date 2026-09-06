import { z } from "zod";
import { validServiceToken } from "@/lib/nanobot-preview";
import { query } from "@/lib/db";
import { readImBody, replyToIm } from "@/lib/nanobot-channels";

const schema = z.object({
  connectionId: z.string().uuid(), senderId: z.string().min(1).max(256),
  chatId: z.string().min(1).max(256), messageId: z.string().min(1).max(256),
  message: z.string().trim().min(1).max(2000),
}).strict();

export async function GET(request: Request) {
  if (!validServiceToken(request.headers.get("authorization"))) return new Response(null, { status: 401 });
  const result = await query<{ id: string }>("SELECT id FROM nanobot_channels WHERE enabled");
  return Response.json({ connections: result.rows.map(row => row.id) }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  if (!validServiceToken(request.headers.get("authorization"))) return new Response(null, { status: 401 });
  try {
    return Response.json(await replyToIm(schema.parse(await readImBody(request))), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ message: "" }, { status: 400 });
  }
}
