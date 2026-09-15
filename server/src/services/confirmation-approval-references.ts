import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import { isUnsupportedDeployLikeKind } from "./deploy-workspace.js";

/**
 * Which board approval(s) an operator confirmation card is about.
 *
 * Agents keep filing a request_confirmation for a decision that already has a
 * request_board_approval card, naming it only in the card's idempotency key
 * (NOR-1437: `confirmation:de50a800:approval:fa9e5228`) and never setting
 * linkedApprovalId, so the operator answering the approval left the card
 * pending forever. This module is the ONE place that answers "which approval
 * does this card name?" — the create-time guard, the decide-time cleanup and
 * the live status the UI shows all go through resolveNamedApprovals, so they
 * cannot drift apart.
 *
 * A card names an approval by, in order of strength:
 *   1. linkedApprovalId (explicit link);
 *   2. a full approval uuid anywhere in idempotencyKey or payload;
 *   3. `approval:<first 8 hex chars>` in idempotencyKey — resolved only inside
 *      the card's own company, and only when exactly one approval there has
 *      that prefix (an ambiguous prefix names nothing).
 * Every lookup is restricted to the card's company: an id or prefix that only
 * matches another company's approval names nothing.
 */

export type ApprovalReferenceSource = "linked" | "id_in_key" | "id_in_payload" | "short_id_in_key";

export interface ConfirmationCardReferenceInput {
  linkedApprovalId?: string | null;
  idempotencyKey?: string | null;
  payload?: unknown;
}

export interface ExtractedApprovalReferences {
  linkedApprovalId: string | null;
  idsInKey: string[];
  idsInPayload: string[];
  shortIdsInKey: string[];
}

export interface NamedApproval {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedAt: Date | null;
  via: ApprovalReferenceSource;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// `approval:fa9e5228`, not preceded by a letter/digit (so "preapproval:" does not
// count) and not the start of a full uuid (that is matched as a full id instead).
const SHORT_APPROVAL_REF_PATTERN = /(?<![0-9a-z])approval:([0-9a-f]{8})(?![0-9a-f]|-[0-9a-f]{4}-)/gi;

function uniqueLower(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.toLowerCase()))];
}

function payloadText(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return "";
  }
}

export function extractApprovalReferences(card: ConfirmationCardReferenceInput): ExtractedApprovalReferences {
  const key = card.idempotencyKey ?? "";
  return {
    linkedApprovalId: card.linkedApprovalId ? card.linkedApprovalId.toLowerCase() : null,
    idsInKey: uniqueLower(key.match(UUID_PATTERN) ?? []),
    idsInPayload: uniqueLower(payloadText(card.payload).match(UUID_PATTERN) ?? []),
    shortIdsInKey: uniqueLower([...key.matchAll(SHORT_APPROVAL_REF_PATTERN)].map((match) => match[1]!)),
  };
}

export function hasAnyApprovalReference(refs: ExtractedApprovalReferences): boolean {
  return Boolean(refs.linkedApprovalId)
    || refs.idsInKey.length > 0
    || refs.idsInPayload.length > 0
    || refs.shortIdsInKey.length > 0;
}

type ApprovalRow = Pick<
  typeof approvals.$inferSelect,
  "id" | "companyId" | "type" | "status" | "payload" | "decisionNote" | "decidedAt"
>;

function toNamedApproval(row: ApprovalRow, via: ApprovalReferenceSource): NamedApproval {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type,
    status: row.status,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    decisionNote: row.decisionNote ?? null,
    decidedAt: row.decidedAt ?? null,
    via,
  };
}

/**
 * Resolve the approvals each card names, for many cards of ONE company in a
 * fixed number of queries. Returns one list per input card, in input order,
 * each list de-duplicated by approval id (strongest source wins).
 */
export async function resolveNamedApprovals(
  db: Pick<Db, "select">,
  companyId: string,
  cards: readonly ConfirmationCardReferenceInput[],
): Promise<NamedApproval[][]> {
  const extracted = cards.map(extractApprovalReferences);
  const fullIds = uniqueLower(extracted.flatMap((refs) => [
    ...(refs.linkedApprovalId ? [refs.linkedApprovalId] : []),
    ...refs.idsInKey,
    ...refs.idsInPayload,
  ]));
  const shortIds = uniqueLower(extracted.flatMap((refs) => refs.shortIdsInKey));

  const columns = {
    id: approvals.id,
    companyId: approvals.companyId,
    type: approvals.type,
    status: approvals.status,
    payload: approvals.payload,
    decisionNote: approvals.decisionNote,
    decidedAt: approvals.decidedAt,
  };

  const byId = new Map<string, ApprovalRow>();
  if (fullIds.length > 0) {
    const rows: ApprovalRow[] = await db
      .select(columns)
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), inArray(approvals.id, fullIds)));
    for (const row of rows) byId.set(row.id.toLowerCase(), row);
  }

  const byShortId = new Map<string, ApprovalRow[]>();
  if (shortIds.length > 0) {
    const rows: ApprovalRow[] = await db
      .select(columns)
      .from(approvals)
      .where(and(
        eq(approvals.companyId, companyId),
        inArray(sql<string>`left(${approvals.id}::text, 8)`, shortIds),
      ));
    for (const row of rows) {
      const prefix = row.id.slice(0, 8).toLowerCase();
      byShortId.set(prefix, [...(byShortId.get(prefix) ?? []), row]);
    }
  }

  return extracted.map((refs) => {
    const named = new Map<string, NamedApproval>();
    const add = (row: ApprovalRow | undefined, via: ApprovalReferenceSource) => {
      if (!row) return;
      const id = row.id.toLowerCase();
      if (!named.has(id)) named.set(id, toNamedApproval(row, via));
    };
    if (refs.linkedApprovalId) add(byId.get(refs.linkedApprovalId), "linked");
    for (const id of refs.idsInKey) add(byId.get(id), "id_in_key");
    for (const id of refs.idsInPayload) add(byId.get(id), "id_in_payload");
    for (const shortId of refs.shortIdsInKey) {
      const matches = byShortId.get(shortId) ?? [];
      // Exactly one approval in this company has the prefix, or it names nothing.
      if (matches.length === 1) add(matches[0], "short_id_in_key");
    }
    return [...named.values()];
  });
}

export function isOpenApprovalStatus(status: string): boolean {
  return status === "pending" || status === "revision_requested";
}

export function isDecidedApprovalStatus(status: string): boolean {
  return status === "approved" || status === "rejected" || status === "cancelled";
}

/**
 * Approvals whose decision must be made on the approval card itself, never
 * through a confirmation card: deciding them through a linked card runs only
 * approvalService().approve() with no route hooks. That skips the deploy/merge
 * guards on the approve route, and for a cross-company instruction the service
 * refuses the decision outright (the failure is swallowed), so the card would
 * close while the approval stayed pending.
 */
export function mustBeDecidedOnApprovalCard(approval: Pick<NamedApproval, "type" | "payload">): boolean {
  if (approval.type !== "request_board_approval") return false;
  const kind = approval.payload?.kind;
  return kind === "deploy"
    || kind === "merge_pr"
    || kind === "cross_company_instruction"
    || isUnsupportedDeployLikeKind(kind);
}

export function describeApprovalForAgent(approval: Pick<NamedApproval, "type" | "payload">): string {
  const kind = approval.payload?.kind;
  if (approval.type === "request_board_approval") {
    if (kind === "deploy" || isUnsupportedDeployLikeKind(kind)) return "a deploy approval";
    if (kind === "merge_pr") return "a merge approval";
    if (kind === "cross_company_instruction") return "a cross-company instruction approval";
  }
  return `a ${approval.type.replace(/_/g, " ")} approval`;
}

export function describeApprovalDecision(status: string): string {
  if (status === "cancelled") return "withdrawn";
  return status;
}

export type ConfirmationCreateDecision =
  | { action: "none" }
  | { action: "refuse_already_decided"; approval: NamedApproval }
  | { action: "refuse_decide_on_approval_card"; approval: NamedApproval };

/**
 * What an AGENT's new confirmation card should do, given the approvals it
 * names. A decided approval wins over an open one. Nothing is ever linked
 * automatically; an explicit linkedApprovalId is left to DUR-29 as before.
 */
export function decideConfirmationCreate(
  named: readonly NamedApproval[],
  explicitLinkedApprovalId: string | null | undefined,
): ConfirmationCreateDecision {
  const decided = named.find((approval) => isDecidedApprovalStatus(approval.status));
  if (decided) return { action: "refuse_already_decided", approval: decided };

  const open = named.filter((approval) => isOpenApprovalStatus(approval.status));
  const onCard = open.find(mustBeDecidedOnApprovalCard);
  if (onCard) return { action: "refuse_decide_on_approval_card", approval: onCard };

  // An explicit linkedApprovalId is DUR-29's own path and behaves as before.
  if (explicitLinkedApprovalId) return { action: "none" };
  // A card that only names a waiting approval (in its key or text) asks again
  // for a decision the approval card already asks for. It is refused rather
  // than auto-linked: answering a linked card decides the approval through
  // approvalService().approve() alone, without the approval's own steps, so a
  // budget override "approved" that way would never raise the budget.
  if (open.length > 0) return { action: "refuse_decide_on_approval_card", approval: open[0]! };
  return { action: "none" };
}

function formatDecidedAt(date: Date | null): string {
  return date ? ` on ${date.toISOString().slice(0, 10)}` : "";
}

export function refusalMessageForAgent(decision: Exclude<ConfirmationCreateDecision, { action: "none" }>): string {
  const { approval } = decision;
  const what = describeApprovalForAgent(approval);
  const notAboutIt =
    `If this card is about a different decision, remove the reference to approval ${approval.id} ` +
    "(its id or approval:<id> in idempotencyKey, and its id in the card text) and create it again.";
  if (decision.action === "refuse_already_decided") {
    const note = approval.decisionNote?.trim() ? ` Decision note: "${approval.decisionNote.trim().slice(0, 200)}".` : "";
    return (
      `This confirmation card is about approval ${approval.id} (${what}), which was already ` +
      `${describeApprovalDecision(approval.status)}${formatDecidedAt(approval.decidedAt)}.${note} ` +
      "The operator has decided it; do not ask about it again. Act on that decision. " +
      notAboutIt
    );
  }
  return (
    `This confirmation card is about approval ${approval.id} (${what}), which is still waiting for the operator. ` +
    "That approval card already covers this decision and the operator decides it there, so do not ask again " +
    `with a confirmation card. Wait for the decision (check GET /api/approvals/${approval.id}). ` +
    notAboutIt
  );
}

/** Which named approval the UI should describe on a card, or null. */
export function pickNamedApprovalForDisplay(
  named: readonly NamedApproval[],
  linkedApprovalId: string | null | undefined,
): NamedApproval | null {
  if (named.length === 0) return null;
  if (linkedApprovalId) {
    const linked = named.find((approval) => approval.id.toLowerCase() === linkedApprovalId.toLowerCase());
    if (linked) return linked;
  }
  // The decide-time cleanup closes a card as soon as ANY approval it names is
  // decided, so a decided one is what makes the card out of date.
  return named.find((approval) => isDecidedApprovalStatus(approval.status)) ?? (named.length === 1 ? named[0]! : null);
}
