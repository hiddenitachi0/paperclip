import { describe, expect, it } from "vitest";
import type { ContractTerm } from "../api/contracts";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TEXT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DEADLINE_KIND_LABELS,
  DEADLINE_STATE_LABELS,
  TERM_VALUE_KIND_LABELS,
  addDaysIso,
  daysUntil,
  describeDaysUntil,
  formatDay,
  formatTermValue,
  termLabel,
  todayIso,
} from "./contract-labels";
import {
  CONTRACT_DEADLINE_KINDS,
  CONTRACT_DEADLINE_STATES,
  CONTRACT_STATUSES,
  CONTRACT_TERM_VALUE_KINDS,
  CONTRACT_TEXT_STATUSES,
  CONTRACT_TYPES,
} from "@paperclipai/shared";

const term = (over: Partial<ContractTerm>): ContractTerm => ({
  id: "t",
  companyId: "c",
  contractId: "k",
  key: "notice_period_days",
  valueKind: "number",
  numberValue: null,
  currency: null,
  textValue: null,
  boolValue: null,
  clauseRef: null,
  pageRef: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("contract labels", () => {
  it("has a plain-language label for every stored value, and none look like code", () => {
    const all = [
      ...CONTRACT_TYPES.map((v) => CONTRACT_TYPE_LABELS[v]),
      ...CONTRACT_STATUSES.map((v) => CONTRACT_STATUS_LABELS[v]),
      ...CONTRACT_TEXT_STATUSES.map((v) => CONTRACT_TEXT_STATUS_LABELS[v]),
      ...CONTRACT_DEADLINE_KINDS.map((v) => DEADLINE_KIND_LABELS[v]),
      ...CONTRACT_DEADLINE_STATES.map((v) => DEADLINE_STATE_LABELS[v]),
      ...CONTRACT_TERM_VALUE_KINDS.map((v) => TERM_VALUE_KIND_LABELS[v]),
    ];
    for (const label of all) {
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/_/);
    }
  });

  it("names well-known terms and tidies free-form ones", () => {
    expect(termLabel("notice_period_days")).toBe("Notice period (days)");
    expect(termLabel("cleaning_fee")).toBe("Cleaning fee");
  });

  it("never turns 'not mentioned' into a zero", () => {
    expect(formatTermValue(term({ valueKind: "not_mentioned" }))).toBe("Not mentioned in the contract");
    expect(formatTermValue(term({ valueKind: "explicitly_none" }))).toBe("The contract says there is none");
    expect(formatTermValue(term({ valueKind: "number", numberValue: null }))).toBe("Not filled in");
    expect(formatTermValue(term({ valueKind: "number", numberValue: "2500.000000", currency: "nok" }))).toBe("2,500 NOK");
    expect(formatTermValue(term({ valueKind: "bool", boolValue: false }))).toBe("No");
    expect(formatTermValue(term({ valueKind: "text", textValue: "Norwegian law" }))).toBe("Norwegian law");
  });

  it("counts days as whole calendar days", () => {
    const now = new Date(2026, 9, 27, 18, 30);
    expect(todayIso(now)).toBe("2026-10-27");
    expect(addDaysIso(30, now)).toBe("2026-11-26");
    expect(daysUntil("2026-10-27", now)).toBe(0);
    expect(describeDaysUntil("2026-10-28", now)).toBe("tomorrow");
    expect(describeDaysUntil("2026-12-01", now)).toBe("in 35 days");
    expect(describeDaysUntil("2026-10-20", now)).toBe("7 days ago");
    expect(formatDay(null)).toBe("Not set");
    expect(formatDay("2026-10-27")).toMatch(/27 Oct 2026/);
  });
});
