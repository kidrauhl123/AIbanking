import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { apiError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const customerId = principal.customerId;
    const [tasks, events, policies, mcpInvocations, channelEvents, channels, outbox] = await Promise.all([
      query(`SELECT t.id,t.user_utterance,t.intent,t.status,t.risk_level,t.plan,t.created_at,
        r.status AS runtime_status,r.channel_type,r.interrupt_kind,r.graph_thread_id,
        coalesce(json_agg(json_build_object('key',n.node_key,'tool',n.tool_name,'status',n.status,'dependencies',n.dependencies,'output',n.output_summary) ORDER BY n.started_at) FILTER (WHERE n.id IS NOT NULL),'[]') AS nodes
        FROM agent_tasks t LEFT JOIN task_nodes n ON n.task_id=t.id
        LEFT JOIN agent_runtime_runs r ON r.task_id=t.id
        WHERE t.customer_id=$1 GROUP BY t.id,r.status,r.channel_type,r.interrupt_kind,r.graph_thread_id
        ORDER BY t.created_at DESC LIMIT 20`, [customerId]),
      query(`SELECT id,task_id,operation_id,event_type,actor_type,event_summary,evidence,created_at FROM audit_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 60`, [customerId]),
      query(`SELECT p.* FROM policy_decisions p LEFT JOIN agent_tasks t ON t.id=p.task_id
        WHERE t.customer_id=$1 OR EXISTS (SELECT 1 FROM transfers x WHERE x.operation_id=p.operation_id AND x.customer_id=$1)
        ORDER BY p.created_at DESC LIMIT 30`, [customerId]),
      query(`SELECT id,tool_name,input_summary,outcome,operation_id,created_at FROM mcp_invocations WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 40`, [customerId]),
      query(`SELECT id,task_id,direction,event_type,payload_summary,outcome,created_at
        FROM channel_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 60`, [customerId]),
      query(`SELECT id,channel_type,status,bound_at,last_seen_at,revoked_at
        FROM channel_identities WHERE customer_id=$1 ORDER BY bound_at DESC`, [customerId]),
      query(`SELECT status,count(*)::int AS count FROM channel_outbox
        WHERE customer_id=$1 GROUP BY status ORDER BY status`, [customerId]),
    ]);
    return NextResponse.json({
      tasks: tasks.rows,
      events: events.rows,
      policies: policies.rows,
      mcpInvocations: mcpInvocations.rows,
      channelEvents: channelEvents.rows,
      channels: channels.rows,
      outbox: outbox.rows,
    });
  } catch (error) {
    return apiError(error, "AUDIT_UNAVAILABLE");
  }
}
