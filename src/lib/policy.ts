export type RiskLevel = "GREEN" | "YELLOW" | "RED";

export type TransferRiskInput = {
  amountMinor: number;
  dailyTotalMinor: number;
  trustedBeneficiary: boolean;
  trustedDevice?: boolean;
  failedAuthAttempts?: number;
};

const rank: Record<RiskLevel, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

export function maxRisk(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce((highest, level) =>
    rank[level] > rank[highest] ? level : highest,
  "GREEN");
}

export function evaluateTransferRisk(input: TransferRiskInput) {
  const matchedRules: string[] = ["TRANSFER_IS_WRITE_OPERATION"];
  const levels: RiskLevel[] = ["YELLOW"];

  if (input.dailyTotalMinor + input.amountMinor > 100_000) {
    levels.push("RED");
    matchedRules.push("DAILY_TRANSFER_TOTAL_OVER_1000_CNY");
  }
  if (!input.trustedBeneficiary) {
    matchedRules.push("NEW_BENEFICIARY_MONITORED");
  }
  if (input.trustedDevice === false) {
    levels.push("RED");
    matchedRules.push("UNTRUSTED_DEVICE");
  }
  if ((input.failedAuthAttempts ?? 0) >= 3) {
    levels.push("RED");
    matchedRules.push("AUTH_FAILURE_FUSE_ACTIVE");
  }

  const finalLevel = maxRisk(...levels);
  return {
    baseLevel: "YELLOW" as const,
    finalLevel,
    requiredAuth: (finalLevel === "RED" ? "MFA" : "CONFIRM") as "MFA" | "CONFIRM",
    matchedRules,
  };
}

export function formatMinor(amountMinor: number, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}
