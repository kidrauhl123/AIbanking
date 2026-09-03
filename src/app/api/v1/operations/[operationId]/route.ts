import { authenticateRequest } from "@/lib/auth";
import { getOperation } from "@/lib/bank-core";
import { apiError } from "@/lib/http";

export async function GET(request: Request, context: RouteContext<"/api/v1/operations/[operationId]">) {
  try {
    const principal = await authenticateRequest(request, "operations:read");
    const { operationId } = await context.params;
    return Response.json(await getOperation(principal.customerId, operationId));
  } catch (error) {
    return apiError(error, "OPERATION_READ_FAILED");
  }
}
