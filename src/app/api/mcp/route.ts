import { AuthError, authenticateRequest } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { handleMcpRequest } from "@/lib/mcp";

async function handler(request: Request) {
  try {
    const origin = assertMcpOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "API_TOKEN") return Response.json({ error: "MCP_BEARER_TOKEN_REQUIRED" }, { status: 401 });
    const response = await handleMcpRequest(request, principal);
    if (!origin) return response;
    const headers = new Headers(response.headers); headers.set("Access-Control-Allow-Origin", origin); headers.set("Vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    return apiError(error, "MCP_REQUEST_FAILED");
  }
}

function assertMcpOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const configured = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (origin !== new URL(request.url).origin && !configured.includes(origin)) throw new AuthError("INVALID_ORIGIN", 403);
  return origin;
}

export const GET = handler;
export const POST = handler;
export const DELETE = handler;

export function OPTIONS(request: Request) {
  let origin: string | null;
  try { origin = assertMcpOrigin(request); } catch { return Response.json({ error: "INVALID_ORIGIN" }, { status: 403 }); }
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,Mcp-Protocol-Version,Mcp-Session-Id,Last-Event-ID",
      "Access-Control-Expose-Headers": "Mcp-Protocol-Version,Mcp-Session-Id",
    },
  });
}
