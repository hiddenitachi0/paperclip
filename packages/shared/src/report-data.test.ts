import { describe, expect, it } from "vitest";
import { reportDataQuerySchema, reportDatasetsForKind, resolveReportPeriod } from "./report-data.js";

describe("DUR-4072 PR3 report data query", () => {
  const today = { year: 2026, month: 10, day: 10 };

  it("resolves period tokens to whole dates in the given calendar", () => {
    expect(resolveReportPeriod("last_month", today)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", months: ["2026-09"], label: "September 2026" });
    expect(resolveReportPeriod("last_quarter", today)).toMatchObject({ from: "2026-07-01", to: "2026-09-30", label: "Q3 2026" });
    expect(resolveReportPeriod("last_quarter", { year: 2026, month: 2, day: 1 })).toMatchObject({ from: "2025-10-01", to: "2025-12-31" });
    expect(resolveReportPeriod("this_year_to_date", today)).toMatchObject({ from: "2026-01-01", to: "2026-10-10" });
    expect(resolveReportPeriod("this_year_to_date", today).months).toHaveLength(10);
    expect(resolveReportPeriod("2024-02", today)).toMatchObject({ to: "2024-02-29" });
    expect(resolveReportPeriod("2026-Q2", today)).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    expect(resolveReportPeriod("2025", today)).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("accepts only fixed datasets with unique names, and no unknown fields", () => {
    expect(reportDataQuerySchema.safeParse({ items: [{ key: "balances", dataset: "fiken_balances" }] }).success).toBe(true);
    expect(reportDataQuerySchema.parse({ items: [{ key: "b", dataset: "fiken_balances" }] }).period).toBe("last_month");
    expect(reportDataQuerySchema.safeParse({ items: [{ key: "a", dataset: "fiken_balances" }, { key: "a", dataset: "fiken_accounts" }] }).success).toBe(false);
    expect(reportDataQuerySchema.safeParse({ items: [{ key: "a", dataset: "fiken_balances", url: "https://evil" }] }).success).toBe(false);
    expect(reportDataQuerySchema.safeParse({ items: [{ key: "a", dataset: "fiken_write" }] }).success).toBe(false);
    expect(reportDataQuerySchema.safeParse({ items: [] }).success).toBe(false);
    expect(reportDataQuerySchema.safeParse({ period: "next_week", items: [{ key: "a", dataset: "fiken_accounts" }] }).success).toBe(false);
  });

  it("offers each kind only its own datasets", () => {
    expect(reportDatasetsForKind("shopify")).toEqual(["shopify_sales"]);
    expect(reportDatasetsForKind("sftp_file")).toEqual(["file"]);
    expect(reportDatasetsForKind("fiken")).toContain("fiken_journal_entries");
    expect(reportDatasetsForKind("woocommerce")).toEqual([]);
  });
});
