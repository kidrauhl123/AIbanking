import { NextResponse } from "next/server";
import { DEMO_CUSTOMER_ID } from "@/lib/constants";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [tasks, events, policies] = await Promise.all([
      query(`SELECT t.id,t.user_utterance,t.intent,t.status,t.risk_level,t.plan,t.created_at,
        coalesce(json_agg(json_build_object('key',n.node_key,'tool',n.tool_name,'status',n.status,'dependencies',n.dependencies,'output',n.output_summary) ORDER BY n.started_at) FILTER (WHERE n.id IS NOT NULL),'[]') AS nodes
        FROM agent_tasks t LEFT JOIN task_nodes n ON n.task_id=t.id
        WHERE t.customer_id=$1 GROUP BY t.id ORDER BY t.created_at DESC LIMIT 20`, [DEMO_CUSTOMER_ID]),
      query(`SELECT id,task_id,operation_id,event_type,actor_type,event_summary,evidence,created_at FROM audit_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 60`, [DEMO_CUSTOMER_ID]),
      query(`SELECT p.* FROM policy_decisions p LEFT JOIN agent_tasks t ON t.id=p.task_id WHERE t.customer_id=$1 ORDER BY p.created_at DESC LIMIT 30`, [DEMO_CUSTOMER_ID]),
    ]);
    return NextResponse.json({ tasks: tasks.rows, events: events.rows, policies: policies.rows });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "AUDIT_UNAVAILABLE" }, { status: 503 });
  }
}

