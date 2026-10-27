import {
  CONTRACT_TERM_REGISTRY,
  type ContractDeadlineKind,
  type ContractStatus,
  type ContractTermValueKind,
  type ContractType,
  type CreateContractDeadline,
  type UpdateContract,
  type UpsertContractTerm,
} from "@paperclipai/shared";
import type { ContractDeadline, ContractDetail, ContractTerm } from "../../api/contracts";

/** Turning what someone typed into what the server accepts, in one tested place. */

// ---------------------------------------------------------------- the contract itself

export type TriState = "unknown" | "yes" | "no";

export interface ContractFactsDraft {
  title: string;
  type: ContractType;
  status: ContractStatus;
  effectiveDate: string;
  expiryDate: string;
  autoRenewal: TriState;
  noticePeriodDays: string;
  governingLaw: string;
  language: string;
  summary: string;
}

export function factsDraftFromContract(contract: ContractDetail): ContractFactsDraft {
  return {
    title: contract.title,
    type: contract.type,
    status: contract.status,
    effectiveDate: contract.effectiveDate ?? "",
    expiryDate: contract.expiryDate ?? "",
    autoRenewal: contract.autoRenewal === true ? "yes" : contract.autoRenewal === false ? "no" : "unknown",
    noticePeriodDays: contract.noticePeriodDays === null ? "" : String(contract.noticePeriodDays),
    governingLaw: contract.governingLaw ?? "",
    language: contract.language ?? "",
    summary: contract.summary ?? "",
  };
}

export function factsProblem(draft: ContractFactsDraft): string | null {
  if (!draft.title.trim()) return "Give the contract a name.";
  if (draft.noticePeriodDays.trim() !== "") {
    const days = Number(draft.noticePeriodDays);
    if (!Number.isInteger(days) || days < 0) return "The notice period must be a whole number of days.";
  }
  if (draft.effectiveDate && draft.expiryDate && draft.expiryDate < draft.effectiveDate) {
    return "The end date cannot be before the start date.";
  }
  return null;
}

/** Only what changed is sent, and a contract that has been replaced keeps its status. */
export function factsUpdate(before: ContractDetail, draft: ContractFactsDraft): UpdateContract {
  const original = factsDraftFromContract(before);
  const out: UpdateContract = {};
  if (draft.title.trim() !== original.title) out.title = draft.title.trim();
  if (draft.type !== original.type) out.type = draft.type;
  if (draft.status !== original.status && before.status !== "superseded" && draft.status !== "superseded") {
    out.status = draft.status;
  }
  if (draft.effectiveDate !== original.effectiveDate) out.effectiveDate = draft.effectiveDate || null;
  if (draft.expiryDate !== original.expiryDate) out.expiryDate = draft.expiryDate || null;
  if (draft.autoRenewal !== original.autoRenewal) {
    out.autoRenewal = draft.autoRenewal === "yes" ? true : draft.autoRenewal === "no" ? false : null;
  }
  if (draft.noticePeriodDays.trim() !== original.noticePeriodDays) {
    out.noticePeriodDays = draft.noticePeriodDays.trim() === "" ? null : Number(draft.noticePeriodDays);
  }
  if (draft.governingLaw.trim() !== original.governingLaw) out.governingLaw = draft.governingLaw.trim() || null;
  if (draft.language.trim() !== original.language) out.language = draft.language.trim() || null;
  if (draft.summary.trim() !== original.summary.trim()) out.summary = draft.summary.trim() || null;
  return out;
}

// ---------------------------------------------------------------- key terms

export const OTHER_TERM = "__other__";

export interface TermDraft {
  /** A well-known key, or OTHER_TERM when `customName` names it. */
  choice: string;
  customName: string;
  valueKind: ContractTermValueKind;
  number: string;
  currency: string;
  text: string;
  bool: "yes" | "no";
  clauseRef: string;
  pageRef: string;
}

export const WELL_KNOWN_TERM_CHOICES = CONTRACT_TERM_REGISTRY.map((entry) => ({ key: entry.key, label: entry.label }));

export function emptyTermDraft(): TermDraft {
  return {
    choice: WELL_KNOWN_TERM_CHOICES[0]!.key,
    customName: "",
    valueKind: "text",
    number: "",
    currency: "",
    text: "",
    bool: "yes",
    clauseRef: "",
    pageRef: "",
  };
}

export function termDraftFromTerm(term: ContractTerm): TermDraft {
  const known = CONTRACT_TERM_REGISTRY.some((entry) => entry.key === term.key);
  return {
    choice: known ? term.key : OTHER_TERM,
    customName: known ? "" : term.key,
    valueKind: term.valueKind,
    number: term.numberValue ?? "",
    currency: term.currency ?? "",
    text: term.textValue ?? "",
    bool: term.boolValue === false ? "no" : "yes",
    clauseRef: term.clauseRef ?? "",
    pageRef: term.pageRef ?? "",
  };
}

/** "Payment terms (days)" -> "payment_terms_days": the stored key is lowercase letters, digits and underscores. */
export function termKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[0-9_]+/, "")
    .slice(0, 64)
    .replace(/_+$/, "");
}

export function termKeyFromDraft(draft: TermDraft): string {
  return draft.choice === OTHER_TERM ? termKeyFromName(draft.customName) : draft.choice;
}

export function termProblem(draft: TermDraft): string | null {
  if (!termKeyFromDraft(draft)) return "Say which term this is.";
  if (draft.valueKind === "number") {
    if (draft.number.trim() === "" || !Number.isFinite(Number(draft.number))) return "Enter the number the contract states.";
    if (draft.currency.trim() !== "" && !/^[A-Za-z]{3}$/.test(draft.currency.trim())) {
      return "Write the currency as three letters, for example NOK.";
    }
  }
  if (draft.valueKind === "text" && !draft.text.trim()) return "Write what the contract says.";
  return null;
}

export function termInputFromDraft(draft: TermDraft): UpsertContractTerm {
  const where = {
    clauseRef: draft.clauseRef.trim() || null,
    pageRef: draft.pageRef.trim() || null,
  };
  switch (draft.valueKind) {
    case "number":
      return { valueKind: "number", numberValue: Number(draft.number), currency: draft.currency.trim().toUpperCase() || null, ...where };
    case "text":
      return { valueKind: "text", textValue: draft.text.trim(), ...where };
    case "bool":
      return { valueKind: "bool", boolValue: draft.bool === "yes", ...where };
    default:
      return { valueKind: draft.valueKind, ...where };
  }
}

// ---------------------------------------------------------------- dates that matter

export interface DeadlineDraft {
  kind: ContractDeadlineKind;
  dueDate: string;
  remindDays: string;
  clauseRef: string;
  note: string;
}

export function emptyDeadlineDraft(): DeadlineDraft {
  return { kind: "notice_terminate", dueDate: "", remindDays: "", clauseRef: "", note: "" };
}

export function deadlineDraftFromDeadline(deadline: ContractDeadline): DeadlineDraft {
  return {
    kind: deadline.kind,
    dueDate: deadline.dueDate,
    remindDays: deadline.leadTimesDays.join(", "),
    clauseRef: deadline.clauseRef ?? "",
    note: deadline.note ?? "",
  };
}

/** "60, 30 and 7" -> [60, 30, 7]; null when the text is not a list of whole days. Empty means "use the usual reminders". */
export function parseRemindDays(text: string): number[] | null | "default" {
  const trimmed = text.trim();
  if (!trimmed) return "default";
  const parts = trimmed.split(/[\s,;]+|\band\b/i).filter(Boolean);
  const days = parts.map(Number);
  if (days.length === 0 || days.length > 12) return null;
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 3650)) return null;
  return [...new Set(days)].sort((a, b) => b - a);
}

export function deadlineProblem(draft: DeadlineDraft): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) return "Pick the date.";
  if (parseRemindDays(draft.remindDays) === null) {
    return "Write the reminder days as whole numbers, for example 60, 30, 7.";
  }
  return null;
}

export function deadlineInputFromDraft(draft: DeadlineDraft): CreateContractDeadline {
  const days = parseRemindDays(draft.remindDays);
  return {
    kind: draft.kind,
    dueDate: draft.dueDate,
    ...(Array.isArray(days) ? { leadTimesDays: days } : {}),
    clauseRef: draft.clauseRef.trim() || null,
    note: draft.note.trim() || null,
  };
}

export function describeRemindDays(days: number[]): string {
  if (days.length === 0) return "No reminders";
  const sorted = [...days].sort((a, b) => b - a);
  return `Reminders ${sorted.join(", ")} days before`;
}
