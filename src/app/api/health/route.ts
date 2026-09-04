import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getAIStatus } from "@/lib/ai";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const migration = await query<{ applied: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version='003_agent_runtime_and_channels.sql') AS applied`,
    );
    return NextResponse.json({
      status: "ok",
      database: "connected",
      ai: getAIStatus(),
      agentRuntime: migration.rows[0]?.applied ? "ready" : "migration_required",
      channels: { wecomAdapter: Boolean(process.env.WECOM_ADAPTER_TOKEN && process.env.BANKPILOT_PUBLIC_URL) },
    });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unavailable" }, { status: 503 });
  }
}
