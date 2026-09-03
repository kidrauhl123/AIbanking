import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getAIStatus } from "@/lib/ai";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await query("SELECT 1");
    return NextResponse.json({ status: "ok", database: "connected", ai: getAIStatus() });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unavailable" }, { status: 503 });
  }
}
