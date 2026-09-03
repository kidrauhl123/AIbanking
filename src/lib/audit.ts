import type { PoolClient } from "pg";
import { DEMO_CUSTOMER_ID } from "./constants";
import { query } from "./db";

type AuditInput = {
  eventType: string;
  actorType: "USER" | "AGENT" | "POLICY_ENGINE" | "BANK_CORE" | "RISK_ENGINE" | "SYSTEM";
  summary: string;
  taskId?: string | null;
  operationId?: string | null;
  evidence?: Record<string, unknown>;
};

export async function writeAudit(input: AuditInput, client?: PoolClient) {
  const sql =
    `INSERT INTO audit_events
      (customer_id, task_id, operation_id, event_type, actor_type, event_summary, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`;
  const values = [
    DEMO_CUSTOMER_ID,
    input.taskId ?? null,
    input.operationId ?? null,
    input.eventType,
    input.actorType,
    input.summary,
    JSON.stringify(input.evidence ?? {}),
  ];
  return client ? client.query(sql, values) : query(sql, values);
}
