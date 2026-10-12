import { describe, expect, it } from "vitest";
import { checkReportCommentaryNumbers } from "./report-number-check.js";

describe("checkReportCommentaryNumbers", () => {
  it("passes commentary whose numbers all appear in the script output", () => {
    const numbers = { totalSales: 150, orderCount: 2, growthPercent: 12.5 };
    const result = checkReportCommentaryNumbers("Sales were 150 kroner across 2 orders, up 12.5% on last month.", numbers);
    expect(result.ok).toBe(true);
    expect(result.ungrounded).toEqual([]);
  });

  it("flags a number the agent invented that is not in the output", () => {
    const numbers = { totalSales: 150, orderCount: 2 };
    const result = checkReportCommentaryNumbers("Sales were 999 kroner across 2 orders.", numbers);
    expect(result.ok).toBe(false);
    expect(result.ungrounded).toContain("999");
  });

  it("flags every number when the agent writes free-hand arithmetic not in the output", () => {
    const numbers = { totalSales: 100 };
    const result = checkReportCommentaryNumbers("That is up 50% from 66.67 last month.", numbers);
    expect(result.ok).toBe(false);
  });

  it("passes empty commentary against any output (nothing to check)", () => {
    expect(checkReportCommentaryNumbers("", { a: 1 }).ok).toBe(true);
  });

  it("handles a null or primitive script output without throwing", () => {
    expect(checkReportCommentaryNumbers("5 returns", null).ok).toBe(false);
    expect(checkReportCommentaryNumbers("5 returns", 5).ok).toBe(true);
  });
});
