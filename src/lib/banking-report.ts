export function currentBankMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
}

export function validBankMonth(month: string) {
  return /^(?:[2-8]\d{3}|9[0-8]\d{2})-(?:0[1-9]|1[0-2])$/.test(month);
}

export type BankStatement = {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  transactionCount: number;
  anomalyCount: number;
  categories: Array<{ category: string; totalMinor: number; count: number }>;
  anomalies: Array<{ id: string; merchantName: string; amountMinor: number; occurredAt: string }>;
};

export type BankSubscription = {
  id: string; merchant_name: string; amount_minor: string; billing_cycle: string;
  next_charge_at: string; status: string;
};
