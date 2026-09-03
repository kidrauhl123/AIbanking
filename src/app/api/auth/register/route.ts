import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, registerCustomer, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({
  displayName: z.string().trim().min(2).max(40),
  phone: z.string().trim().regex(/^\+?\d{8,15}$/),
  password: z.string().min(10).max(128).regex(/[A-Za-z]/).regex(/\d/),
});

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) throw new AuthError("INVALID_REGISTRATION", 400);
    const result = await registerCustomer({ ...parsed.data, userAgent: request.headers.get("user-agent") });
    const response = NextResponse.json({ customer: result.customer }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expires));
    return response;
  } catch (error) {
    return apiError(error, "REGISTRATION_FAILED");
  }
}
