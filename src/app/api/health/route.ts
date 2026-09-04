import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getAIStatus } from "@/lib/ai";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const readiness = await query<{ migration_applied: boolean; checkpoints_ready: boolean }>(
      `SELECT
        EXISTS(SELECT 1 FROM schema_migrations WHERE version='003_agent_runtime_and_channels.sql') AS migration_applied,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='langgraph' AND table_name='checkpoints') AS checkpoints_ready`,
    );
    return NextResponse.json({
      status: "ok",
      database: "connected",
      ai: getAIStatus(),
      agentRuntime: readiness.rows[0]?.checkpoints_ready
        ? "ready"
        : readiness.rows[0]?.migration_applied ? "initializes_on_first_run" : "migration_required",
      channels: { wecomAdapter: Boolean(process.env.WECOM_ADAPTER_TOKEN && process.env.BANKPILOT_PUBLIC_URL) },
    });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unavailable" }, { status: 503 });
  }
}
