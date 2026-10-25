import { describe, expect, it } from "vitest";
import { aggregateTermRows, type TermRowForAggregation } from "../services/contracts.js";

const filters = { type: null, statuses: ["active" as const], partyOrganizationId: null };

let seq = 0;
function id() {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function num(value: number | string | null, currency: string | null = "NOK", clauseRef: string | null = null): TermRowForAggregation {
  return {
    contractId: id(),
    term: { valueKind: "number", numberValue: value, currency, textValue: null, boolValue: null, clauseRef },
  };
}
function kind(valueKind: string, clauseRef: string | null = null): TermRowForAggregation {
  return {
    contractId: id(),
    term: { valueKind, numberValue: null, currency: null, textValue: null, boolValue: null, clauseRef },
  };
}
const none = (): TermRowForAggregation => ({ contractId: id(), term: null });

describe("aggregateTermRows", () => {
  it("averages only real numeric values", () => {
    const result = aggregateTermRows("free_shipping_threshold", filters, [num(100), num("300.000000"), num(200)]);
    expect(result.numeric).toHaveLength(1);
    expect(result.numeric[0]).toMatchObject({ currency: "NOK", count: 3, avg: 200, min: 100, max: 300 });
    expect(result.withValue.count).toBe(3);
  });

  it("never lets not_mentioned, explicitly_none or missing rows pull the average toward zero", () => {
    const rows = [num(1000), num(3000), kind("not_mentioned"), kind("explicitly_none"), none(), none()];
    const result = aggregateTermRows("liability_cap", filters, rows);
    expect(result.numeric[0]).toMatchObject({ count: 2, avg: 2000, min: 1000, max: 3000 });
    expect(result.notMentioned.count).toBe(1);
    expect(result.explicitlyNone.count).toBe(1);
    expect(result.noTermRecorded.count).toBe(2);
    expect(result.totalContracts).toBe(6);
  });

  it("keeps a stray number on a not_mentioned / explicitly_none row out of the statistics", () => {
    const stray = (valueKind: string): TermRowForAggregation => ({
      contractId: id(),
      term: { valueKind, numberValue: "0", currency: "NOK", textValue: null, boolValue: null, clauseRef: null },
    });
    const result = aggregateTermRows("liability_cap", filters, [num(500), stray("not_mentioned"), stray("explicitly_none")]);
    expect(result.numeric[0]).toMatchObject({ count: 1, avg: 500, min: 500, max: 500 });
    expect(result.notMentioned.count).toBe(1);
    expect(result.explicitlyNone.count).toBe(1);
  });

  it("reports a genuine zero as a value, not as missing", () => {
    const result = aggregateTermRows("payment_terms_days", filters, [num(0, null), num(30, null)]);
    expect(result.numeric[0]).toMatchObject({ currency: null, count: 2, avg: 15, min: 0, max: 30 });
    expect(result.noTermRecorded.count).toBe(0);
  });

  it("never mixes currencies in one average", () => {
    const result = aggregateTermRows("free_shipping_threshold", filters, [
      num(100, "NOK"),
      num(300, "nok"),
      num(10, "EUR"),
      num(20, "EUR"),
      num(5, null),
    ]);
    expect(result.numeric.map((entry) => entry.currency)).toEqual([null, "EUR", "NOK"]);
    const byCurrency = Object.fromEntries(result.numeric.map((entry) => [String(entry.currency), entry]));
    expect(byCurrency.NOK).toMatchObject({ count: 2, avg: 200 });
    expect(byCurrency.EUR).toMatchObject({ count: 2, avg: 15 });
    expect(byCurrency.null).toMatchObject({ count: 1, avg: 5 });
  });

  it("puts a number row without a usable number in malformed, never in the average", () => {
    const rows = [num(10), num(null), num("not-a-number"), num("NaN"), num("Infinity")];
    const result = aggregateTermRows("x", filters, rows);
    expect(result.numeric[0]).toMatchObject({ count: 1, avg: 10 });
    expect(result.malformed.count).toBe(4);
  });

  it("counts text and bool values as values but not as numeric", () => {
    const text: TermRowForAggregation = {
      contractId: id(),
      term: { valueKind: "text", numberValue: null, currency: null, textValue: "CPI", boolValue: null, clauseRef: "7.2" },
    };
    const bool: TermRowForAggregation = {
      contractId: id(),
      term: { valueKind: "bool", numberValue: null, currency: null, textValue: null, boolValue: false, clauseRef: null },
    };
    const emptyText: TermRowForAggregation = {
      contractId: id(),
      term: { valueKind: "text", numberValue: null, currency: null, textValue: "  ", boolValue: null, clauseRef: null },
    };
    const emptyBool: TermRowForAggregation = {
      contractId: id(),
      term: { valueKind: "bool", numberValue: null, currency: null, textValue: null, boolValue: null, clauseRef: null },
    };
    const result = aggregateTermRows("price_indexation", filters, [text, bool, emptyText, emptyBool]);
    expect(result.numeric).toEqual([]);
    expect(result.withValue.count).toBe(2);
    expect(result.malformed.count).toBe(2);
  });

  it("treats an unknown value kind as malformed", () => {
    const result = aggregateTermRows("x", filters, [kind("bogus")]);
    expect(result.malformed.count).toBe(1);
    expect(result.withValue.count).toBe(0);
  });

  it("lists contract ids with clause refs in every bucket, and the buckets add up to the total", () => {
    const a = num(100, "NOK", "4.1");
    const b = kind("not_mentioned");
    const c = kind("explicitly_none", "9.3");
    const d = none();
    const e = num(null);
    const result = aggregateTermRows("k", filters, [a, b, c, d, e]);
    expect(result.withValue.contracts).toEqual([{ contractId: a.contractId, clauseRef: "4.1" }]);
    expect(result.explicitlyNone.contracts).toEqual([{ contractId: c.contractId, clauseRef: "9.3" }]);
    expect(result.notMentioned.contracts).toEqual([{ contractId: b.contractId, clauseRef: null }]);
    expect(result.noTermRecorded.contracts).toEqual([{ contractId: d.contractId, clauseRef: null }]);
    expect(result.malformed.count).toBe(1);
    expect(result.numeric[0].contracts).toEqual([{ contractId: a.contractId, clauseRef: "4.1" }]);
    const sum =
      result.withValue.count +
      result.notMentioned.count +
      result.explicitlyNone.count +
      result.noTermRecorded.count +
      result.malformed.count;
    expect(sum).toBe(result.totalContracts);
  });

  it("returns no numeric stats (not NaN or 0) when nothing has a number", () => {
    const result = aggregateTermRows("k", filters, [kind("not_mentioned"), none()]);
    expect(result.numeric).toEqual([]);
    const empty = aggregateTermRows("k", filters, []);
    expect(empty.numeric).toEqual([]);
    expect(empty.totalContracts).toBe(0);
  });

  it("handles decimals without float noise", () => {
    const result = aggregateTermRows("k", filters, [num("0.1", null), num("0.2", null)]);
    expect(result.numeric[0].avg).toBe(0.15);
  });

  it("echoes the filters it covered", () => {
    const result = aggregateTermRows("k", { type: "vendor_supplier", statuses: ["active", "expired"], partyOrganizationId: null }, []);
    expect(result.filters).toEqual({ type: "vendor_supplier", statuses: ["active", "expired"], partyOrganizationId: null });
  });
});
