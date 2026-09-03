import { describe, expect, it } from "vitest";
import { evaluateTransferRisk, maxRisk } from "./policy";

describe("transfer policy", () => {
  it("requires confirmation for a trusted low-value transfer", () => {
    const result = evaluateTransferRisk({
      amountMinor: 50_000,
      dailyTotalMinor: 0,
      trustedBeneficiary: true,
      trustedDevice: true,
    });
    expect(result.finalLevel).toBe("YELLOW");
    expect(result.requiredAuth).toBe("CONFIRM");
  });

  it("monitors a new recipient without bypassing the stated small-transfer tier", () => {
    const result = evaluateTransferRisk({
      amountMinor: 8_800,
      dailyTotalMinor: 0,
      trustedBeneficiary: false,
      trustedDevice: true,
    });
    expect(result.finalLevel).toBe("YELLOW");
    expect(result.matchedRules).toContain("NEW_BENEFICIARY_MONITORED");
  });

  it("uses the cumulative daily amount rather than the single transfer", () => {
    const result = evaluateTransferRisk({
      amountMinor: 20_000,
      dailyTotalMinor: 90_000,
      trustedBeneficiary: true,
      trustedDevice: true,
    });
    expect(result.finalLevel).toBe("RED");
    expect(result.matchedRules).toContain("DAILY_TRANSFER_TOTAL_OVER_1000_CNY");
  });

  it("never lets a lower level downgrade a higher one", () => {
    expect(maxRisk("RED", "GREEN", "YELLOW")).toBe("RED");
  });
});
