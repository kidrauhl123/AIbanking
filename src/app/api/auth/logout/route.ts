import { NextRequest, NextResponse } from "next/server";
import { logoutSession, SESSION_COOKIE } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";

export async function POST(request: NextRequest) {
  assertSameOrigin(request);
  await logoutSession(request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ status: "SIGNED_OUT" });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
  return response;
}
