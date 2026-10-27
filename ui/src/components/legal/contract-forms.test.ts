import { describe, expect, it } from "vitest";
import { upsertContractTermSchema, createContractDeadlineSchema } from "@paperclipai/shared";
import type { ContractDetail } from "../../api/contracts";
import {
  OTHER_TERM,
  deadlineInputFromDraft,
  deadlineProblem,
  emptyDeadlineDraft,
  emptyTermDraft,
  factsDraftFromContract,
  factsProblem,
  factsUpdate,
  parseRemindDays,
  termInputFromDraft,
  termKeyFromDraft,
  termKeyFromName,
  termProblem,
} from "./contract-forms";

const contract: ContractDetail = {
  id: "c1",
  companyId: "co",
  title: "Office lease",
  type: "rental_lease",
  status: "active",
  assetId: null,
  textStatus: "extracted",
  language: "Norwegian",
  governingLaw: null,
  effectiveDate: "2025-01-01",
  expiryDate: "2027-12-31",
  autoRenewal: null,
  noticePeriodDays: 90,
  summary: "Three years.",
  supersedesContractId: null,
  versionNo: 1,
  changeSummary: null,
  createdByAgentId: null,
  createdByUserId: null,
  sourceIssueId: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  parties: [],
  deadlines: [],
  terms: [],
};

describe("contract forms", () => {
  it("sends only the details that changed, and clears emptied ones", () => {
    const draft = factsDraftFromContract(contract);
    expect(factsUpdate(contract, draft)).toEqual({});
    expect(
      factsUpdate(contract, { ...draft, title: " Office lease, Oslo ", expiryDate: "", autoRenewal: "yes", noticePeriodDays: "" }),
    ).toEqual({ title: "Office lease, Oslo", expiryDate: null, autoRenewal: true, noticePeriodDays: null });
  });

  it("never sends a status change for a contract a newer version replaced", () => {
    const replaced = { ...contract, status: "superseded" as const };
    expect(factsUpdate(replaced, { ...factsDraftFromContract(replaced), status: "active" })).toEqual({});
  });

  it("explains a bad notice period or end date in plain words", () => {
    const draft = factsDraftFromContract(contract);
    expect(factsProblem({ ...draft, noticePeriodDays: "abc" })).toMatch(/whole number of days/);
    expect(factsProblem({ ...draft, expiryDate: "2024-01-01" })).toMatch(/before the start/);
    expect(factsProblem({ ...draft, title: " " })).toMatch(/name/);
    expect(factsProblem(draft)).toBeNull();
  });

  it("turns a typed term name into a stored key", () => {
    expect(termKeyFromName("Cleaning fee (NOK)")).toBe("cleaning_fee_nok");
    expect(termKeyFromName("  3 months free ")).toBe("months_free");
    expect(termKeyFromName("!!!")).toBe("");
    expect(termKeyFromDraft({ ...emptyTermDraft(), choice: OTHER_TERM, customName: "Cleaning fee" })).toBe("cleaning_fee");
    expect(termKeyFromDraft({ ...emptyTermDraft(), choice: "notice_period_days" })).toBe("notice_period_days");
  });

  it("builds a term the server accepts for every kind of answer", () => {
    const base = { ...emptyTermDraft(), clauseRef: " 4.2 ", pageRef: "" };
    const inputs = [
      termInputFromDraft({ ...base, valueKind: "number", number: "12.5", currency: "nok" }),
      termInputFromDraft({ ...base, valueKind: "number", number: "30", currency: "" }),
      termInputFromDraft({ ...base, valueKind: "text", text: " Norwegian law " }),
      termInputFromDraft({ ...base, valueKind: "bool", bool: "no" }),
      termInputFromDraft({ ...base, valueKind: "not_mentioned", text: "left over", number: "9" }),
      termInputFromDraft({ ...base, valueKind: "explicitly_none", bool: "yes" }),
    ];
    for (const input of inputs) expect(upsertContractTermSchema.safeParse(input).success).toBe(true);
    expect(inputs[0]).toMatchObject({ numberValue: 12.5, currency: "NOK", clauseRef: "4.2", pageRef: null });
    expect(inputs[3]).toMatchObject({ valueKind: "bool", boolValue: false });
    expect(inputs[4]).toEqual({ valueKind: "not_mentioned", clauseRef: "4.2", pageRef: null });
  });

  it("asks for the missing piece of a term", () => {
    const base = emptyTermDraft();
    expect(termProblem({ ...base, valueKind: "number", number: "" })).toMatch(/number/);
    expect(termProblem({ ...base, valueKind: "number", number: "5", currency: "kroner" })).toMatch(/three letters/);
    expect(termProblem({ ...base, valueKind: "text", text: " " })).toMatch(/what the contract says/i);
    expect(termProblem({ ...base, choice: OTHER_TERM, customName: "", valueKind: "bool" })).toMatch(/which term/i);
    expect(termProblem({ ...base, valueKind: "not_mentioned" })).toBeNull();
  });

  it("reads reminder days from plain text", () => {
    expect(parseRemindDays("")).toBe("default");
    expect(parseRemindDays("60, 30, 7")).toEqual([60, 30, 7]);
    expect(parseRemindDays("7 30 60")).toEqual([60, 30, 7]);
    expect(parseRemindDays("60 and 30")).toEqual([60, 30]);
    expect(parseRemindDays("soon")).toBeNull();
    expect(parseRemindDays("-5")).toBeNull();
  });

  it("builds a date the server accepts, using the usual reminders when none are given", () => {
    const draft = { ...emptyDeadlineDraft(), dueDate: "2027-06-30", clauseRef: "9" };
    const usual = deadlineInputFromDraft(draft);
    expect(usual).not.toHaveProperty("leadTimesDays");
    expect(createContractDeadlineSchema.safeParse(usual).success).toBe(true);
    const custom = deadlineInputFromDraft({ ...draft, remindDays: "90, 30" });
    expect(custom.leadTimesDays).toEqual([90, 30]);
    expect(createContractDeadlineSchema.safeParse(custom).success).toBe(true);
    expect(deadlineProblem({ ...draft, dueDate: "" })).toMatch(/date/i);
    expect(deadlineProblem({ ...draft, remindDays: "x" })).toMatch(/reminder days/i);
  });
});
