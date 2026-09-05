import { AuthError, authenticateRequest } from "@/lib/auth";
import { getBankStatement } from "@/lib/bank-statements";
import { apiError } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const month = new URL(request.url).searchParams.get("month") ?? undefined;
    return Response.json(await getBankStatement(principal.customerId, month), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "STATEMENT_UNAVAILABLE");
  }
}
