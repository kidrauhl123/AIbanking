import { query } from "./db";
import { currentBankMonth, validBankMonth, type BankStatement } from "./banking-report";

export async function getBankStatement(customerId: string, month = currentBankMonth()): Promise<BankStatement> {
  if (!validBankMonth(month)) throw new Error("INVALID_STATEMENT_MONTH");
  // Aggregate the complete month, independently of the overview's recent-50 limit.
  // One SQL snapshot keeps totals, categories and anomaly counts consistent.
  const result = await query<{ report: BankStatement }>(
    `WITH monthly AS (
       SELECT bt.* FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1
         AND bt.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND bt.occurred_at < (($2::date + interval '1 month') AT TIME ZONE 'Asia/Shanghai')
     )
     SELECT jsonb_build_object(
       'month',$3::text,
       'incomeMinor',coalesce(sum(amount_minor) FILTER (WHERE amount_minor>0),0),
       'expenseMinor',coalesce(-sum(amount_minor) FILTER (WHERE amount_minor<0),0),
       'transactionCount',count(*),
       'anomalyCount',count(*) FILTER (WHERE is_anomaly),
       'categories',coalesce((SELECT jsonb_agg(category_row ORDER BY "totalMinor" DESC,category) FROM (
         SELECT category,-sum(amount_minor) AS "totalMinor",count(*) AS count
         FROM monthly WHERE amount_minor<0 GROUP BY category
       ) category_row),'[]'::jsonb),
       'anomalies',coalesce((SELECT jsonb_agg(anomaly_row ORDER BY "occurredAt" DESC,id) FROM (
         SELECT id,merchant_name AS "merchantName",amount_minor AS "amountMinor",occurred_at AS "occurredAt"
         FROM monthly WHERE is_anomaly ORDER BY occurred_at DESC,id LIMIT 20
       ) anomaly_row),'[]'::jsonb)
     ) AS report FROM monthly`,
    [customerId, `${month}-01`, month],
  );
  return result.rows[0].report;
}
