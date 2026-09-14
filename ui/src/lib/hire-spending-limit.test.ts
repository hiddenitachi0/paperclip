// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS } from "@paperclipai/shared";
import {
  DEFAULT_SPENDING_LIMIT_DOLLARS_TEXT,
  resolveSpendingLimitChoice,
  spendingLimitSummary,
} from "./hire-spending-limit";

// DUR-3976: the monthly spending limit on the employment form.
describe("monthly spending limit on the employment form", () => {
  it("is pre-filled with the standard $50, and that is what gets sent", () => {
    expect(DEFAULT_SPENDING_LIMIT_DOLLARS_TEXT).toBe("50");
    expect(
      resolveSpendingLimitChoice({ dollarsText: DEFAULT_SPENDING_LIMIT_DOLLARS_TEXT, noLimit: false }),
    ).toEqual({ ok: true, cents: DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS });
  });

  it("accepts dollars and stores cents", () => {
    expect(resolveSpendingLimitChoice({ dollarsText: "300", noLimit: false })).toEqual({ ok: true, cents: 30000 });
    expect(resolveSpendingLimitChoice({ dollarsText: " $125.50 ", noLimit: false })).toEqual({ ok: true, cents: 12550 });
    expect(resolveSpendingLimitChoice({ dollarsText: "1,000", noLimit: false })).toEqual({ ok: true, cents: 100000 });
  });

  // The choice this ticket asked to be made deliberately: an empty box or a 0
  // must never quietly become "no limit".
  it("refuses an empty box instead of hiring with no limit", () => {
    const choice = resolveSpendingLimitChoice({ dollarsText: "", noLimit: false });
    expect(choice.ok).toBe(false);
  });

  it("refuses 0 instead of hiring with no limit", () => {
    expect(resolveSpendingLimitChoice({ dollarsText: "0", noLimit: false }).ok).toBe(false);
    expect(resolveSpendingLimitChoice({ dollarsText: "0.00", noLimit: false }).ok).toBe(false);
    expect(resolveSpendingLimitChoice({ dollarsText: "0.001", noLimit: false }).ok).toBe(false);
  });

  it("refuses something that is not an amount", () => {
    expect(resolveSpendingLimitChoice({ dollarsText: "fifty", noLimit: false }).ok).toBe(false);
    expect(resolveSpendingLimitChoice({ dollarsText: "-5", noLimit: false }).ok).toBe(false);
    expect(resolveSpendingLimitChoice({ dollarsText: "99999999999", noLimit: false }).ok).toBe(false);
  });

  it("sends no limit only when the separate 'No monthly limit' box is ticked", () => {
    expect(resolveSpendingLimitChoice({ dollarsText: "", noLimit: true })).toEqual({ ok: true, cents: 0 });
    expect(resolveSpendingLimitChoice({ dollarsText: "50", noLimit: true })).toEqual({ ok: true, cents: 0 });
  });

  it("describes the choice in one line", () => {
    expect(spendingLimitSummary(5000)).toBe("Up to $50.00 a month");
    expect(spendingLimitSummary(0)).toBe("No monthly limit");
  });
});
