import { NextResponse } from "next/server";
import { DEMO_CUSTOMER_ID } from "@/lib/constants";
import { query } from "@/lib/db";
import { getAIStatus } from "@/lib/ai";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [customer, accounts, transactions, cards, subscriptions] = await Promise.all([
      query(`SELECT display_name, risk_profile FROM customers WHERE id=$1`, [DEMO_CUSTOMER_ID]),
      query(`SELECT id,name,account_type,masked_no,currency,available_balance_minor,status FROM accounts WHERE customer_id=$1 ORDER BY created_at`, [DEMO_CUSTOMER_ID]),
      query(`SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.currency,bt.occurred_at,bt.is_anomaly
             FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
             WHERE a.customer_id=$1 ORDER BY occurred_at DESC LIMIT 12`, [DEMO_CUSTOMER_ID]),
      query(`SELECT id,card_name,masked_no,card_type,status,online_enabled,overseas_enabled,contactless_enabled,daily_limit_minor FROM cards WHERE customer_id=$1 ORDER BY card_name`, [DEMO_CUSTOMER_ID]),
      query(`SELECT id,merchant_name,amount_minor,billing_cycle,next_charge_at,status FROM subscriptions WHERE customer_id=$1 ORDER BY next_charge_at`, [DEMO_CUSTOMER_ID]),
    ]);
    const totalMinor = accounts.rows.reduce((sum, row) => sum + Number(row.available_balance_minor), 0);
    return NextResponse.json({ customer: customer.rows[0], totalMinor, accounts: accounts.rows, transactions: transactions.rows, cards: cards.rows, subscriptions: subscriptions.rows, ai: getAIStatus() });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "BANK_CORE_UNAVAILABLE", message: "模拟银行核心暂时不可用" }, { status: 503 });
  }
}
