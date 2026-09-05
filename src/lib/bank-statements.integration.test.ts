import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { getBankStatement } from "./bank-statements";
import { blockSubscription, getBankingOverview } from "./bank-core";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("native banking database integration", () => {
  const customerIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  const cardId = randomUUID();
  const subscriptionId = randomUUID();
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    for (let index = 0; index < 2; index++) {
      await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Integration test',$2)", [customerIds[index], randomUUID()]);
      await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Test','CHECKING','TEST')", [accountIds[index], customerIds[index]]);
    }
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,is_anomaly)
      SELECT $1,'Test merchant','餐饮',-100,'2026-09-10T00:00:00Z'::timestamptz,n=1 FROM generate_series(1,60) n`, [accountIds[0]]);
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES
      ($1,'September boundary','交通',-200,'2026-08-31T16:00:00Z'),
      ($1,'Income','入金',10000,'2026-09-10T00:00:00Z'),
      ($1,'August excluded','餐饮',-90000,'2026-08-31T15:59:59Z'),
      ($1,'October excluded','餐饮',-90000,'2026-09-30T16:00:00Z'),
      ($2,'Other customer','餐饮',-500000,'2026-09-10T00:00:00Z')`, accountIds);
    await query("INSERT INTO cards(id,customer_id,account_id,card_name,masked_no,card_type) VALUES($1,$2,$3,'Test card','TEST','VIRTUAL')", [cardId, customerIds[0], accountIds[0]]);
    await query("INSERT INTO subscriptions(id,customer_id,card_id,merchant_name,amount_minor,billing_cycle,next_charge_at) VALUES($1,$2,$3,'Test subscription',1900,'MONTHLY',now())", [subscriptionId, customerIds[0], cardId]);
  });
  afterAll(async () => {
    // Only fixture IDs are removed; this suite never truncates tables.
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customerIds]);
    await query("DELETE FROM subscriptions WHERE id=$1", [subscriptionId]);
    await query("DELETE FROM cards WHERE id=$1", [cardId]);
    await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customerIds]);
    await db.end();
  });
  it("counts the full month, respects Shanghai boundaries, and excludes another customer", async () => {
    const report = await getBankStatement(customerIds[0], "2026-09");
    expect(report).toMatchObject({ incomeMinor: 10000, expenseMinor: 6200, transactionCount: 62, anomalyCount: 1 });
    expect(report.categories).toEqual([{ category: "餐饮", totalMinor: 6000, count: 60 }, { category: "交通", totalMinor: 200, count: 1 }]);
    expect(report.anomalies).toHaveLength(1);
  });
  it("returns real empty results and rejects invalid months", async () => {
    expect(await getBankStatement(customerIds[0], "2025-01")).toMatchObject({ expenseMinor: 0, transactionCount: 0, categories: [], anomalies: [] });
    await expect(getBankStatement(customerIds[0], "2026-13")).rejects.toThrow("INVALID_STATEMENT_MONTH");
  });
  it("keeps the overview recent limit separate from its complete monthly summary", async () => {
    const overview = await getBankingOverview(customerIds[0]);
    expect(overview.transactions).toHaveLength(50);
    expect(overview.statement).toEqual(await getBankStatement(customerIds[0]));
  });
  it("cannot block another customer's subscription", async () => {
    await expect(blockSubscription(customerIds[1], subscriptionId)).rejects.toThrow("SUBSCRIPTION_NOT_FOUND");
    expect((await query("SELECT status FROM subscriptions WHERE id=$1", [subscriptionId])).rows[0].status).toBe("ACTIVE");
  });
  it("serializes repeated confirmation and records one audit without an Agent task", async () => {
    const results = await Promise.all([blockSubscription(customerIds[0], subscriptionId), blockSubscription(customerIds[0], subscriptionId)]);
    expect(results.map((result) => result.alreadyExecuted).sort()).toEqual([false, true]);
    const audit = await query("SELECT task_id,evidence FROM audit_events WHERE customer_id=$1 AND event_type='SUBSCRIPTION_BLOCKED'", [customerIds[0]]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].task_id).toBeNull();
    expect(audit.rows[0].evidence.merchantSubscriptionCancelled).toBe(false);
    expect((await query("SELECT status FROM subscriptions WHERE id=$1", [subscriptionId])).rows[0].status).toBe("BLOCKED");
  });
});
