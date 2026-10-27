import {
  CONTRACT_TERM_REGISTRY,
  type ContractDeadlineKind,
  type ContractDeadlineState,
  type ContractStatus,
  type ContractTermValueKind,
  type ContractTextStatus,
  type ContractType,
} from "@paperclipai/shared";
import type { ContractParty, ContractTerm } from "../api/contracts";

/**
 * Plain-language words for the Legal screens. Nothing here is a code word:
 * every value the server stores is turned into something the owner can read
 * at a glance, and the same wording is used on the list, the contract page
 * and the forms.
 */

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  rental_lease: "Rental or lease",
  vendor_supplier: "Supplier",
  customer: "Customer",
  employment: "Employment",
  nda: "Confidentiality (NDA)",
  service: "Service",
  loan: "Loan",
  other: "Other",
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "Draft",
  active: "Active",
  expired: "Ended (ran out)",
  terminated: "Ended early",
  superseded: "Replaced by a newer version",
};

export const CONTRACT_TEXT_STATUS_LABELS: Record<ContractTextStatus, string> = {
  pending: "Reading the file…",
  extracted: "Text read from the file",
  no_text_layer: "Scanned file, no readable text",
  failed: "Could not read the file",
};

export const CONTRACT_TEXT_STATUS_HELP: Record<ContractTextStatus, string> = {
  pending: "The file was just added. The words in it are still being read.",
  extracted: "The words in the file were read, so they can be searched and asked about.",
  no_text_layer:
    "This looks like a scan or a photo, so the words could not be read automatically. The assistant can still read the PDF itself when you ask a question.",
  failed: "The file is saved, but its words could not be read. It may be damaged or password protected.",
};

export const DEADLINE_KIND_LABELS: Record<ContractDeadlineKind, string> = {
  notice_extend: "Last day to say you want to extend",
  notice_terminate: "Last day to give notice and end it",
  expiry: "Contract ends",
  renewal: "Renewal",
  price_review: "Price review",
  payment: "Payment due",
  reporting: "Report due",
  other: "Other date",
};

export const DEADLINE_STATE_LABELS: Record<ContractDeadlineState, string> = {
  open: "Open",
  done: "Done",
  dismissed: "Set aside",
  superseded: "Moved to a newer version",
};

export const TERM_VALUE_KIND_LABELS: Record<ContractTermValueKind, string> = {
  number: "A number",
  text: "Some words",
  bool: "Yes or no",
  not_mentioned: "Not mentioned in the contract",
  explicitly_none: "The contract says there is none",
};

/** Contracts that no longer run: kept on file, but not worth a reminder. */
export function isContractLive(status: ContractStatus): boolean {
  return status === "draft" || status === "active";
}

export function termLabel(key: string): string {
  const known = CONTRACT_TERM_REGISTRY.find((entry) => entry.key === key);
  if (known) return known.label;
  const spaced = key.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

export function formatTermValue(term: ContractTerm): string {
  switch (term.valueKind) {
    case "not_mentioned":
      return "Not mentioned in the contract";
    case "explicitly_none":
      return "The contract says there is none";
    case "bool":
      return term.boolValue === true ? "Yes" : term.boolValue === false ? "No" : "Not filled in";
    case "text":
      return term.textValue?.trim() ? term.textValue : "Not filled in";
    case "number": {
      if (term.numberValue === null || term.numberValue === undefined || term.numberValue === "") {
        return "Not filled in";
      }
      const value = Number(term.numberValue);
      if (!Number.isFinite(value)) return "Not filled in";
      const formatted = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 }).format(value);
      return term.currency ? `${formatted} ${term.currency.toUpperCase()}` : formatted;
    }
    default:
      return "Not filled in";
  }
}

export function partyDisplayName(party: ContractParty, organisationNames: Map<string, string>): string {
  const fromCrm = party.organizationId ? organisationNames.get(party.organizationId) : undefined;
  return fromCrm ?? party.name?.trim() ?? "Unnamed party";
}

// ---------------------------------------------------------------- dates

/** Contract dates are plain calendar days (YYYY-MM-DD); read them as local days so no time zone shifts them. */
function parseDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(parseDay(value));
}

export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function addDaysIso(days: number, now: Date = new Date()): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return todayIso(next);
}

export function daysUntil(value: string, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseDay(value).getTime() - today.getTime()) / 86_400_000);
}

/** "in 12 days", "tomorrow", "today", "3 days ago". */
export function describeDaysUntil(value: string, now: Date = new Date()): string {
  const days = daysUntil(value, now);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${-days} days ago`;
}

/** A deadline counts as "coming up" when it is overdue or within this many days. */
export const DEADLINE_SOON_DAYS = 30;
