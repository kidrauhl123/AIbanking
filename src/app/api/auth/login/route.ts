import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, loginCustomer, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({
  phone: z.string().trim().regex(/^\+?\d{8,15}$/),
  password: z.string().min(1).max(128),
});

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) throw new AuthError("INVALID_CREDENTIALS");
    const result = await loginCustomer({ ...parsed.data, userAgent: request.headers.get("user-agent") });
    const response = NextResponse.json({ customer: result.customer });
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expires));
    return response;
  } catch (error) {
    return apiError(error, "LOGIN_FAILED");
  }
}
