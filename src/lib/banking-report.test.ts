import { describe, expect, it } from "vitest";
import { currentBankMonth, validBankMonth } from "./banking-report";

describe("bank statement calendar", () => {
  it("uses Shanghai month boundaries even on a UTC server", () => {
    expect(currentBankMonth(new Date("2026-08-31T15:59:59Z"))).toBe("2026-08");
    expect(currentBankMonth(new Date("2026-08-31T16:00:00Z"))).toBe("2026-09");
    expect(currentBankMonth(new Date("2026-12-31T16:00:00Z"))).toBe("2027-01");
  });
  it("rejects malformed and out-of-range months before querying", () => {
    for (const month of ["2026-00", "2026-13", "2026-9", "2026-09-01", "invalid", ""]) expect(validBankMonth(month)).toBe(false);
    expect(validBankMonth("2026-09")).toBe(true);
  });
});
