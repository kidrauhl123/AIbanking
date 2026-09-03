import { z } from "zod";
import { API_SCOPES, AuthError, authenticateRequest, createApiToken, verifyCustomerPassword, type ApiScope } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";
import { query } from "@/lib/db";

const schema = z.object({
  name: z.string().trim().min(2).max(60),
  password: z.string().min(1).max(128),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("TOKEN_CREATION_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json()) as { name: string; password: string; scopes: ApiScope[] };
    if (!(await verifyCustomerPassword(principal.customerId, input.password))) throw new Error("AUTH_INVALID");
    return Response.json(await createApiToken(principal.customerId, input), { status: 201 });
  } catch (error) {
    return apiError(error, "TOKEN_CREATION_FAILED");
  }
}

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("TOKEN_MANAGEMENT_REQUIRES_BANK_APP", 403);
    const tokens = await query(
      `SELECT t.id,c.name,c.client_id,t.token_prefix,t.scopes,t.created_at,t.expires_at,t.last_used_at,t.revoked_at
       FROM api_tokens t JOIN api_clients c ON c.id=t.client_id
       WHERE t.customer_id=$1 ORDER BY t.created_at DESC`,
      [principal.customerId],
    );
    return Response.json({ tokens: tokens.rows });
  } catch (error) {
    return apiError(error, "TOKEN_LIST_FAILED");
  }
}
