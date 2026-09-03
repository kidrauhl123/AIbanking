import { AuthError, authenticateRequest } from "@/lib/auth";
import { query } from "@/lib/db";
import { apiError, assertSameOrigin } from "@/lib/http";

export async function DELETE(request: Request, context: RouteContext<"/api/v1/developer/tokens/[tokenId]">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("TOKEN_MANAGEMENT_REQUIRES_BANK_APP", 403);
    const { tokenId } = await context.params;
    const result = await query(
      `UPDATE api_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND customer_id=$2 RETURNING id`,
      [tokenId, principal.customerId],
    );
    if (!result.rows[0]) throw new Error("TOKEN_NOT_FOUND");
    await query(
      `INSERT INTO audit_events (customer_id,event_type,actor_type,event_summary,evidence)
       VALUES ($1,'API_TOKEN_REVOKED','USER','客户撤销第三方 Agent 访问令牌',$2::jsonb)`,
      [principal.customerId, JSON.stringify({ tokenId })],
    );
    return Response.json({ revoked: true });
  } catch (error) {
    return apiError(error, "TOKEN_REVOKE_FAILED");
  }
}
