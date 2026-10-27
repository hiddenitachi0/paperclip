import { and, asc, desc, eq, exists, ilike, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companyAgentRoles,
  contractDeadlines,
  contractParties,
  contractSettings,
  contractTerms,
  contracts,
  crmOrganizations,
  issueThreadInteractions,
  issues,
  withCompanyScope,
} from "@paperclipai/db";
import {
  CONTRACT_STATUSES,
  CONTRACT_TERM_REGISTRY_KEYS,
  contractTermKeySchema,
  NOTICE_DEADLINE_KINDS,
  DEFAULT_LEAD_TIMES_DAYS,
  DEFAULT_NOTICE_LEAD_TIMES_DAYS,
  defaultNeedsOwnerForKind,
  type UpdateContractSettings,
  contractVersionLinkConfirmationKey,
  defaultLeadTimesDaysForKind,
  type AggregateContractTermQuery,
  type ContractFileRef,
  type ContractRelatedReason,
  type ContractStatus,
  type ContractTermAggregate,
  type ContractTermCoverageReport,
  type ContractTermNumericStats,
  type ContractTermRef,
  type CreateContract,
  type CreateContractDeadline,
  type CreateContractParty,
  type FindContractsQuery,
  type LinkPreviousContractVersion,
  type ListContractDeadlinesQuery,
  type ListContractsQuery,
  type RegisterContract,
  type RelatedContractCandidate,
  type RelatedContractsResult,
  type SearchContractTextQuery,
  type UpdateContract,
  type UpdateContractDeadline,
  type UpdateContractParty,
  type UpsertContractTerm,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";

/**
 * Contract register (Legal Phase 1, DUR-4852).
 *
 * Confidentiality: nothing in here writes contract text anywhere but the
 * `contracts.extracted_text` column, and no error message built here repeats a
 * title, a summary or a term value -- ids and field names only.
 */

/** The position key of the Legal Advisor starter position (see job-starter-pack-seed.ts). */
export const LEGAL_POSITION_ROLE_KEY = "legal-advisor";

type ActorRef = { agentId?: string | null; userId?: string | null };

/** Every contracts column except the (large, confidential) extracted text. */
const contractListColumns = {
  id: contracts.id,
  companyId: contracts.companyId,
  title: contracts.title,
  type: contracts.type,
  status: contracts.status,
  assetId: contracts.assetId,
  textStatus: contracts.textStatus,
  language: contracts.language,
  governingLaw: contracts.governingLaw,
  effectiveDate: contracts.effectiveDate,
  expiryDate: contracts.expiryDate,
  autoRenewal: contracts.autoRenewal,
  noticePeriodDays: contracts.noticePeriodDays,
  summary: contracts.summary,
  supersedesContractId: contracts.supersedesContractId,
  versionNo: contracts.versionNo,
  changeSummary: contracts.changeSummary,
  createdByAgentId: contracts.createdByAgentId,
  createdByUserId: contracts.createdByUserId,
  sourceIssueId: contracts.sourceIssueId,
  createdAt: contracts.createdAt,
  updatedAt: contracts.updatedAt,
};

const DEFAULT_AGGREGATE_STATUSES: ContractStatus[] = CONTRACT_STATUSES.filter((status) => status !== "superseded");

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
}

// ---------------------------------------------------------------- aggregation

export interface TermRowForAggregation {
  contractId: string;
  /** null = the contract has no row for this key at all. */
  term: {
    valueKind: string;
    numberValue: string | number | null;
    currency: string | null;
    textValue: string | null;
    boolValue: boolean | null;
    clauseRef: string | null;
  } | null;
}

function roundTo6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Pure classification + statistics over one row per contract in the population.
 *
 * The rule this exists to enforce: an average, minimum or maximum is only ever
 * taken over rows whose value_kind is "number" AND whose number is a real finite
 * number, and only within one currency. "Not mentioned", "explicitly none" and
 * "never recorded" are counted and listed, never turned into zero. Every
 * contract lands in exactly one bucket, so the bucket counts add up to
 * `totalContracts`.
 */
export function aggregateTermRows(
  key: string,
  filters: ContractTermAggregate["filters"],
  rows: TermRowForAggregation[],
): ContractTermAggregate {
  const withValue: ContractTermRef[] = [];
  const notMentioned: ContractTermRef[] = [];
  const explicitlyNone: ContractTermRef[] = [];
  const noTermRecorded: ContractTermRef[] = [];
  const malformed: ContractTermRef[] = [];
  const numericByCurrency = new Map<string, { currency: string | null; values: number[]; refs: ContractTermRef[] }>();

  for (const row of rows) {
    const term = row.term;
    const ref: ContractTermRef = { contractId: row.contractId, clauseRef: term?.clauseRef ?? null };
    if (!term) {
      noTermRecorded.push(ref);
      continue;
    }
    switch (term.valueKind) {
      case "not_mentioned":
        notMentioned.push(ref);
        break;
      case "explicitly_none":
        explicitlyNone.push(ref);
        break;
      case "number": {
        const raw = term.numberValue;
        const value = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
        if (!Number.isFinite(value)) {
          malformed.push(ref);
          break;
        }
        withValue.push(ref);
        const currency = term.currency?.trim() ? term.currency.trim().toUpperCase() : null;
        const bucketKey = currency ?? "";
        const bucket = numericByCurrency.get(bucketKey) ?? { currency, values: [], refs: [] };
        bucket.values.push(value);
        bucket.refs.push(ref);
        numericByCurrency.set(bucketKey, bucket);
        break;
      }
      case "text":
        if (term.textValue !== null && term.textValue !== undefined && term.textValue.trim() !== "") withValue.push(ref);
        else malformed.push(ref);
        break;
      case "bool":
        if (term.boolValue === null || term.boolValue === undefined) malformed.push(ref);
        else withValue.push(ref);
        break;
      default:
        malformed.push(ref);
    }
  }

  const byContractId = (a: ContractTermRef, b: ContractTermRef) => a.contractId.localeCompare(b.contractId);
  const bucket = (refs: ContractTermRef[]) => ({ count: refs.length, contracts: [...refs].sort(byContractId) });

  const numeric: ContractTermNumericStats[] = [...numericByCurrency.values()]
    .map((entry) => {
      const sum = entry.values.reduce((acc, value) => acc + value, 0);
      return {
        currency: entry.currency,
        count: entry.values.length,
        avg: roundTo6(sum / entry.values.length),
        min: Math.min(...entry.values),
        max: Math.max(...entry.values),
        contracts: [...entry.refs].sort(byContractId),
      };
    })
    .sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));

  return {
    key,
    filters,
    totalContracts: rows.length,
    numeric,
    withValue: bucket(withValue),
    notMentioned: bucket(notMentioned),
    explicitlyNone: bucket(explicitlyNone),
    noTermRecorded: bucket(noTermRecorded),
    malformed: bucket(malformed),
  };
}

// ---------------------------------------------------------------- pure helpers (Legal Phase 4)

const LEGAL_FORM_WORDS = new Set([
  "as", "asa", "ans", "da", "ltd", "limited", "inc", "llc", "gmbh", "ab", "oy", "sa", "bv", "plc", "co", "corp",
]);

/** "Landlord A.S." and "landlord as" are the same party; legal-form words never decide a match. */
export function normalizePartyName(name: string): string {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const core = words.filter((word) => !LEGAL_FORM_WORDS.has(word));
  return (core.length > 0 ? core : words).join(" ");
}


type PartyIdentity = { organizationId: string | null; name: string | null };

/**
 * Two contracts have "the same parties" when they share at least
 * min(2, size of the smaller party list) parties. Our own company is on every
 * contract, so sharing one party is not enough once both list two or more.
 */
export function samePartiesForVersioning(a: PartyIdentity[], b: PartyIdentity[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  // A party with both an organisation and a name counts once: compare per party, not per key.
  const matches = (x: PartyIdentity, y: PartyIdentity) => {
    if (x.organizationId && x.organizationId === y.organizationId) return true;
    if (x.name && y.name) {
      const nx = normalizePartyName(x.name);
      return nx !== "" && nx === normalizePartyName(y.name);
    }
    return false;
  };
  const shared = a.filter((x) => b.some((y) => matches(x, y))).length;
  return shared >= Math.min(2, a.length, b.length);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Up to `max` windows of text around the case-insensitive matches of `needle`. */
export function extractSnippets(text: string, needle: string, max = 3, radius = 160): string[] {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  if (!target) return [];
  const snippets: string[] = [];
  let from = 0;
  while (snippets.length < max) {
    const at = haystack.indexOf(target, from);
    if (at === -1) break;
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + target.length + radius);
    snippets.push(`${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`);
    from = end;
  }
  return snippets;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * The aggregate in plain words. It always says how many contracts the average
 * is over and how many are missing from it, so an average is never quoted
 * without its coverage.
 */
export function describeAggregateCoverage(
  aggregate: ContractTermAggregate,
  titles: Record<string, string>,
): string {
  const label = (ref: { contractId: string; clauseRef: string | null }) =>
    `${titles[ref.contractId] ?? ref.contractId}${ref.clauseRef ? ` (${ref.clauseRef})` : ""}`;
  // Alphabetical, so the same data always reads the same (ids are random).
  const list = (refs: { contractId: string; clauseRef: string | null }[]) => refs.map(label).sort().join("; ");
  const lines: string[] = [];
  const scope = [
    aggregate.filters.type ? `type ${aggregate.filters.type}` : "all types",
    `status ${aggregate.filters.statuses.join(", ")}`,
  ].join(", ");
  lines.push(`Term "${aggregate.key}" across ${aggregate.totalContracts} contract(s) (${scope}).`);
  if (aggregate.numeric.length === 0) {
    lines.push("No contract states a number for this term, so there is no average.");
  }
  for (const stats of aggregate.numeric) {
    const unit = stats.currency ? ` ${stats.currency}` : "";
    lines.push(
      `- ${stats.count} contract(s) with a number${stats.currency ? ` in ${stats.currency}` : ""}: average ${formatNumber(stats.avg)}${unit} ` +
        `(min ${formatNumber(stats.min)}, max ${formatNumber(stats.max)}). Only these ${stats.count} are in the average: ${list(stats.contracts)}`,
    );
  }
  const nonNumericWithValue = aggregate.withValue.count - aggregate.numeric.reduce((sum, stats) => sum + stats.count, 0);
  if (nonNumericWithValue > 0) lines.push(`- ${nonNumericWithValue} contract(s) state a text or yes/no value (not averaged).`);
  lines.push(`- ${aggregate.notMentioned.count} contract(s) read and do not mention it${aggregate.notMentioned.count ? `: ${list(aggregate.notMentioned.contracts)}` : ""}`);
  lines.push(`- ${aggregate.explicitlyNone.count} contract(s) state explicitly that there is none${aggregate.explicitlyNone.count ? `: ${list(aggregate.explicitlyNone.contracts)}` : ""}`);
  lines.push(`- ${aggregate.noTermRecorded.count} contract(s) not checked yet (nothing recorded, unknown rather than zero)${aggregate.noTermRecorded.count ? `: ${list(aggregate.noTermRecorded.contracts)}` : ""}`);
  if (aggregate.malformed.count > 0) {
    lines.push(`- ${aggregate.malformed.count} contract(s) have an unusable record, left out of every figure: ${list(aggregate.malformed.contracts)}`);
  }
  return lines.join("\n");
}

export type FoundContract = {
  id: string;
  title: string;
  type: string;
  status: string;
  versionNo: number;
  effectiveDate: string | null;
  expiryDate: string | null;
  summary: string | null;
  parties: Array<{ role: string; name: string | null }>;
  file: ContractFileRef | null;
  score: number;
  createdAt: Date;
};

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 2);
}

/** One edit (insert, delete or replace) apart. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** A word matches by prefix/containment, or (for words of 5+ letters) one typo away. */
function wordMatches(token: string, words: string[]): boolean {
  return words.some(
    (word) => word.includes(token) || (token.length >= 5 && (token.includes(word) && word.length >= 5 || withinOneEdit(token, word))),
  );
}

// ---------------------------------------------------------------- agent access

/**
 * Who may use the contract register as an agent: an agent of this company that
 * holds the Legal Advisor position, or any agent holding an explicit
 * `contracts:access` grant. Everything else is refused (confidential by default).
 *
 * `actor` must be the request's own actor (key scope, key id, run id) and not
 * one rebuilt from the agent id: the shared authorization service applies its
 * task-bridge-key and low-trust-boundary restrictions from those fields, and
 * both paths below honour them. The position path only opens when the service
 * said "no grant" and nothing stricter.
 */
export async function agentMayUseContracts(
  db: Db,
  companyId: string,
  actor: AuthorizationActor,
): Promise<boolean> {
  const agentId = actor.agentId;
  if (!agentId) return false;
  const decision = await authorizationService(db).decide({
    actor,
    action: "contracts:access",
    resource: { type: "company", companyId },
  });
  if (decision.allowed) return true;
  if (decision.reason !== "deny_missing_grant") return false;

  const row = await db
    .select({ status: agents.status, roleKey: companyAgentRoles.key })
    .from(agents)
    .innerJoin(
      companyAgentRoles,
      and(eq(companyAgentRoles.id, agents.roleId), eq(companyAgentRoles.companyId, agents.companyId)),
    )
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row) return false;
  if (row.status === "terminated" || row.status === "pending_approval") return false;
  return row.roleKey === LEGAL_POSITION_ROLE_KEY;
}

/** Storage namespace every contract file is written under (see contract-files.ts). */
export const CONTRACT_FILE_NAMESPACE = "contracts";

/**
 * True for an asset that holds a contract file. Keyed on the stored object key,
 * not on `contracts.asset_id`, so a file that was replaced (and is no longer
 * the contract's current one) stays protected too.
 */
export function isContractFileAsset(asset: { companyId: string; objectKey: string }): boolean {
  return asset.objectKey.startsWith(`${asset.companyId}/${CONTRACT_FILE_NAMESPACE}/`);
}

/**
 * The whole "may this caller use contracts" decision for one request actor, so
 * the contract routes and company search cannot drift apart: board members of
 * the company except read-only viewers (instance admins and the local board
 * are always in), and agents per `agentMayUseContracts`. Everything else
 * (delegate tokens, service tokens, anonymous) is refused.
 */
export async function actorMayUseContracts(
  db: Db,
  companyId: string,
  actor: AuthorizationActor,
): Promise<boolean> {
  if (actor.type === "agent") return agentMayUseContracts(db, companyId, actor);
  if (actor.type === "board") {
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
    const membership = actor.memberships?.find((item) => item.companyId === companyId);
    return Boolean(membership && membership.status === "active" && membership.membershipRole !== "viewer");
  }
  return false;
}

// ---------------------------------------------------------------- service

/**
 * `rawDb` is the un-proxied Db: the version-link transaction needs a real
 * transaction, which the request-scoped proxy refuses (see withCompanyScope).
 */
export function contractService(db: Db, rawDb: Db = db) {
  async function assertContractInCompany(companyId: string, contractId: string, executor: Db = db) {
    const row = await executor
      .select({ id: contracts.id, status: contracts.status })
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Contract not found");
    return row;
  }

  async function assertReferencesInCompany(
    companyId: string,
    refs: { assetId?: string | null; sourceIssueId?: string | null; organizationIds?: string[] },
    executor: Db = db,
  ) {
    if (refs.assetId) {
      const asset = await executor
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, refs.assetId), eq(assets.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!asset) throw unprocessable("assetId does not refer to a file in this company");
    }
    if (refs.sourceIssueId) {
      const issue = await executor
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, refs.sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw unprocessable("sourceIssueId does not refer to an issue in this company");
    }
    const orgIds = [...new Set((refs.organizationIds ?? []).filter(Boolean))];
    if (orgIds.length > 0) {
      const found = await executor
        .select({ id: crmOrganizations.id })
        .from(crmOrganizations)
        .where(and(eq(crmOrganizations.companyId, companyId), inArray(crmOrganizations.id, orgIds)));
      if (found.length !== orgIds.length) {
        throw unprocessable("organizationId does not refer to an organisation in this company");
      }
    }
  }

  async function readSettings(companyId: string) {
    const row = await db
      .select({ notice: contractSettings.noticeLeadTimesDays, other: contractSettings.otherLeadTimesDays })
      .from(contractSettings)
      .where(eq(contractSettings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return {
      noticeLeadTimesDays: row?.notice ?? null,
      otherLeadTimesDays: row?.other ?? null,
      effectiveNoticeLeadTimesDays:
        row?.notice && row.notice.length > 0 ? row.notice : [...DEFAULT_NOTICE_LEAD_TIMES_DAYS],
      effectiveOtherLeadTimesDays: row?.other && row.other.length > 0 ? row.other : [...DEFAULT_LEAD_TIMES_DAYS],
    };
  }

  /** The company's own default lead times for a kind, else the built-in ones. */
  async function defaultLeadTimesFor(companyId: string, kind: CreateContractDeadline["kind"]): Promise<number[]> {
    const settings = await readSettings(companyId);
    return NOTICE_DEADLINE_KINDS.includes(kind)
      ? settings.effectiveNoticeLeadTimesDays
      : settings.effectiveOtherLeadTimesDays;
  }

  async function toDeadlineValues(companyId: string, contractId: string, input: CreateContractDeadline) {
    return {
      companyId,
      contractId,
      kind: input.kind,
      dueDate: input.dueDate,
      leadTimesDays: input.leadTimesDays ?? (await defaultLeadTimesFor(companyId, input.kind)),
      needsOwner: input.needsOwner ?? defaultNeedsOwnerForKind(input.kind),
      clauseRef: input.clauseRef ?? null,
      note: input.note ?? null,
    };
  }

  /**
   * The server-side half of "the agent must not approve its own link": the
   * card must be a request_confirmation in this company, accepted (not
   * expired, rejected or pending) and resolved by a person, and its target must
   * name exactly this (new, old) pair. Accepting is a board-only route, so an
   * agent cannot produce such a row. Two other routes also write "accepted"
   * with a user id and are refused: a card linked to (or naming) an ordinary
   * approval, which flips to accepted when the operator approves that other
   * card, and any automatic close, which always writes result.reason. A direct
   * accept writes neither. One generic message for every failure:
   * the caller learns what is needed, not which card exists.
   */
  async function assertBoardConfirmedVersionLink(
    companyId: string,
    currentId: string,
    previousId: string,
    interactionId: string | undefined,
  ) {
    const expectedKey = contractVersionLinkConfirmationKey(currentId, previousId);
    const refusal = () =>
      forbidden(
        "Linking a contract version needs a confirmation that a board member accepted. Ask with " +
          `request_confirmation using target {"type":"custom","key":"${expectedKey}"}, then pass its id as confirmationInteractionId`,
      );
    if (!interactionId) throw refusal();
    const row = await db
      .select({
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        linkedApprovalId: issueThreadInteractions.linkedApprovalId,
        result: issueThreadInteractions.result,
        payload: issueThreadInteractions.payload,
      })
      .from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const target = (row?.payload as { target?: { type?: string; key?: string } | null } | undefined)?.target;
    const autoResolvedReason = (row?.result as { reason?: string | null } | null | undefined)?.reason;
    const confirmed =
      row !== null &&
      row.kind === "request_confirmation" &&
      row.status === "accepted" &&
      Boolean(row.resolvedByUserId) &&
      !row.resolvedByAgentId &&
      !row.linkedApprovalId &&
      !autoResolvedReason &&
      target?.type === "custom" &&
      target.key === expectedKey;
    if (!confirmed) throw refusal();
  }

  function toTermColumns(input: UpsertContractTerm) {
    return {
      valueKind: input.valueKind,
      numberValue: input.valueKind === "number" ? String(input.numberValue) : null,
      currency: input.valueKind === "number" && input.currency ? input.currency.toUpperCase() : null,
      textValue: input.valueKind === "text" ? input.textValue ?? null : null,
      boolValue: input.valueKind === "bool" ? input.boolValue ?? null : null,
      clauseRef: input.clauseRef ?? null,
      pageRef: input.pageRef ?? null,
    };
  }

  async function insertParties(executor: Db, companyId: string, contractId: string, parties: CreateContractParty[]) {
    if (parties.length === 0) return;
    await executor.insert(contractParties).values(
      parties.map((party) => ({
        companyId,
        contractId,
        organizationId: party.organizationId ?? null,
        role: party.role,
        name: party.name ?? null,
      })),
    );
  }

  const api = {
    // ------------------------------------------------------------ contracts
    listContracts: async (companyId: string, filters: ListContractsQuery = {}) => {
      const conditions = [eq(contracts.companyId, companyId)];
      if (filters.status) conditions.push(eq(contracts.status, filters.status));
      if (filters.type) conditions.push(eq(contracts.type, filters.type));
      if (filters.expiresBefore) conditions.push(lte(contracts.expiryDate, filters.expiresBefore));
      return db
        .select(contractListColumns)
        .from(contracts)
        .where(and(...conditions))
        .orderBy(desc(contracts.createdAt))
        .limit(filters.limit ?? 200);
    },

    /** The file side of a contract (no text): 404 when it is not in this company. */
    getFileState: async (companyId: string, id: string) => {
      const row = await db
        .select({ id: contracts.id, assetId: contracts.assetId, textStatus: contracts.textStatus })
        .from(contracts)
        .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Contract not found");
      return row;
    },

    getContract: async (companyId: string, id: string, options: { includeText?: boolean } = {}) => {
      const row = await db
        .select(options.includeText ? { ...contractListColumns, extractedText: contracts.extractedText } : contractListColumns)
        .from(contracts)
        .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Contract not found");
      const [parties, deadlines, terms] = await Promise.all([
        db
          .select()
          .from(contractParties)
          .where(and(eq(contractParties.contractId, id), eq(contractParties.companyId, companyId)))
          .orderBy(asc(contractParties.createdAt)),
        db
          .select()
          .from(contractDeadlines)
          .where(and(eq(contractDeadlines.contractId, id), eq(contractDeadlines.companyId, companyId)))
          .orderBy(asc(contractDeadlines.dueDate)),
        db
          .select()
          .from(contractTerms)
          .where(and(eq(contractTerms.contractId, id), eq(contractTerms.companyId, companyId)))
          .orderBy(asc(contractTerms.key)),
      ]);
      return { ...row, parties, deadlines, terms };
    },

    createContract: async (companyId: string, input: CreateContract, actor: ActorRef) => {
      const { parties = [], ...fields } = input;
      await assertReferencesInCompany(companyId, {
        assetId: fields.assetId,
        sourceIssueId: fields.sourceIssueId,
        organizationIds: parties.map((party) => party.organizationId).filter((id): id is string => Boolean(id)),
      });
      return withCompanyScope(rawDb, companyId, async (tx) => {
        const created = await tx
          .insert(contracts)
          .values({
            ...fields,
            companyId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          })
          .returning(contractListColumns)
          .then((rows) => rows[0]);
        await insertParties(tx as unknown as Db, companyId, created.id, parties);
        return created;
      });
    },

    updateContract: async (companyId: string, id: string, input: UpdateContract) => {
      const existing = await assertContractInCompany(companyId, id);
      if (existing.status === "superseded" && input.status !== undefined) {
        throw conflict("A superseded contract keeps its status; it was replaced by a newer version");
      }
      await assertReferencesInCompany(companyId, { assetId: input.assetId, sourceIssueId: input.sourceIssueId });
      const updated = await db
        .update(contracts)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)))
        .returning(contractListColumns)
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Contract not found");
      return updated;
    },

    /** Refuses to delete a version that is part of a chain, so the version log never loses a link. */
    removeContract: async (companyId: string, id: string) => {
      const row = await db
        .select({ id: contracts.id, type: contracts.type, supersedesContractId: contracts.supersedesContractId })
        .from(contracts)
        .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Contract not found");
      const successor = await db
        .select({ id: contracts.id })
        .from(contracts)
        .where(and(eq(contracts.supersedesContractId, id), eq(contracts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (row.supersedesContractId || successor) {
        throw conflict("This contract is part of a version chain and cannot be deleted");
      }
      await db.delete(contracts).where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)));
      return row;
    },

    // ------------------------------------------------------------ version chain
    /**
     * Makes `currentId` the newer version of `previousContractId`: sets the
     * link, version number and change note on the new one, marks the old one
     * superseded, and either moves (carryDeadlines) or closes the old one's
     * open deadlines. One transaction, so a half-linked chain cannot exist.
     */
    linkPreviousVersion: async (
      companyId: string,
      currentId: string,
      input: LinkPreviousContractVersion,
      /** An agent may only link after a board member accepted a confirmation for exactly this pair. */
      options: { requireBoardConfirmation: boolean },
    ) => {
      if (currentId === input.previousContractId) throw unprocessable("A contract cannot supersede itself");
      if (options.requireBoardConfirmation) {
        await assertBoardConfirmedVersionLink(companyId, currentId, input.previousContractId, input.confirmationInteractionId);
      }
      try {
        return await withCompanyScope(rawDb, companyId, async (tx) => {
          const t = tx as unknown as Db;
          const load = (id: string) =>
            t
              .select({
                id: contracts.id,
                status: contracts.status,
                versionNo: contracts.versionNo,
                supersedesContractId: contracts.supersedesContractId,
              })
              .from(contracts)
              .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)))
              .then((rows) => rows[0] ?? null);

          const current = await load(currentId);
          if (!current) throw notFound("Contract not found");
          const previous = await load(input.previousContractId);
          if (!previous) throw notFound("Previous contract not found");

          if (current.supersedesContractId) throw conflict("This contract already has a previous version");
          if (previous.status === "superseded") throw conflict("The previous contract was already replaced by another version");
          if (current.status === "superseded") throw conflict("A superseded contract cannot become the newer version");
          const hasSuccessor = async (id: string) =>
            Boolean(
              await t
                .select({ id: contracts.id })
                .from(contracts)
                .where(and(eq(contracts.supersedesContractId, id), eq(contracts.companyId, companyId)))
                .then((rows) => rows[0] ?? null),
            );
          if (await hasSuccessor(previous.id)) throw conflict("The previous contract was already replaced by another version");
          if (await hasSuccessor(current.id)) throw conflict("This contract already has a newer version");

          // The new version must not already be an ancestor of the one it replaces.
          let cursor: string | null = previous.supersedesContractId;
          const seen = new Set<string>([previous.id]);
          while (cursor && !seen.has(cursor)) {
            if (cursor === current.id) throw conflict("Linking these would make the version chain loop");
            seen.add(cursor);
            const parent = await load(cursor);
            cursor = parent?.supersedesContractId ?? null;
          }

          const now = new Date();
          await t
            .update(contracts)
            .set({
              supersedesContractId: previous.id,
              versionNo: previous.versionNo + 1,
              changeSummary: input.changeSummary,
              updatedAt: now,
            })
            .where(and(eq(contracts.id, current.id), eq(contracts.companyId, companyId)));
          await t
            .update(contracts)
            .set({ status: "superseded", updatedAt: now })
            .where(and(eq(contracts.id, previous.id), eq(contracts.companyId, companyId)));

          const openOld = await t
            .select()
            .from(contractDeadlines)
            .where(
              and(
                eq(contractDeadlines.contractId, previous.id),
                eq(contractDeadlines.companyId, companyId),
                eq(contractDeadlines.state, "open"),
              ),
            );
          const supersedeIds: string[] = [];
          const moveIds: string[] = [];
          if (input.carryDeadlines && openOld.length > 0) {
            const openNew = await t
              .select({ kind: contractDeadlines.kind, dueDate: contractDeadlines.dueDate })
              .from(contractDeadlines)
              .where(
                and(
                  eq(contractDeadlines.contractId, current.id),
                  eq(contractDeadlines.companyId, companyId),
                  eq(contractDeadlines.state, "open"),
                ),
              );
            const covered = new Set(openNew.map((d) => `${d.kind}|${d.dueDate}`));
            for (const deadline of openOld) {
              if (covered.has(`${deadline.kind}|${deadline.dueDate}`)) supersedeIds.push(deadline.id);
              else moveIds.push(deadline.id);
            }
          } else {
            supersedeIds.push(...openOld.map((d) => d.id));
          }
          if (moveIds.length > 0) {
            await t
              .update(contractDeadlines)
              .set({ contractId: current.id, updatedAt: now })
              .where(and(inArray(contractDeadlines.id, moveIds), eq(contractDeadlines.companyId, companyId)));
          }
          if (supersedeIds.length > 0) {
            await t
              .update(contractDeadlines)
              .set({ state: "superseded", updatedAt: now })
              .where(and(inArray(contractDeadlines.id, supersedeIds), eq(contractDeadlines.companyId, companyId)));
          }

          return {
            contractId: current.id,
            previousContractId: previous.id,
            versionNo: previous.versionNo + 1,
            carryDeadlines: input.carryDeadlines,
            movedDeadlines: moveIds.length,
            supersededDeadlines: supersedeIds.length,
          };
        });
      } catch (error) {
        // The partial unique index on supersedes_contract_id: two links raced for one predecessor.
        if (isUniqueViolation(error)) throw conflict("The previous contract was already replaced by another version");
        throw error;
      }
    },

    /** The whole chain this contract belongs to, oldest version first. No contract text. */
    getVersionLog: async (companyId: string, id: string) => {
      const start = await assertContractInCompany(companyId, id);
      const columns = {
        id: contracts.id,
        title: contracts.title,
        status: contracts.status,
        versionNo: contracts.versionNo,
        changeSummary: contracts.changeSummary,
        supersedesContractId: contracts.supersedesContractId,
        effectiveDate: contracts.effectiveDate,
        createdAt: contracts.createdAt,
      };
      type Version = {
        id: string;
        title: string;
        status: string;
        versionNo: number;
        changeSummary: string | null;
        supersedesContractId: string | null;
        effectiveDate: string | null;
        createdAt: Date;
      };
      const loadOne = (where: ReturnType<typeof eq>) =>
        db
          .select(columns)
          .from(contracts)
          .where(and(eq(contracts.companyId, companyId), where))
          .then((rows) => (rows[0] ?? null) as Version | null);

      const chain: Version[] = [];
      const seen = new Set<string>();
      let cursor = await loadOne(eq(contracts.id, start.id));
      // Walk to the oldest version, then forward again.
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.unshift(cursor);
        cursor = cursor.supersedesContractId ? await loadOne(eq(contracts.id, cursor.supersedesContractId)) : null;
      }
      let tail: Version | null = chain[chain.length - 1] ?? null;
      while (tail) {
        const next: Version | null = await loadOne(eq(contracts.supersedesContractId, tail.id));
        if (!next || seen.has(next.id)) break;
        seen.add(next.id);
        chain.push(next);
        tail = next;
      }
      return chain;
    },

    // ------------------------------------------------------------ parties
    addParty: async (companyId: string, contractId: string, input: CreateContractParty) => {
      await assertContractInCompany(companyId, contractId);
      await assertReferencesInCompany(companyId, { organizationIds: input.organizationId ? [input.organizationId] : [] });
      return db
        .insert(contractParties)
        .values({
          companyId,
          contractId,
          organizationId: input.organizationId ?? null,
          role: input.role,
          name: input.name ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    updateParty: async (companyId: string, contractId: string, partyId: string, input: UpdateContractParty) => {
      await assertContractInCompany(companyId, contractId);
      const existing = await db
        .select()
        .from(contractParties)
        .where(
          and(
            eq(contractParties.id, partyId),
            eq(contractParties.contractId, contractId),
            eq(contractParties.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Party not found");
      const organizationId = input.organizationId === undefined ? existing.organizationId : input.organizationId;
      const name = input.name === undefined ? existing.name : input.name;
      if (!organizationId && !name) throw unprocessable("A party needs an organization from the CRM or a name");
      await assertReferencesInCompany(companyId, { organizationIds: input.organizationId ? [input.organizationId] : [] });
      return db
        .update(contractParties)
        .set({ organizationId, name, ...(input.role !== undefined ? { role: input.role } : {}) })
        .where(and(eq(contractParties.id, partyId), eq(contractParties.companyId, companyId)))
        .returning()
        .then((rows) => rows[0]);
    },

    removeParty: async (companyId: string, contractId: string, partyId: string) => {
      await assertContractInCompany(companyId, contractId);
      const removed = await db
        .delete(contractParties)
        .where(
          and(
            eq(contractParties.id, partyId),
            eq(contractParties.contractId, contractId),
            eq(contractParties.companyId, companyId),
          ),
        )
        .returning({ id: contractParties.id })
        .then((rows) => rows[0] ?? null);
      if (!removed) throw notFound("Party not found");
    },

    // ------------------------------------------------------------ deadlines
    listDeadlines: async (companyId: string, filters: ListContractDeadlinesQuery = {}) => {
      const conditions = [eq(contractDeadlines.companyId, companyId)];
      if (filters.state) conditions.push(eq(contractDeadlines.state, filters.state));
      if (filters.dueBefore) conditions.push(lte(contractDeadlines.dueDate, filters.dueBefore));
      if (filters.contractId) conditions.push(eq(contractDeadlines.contractId, filters.contractId));
      return db
        .select()
        .from(contractDeadlines)
        .where(and(...conditions))
        .orderBy(asc(contractDeadlines.dueDate))
        .limit(1000);
    },

    addDeadline: async (companyId: string, contractId: string, input: CreateContractDeadline) => {
      const contract = await assertContractInCompany(companyId, contractId);
      if (contract.status === "superseded") {
        throw conflict("A superseded contract takes no new deadlines; add it to the newer version");
      }
      return db
        .insert(contractDeadlines)
        .values(await toDeadlineValues(companyId, contractId, input))
        .returning()
        .then((rows) => rows[0]);
    },

    updateDeadline: async (companyId: string, contractId: string, deadlineId: string, input: UpdateContractDeadline) => {
      await assertContractInCompany(companyId, contractId);
      const existing = await db
        .select({ id: contractDeadlines.id, state: contractDeadlines.state, kind: contractDeadlines.kind })
        .from(contractDeadlines)
        .where(
          and(
            eq(contractDeadlines.id, deadlineId),
            eq(contractDeadlines.contractId, contractId),
            eq(contractDeadlines.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Deadline not found");
      if (existing.state === "superseded" && input.state !== undefined) {
        throw conflict("A superseded deadline cannot be reopened; it was replaced by a newer version");
      }
      return db
        .update(contractDeadlines)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(contractDeadlines.id, deadlineId), eq(contractDeadlines.companyId, companyId)))
        .returning()
        .then((rows) => rows[0]);
    },

    removeDeadline: async (companyId: string, contractId: string, deadlineId: string) => {
      await assertContractInCompany(companyId, contractId);
      const removed = await db
        .delete(contractDeadlines)
        .where(
          and(
            eq(contractDeadlines.id, deadlineId),
            eq(contractDeadlines.contractId, contractId),
            eq(contractDeadlines.companyId, companyId),
          ),
        )
        .returning({ id: contractDeadlines.id })
        .then((rows) => rows[0] ?? null);
      if (!removed) throw notFound("Deadline not found");
    },

    // ------------------------------------------------------------ reminder settings
    getSettings: readSettings,

    /** Applies to deadlines created from now on; existing deadlines keep their own lead times. */
    updateSettings: async (companyId: string, input: UpdateContractSettings) => {
      const values: { noticeLeadTimesDays?: number[] | null; otherLeadTimesDays?: number[] | null } = {};
      if (input.noticeLeadTimesDays !== undefined) values.noticeLeadTimesDays = input.noticeLeadTimesDays;
      if (input.otherLeadTimesDays !== undefined) values.otherLeadTimesDays = input.otherLeadTimesDays;
      await db
        .insert(contractSettings)
        .values({ companyId, ...values })
        .onConflictDoUpdate({
          target: contractSettings.companyId,
          set: { ...values, updatedAt: new Date() },
        });
      return readSettings(companyId);
    },

    // ------------------------------------------------------------ terms
    listTerms: async (companyId: string, contractId: string) => {
      await assertContractInCompany(companyId, contractId);
      return db
        .select()
        .from(contractTerms)
        .where(and(eq(contractTerms.contractId, contractId), eq(contractTerms.companyId, companyId)))
        .orderBy(asc(contractTerms.key));
    },

    upsertTerm: async (companyId: string, contractId: string, key: string, input: UpsertContractTerm) => {
      const parsedKey = contractTermKeySchema.safeParse(key);
      if (!parsedKey.success) throw unprocessable("Invalid term key");
      await assertContractInCompany(companyId, contractId);
      const values = toTermColumns(input);
      return db
        .insert(contractTerms)
        .values({ companyId, contractId, key: parsedKey.data, ...values })
        .onConflictDoUpdate({
          target: [contractTerms.contractId, contractTerms.key],
          set: { ...values, updatedAt: new Date() },
        })
        .returning()
        .then((rows) => rows[0]);
    },

    removeTerm: async (companyId: string, contractId: string, key: string) => {
      await assertContractInCompany(companyId, contractId);
      const removed = await db
        .delete(contractTerms)
        .where(
          and(
            eq(contractTerms.contractId, contractId),
            eq(contractTerms.companyId, companyId),
            eq(contractTerms.key, key),
          ),
        )
        .returning({ id: contractTerms.id })
        .then((rows) => rows[0] ?? null);
      if (!removed) throw notFound("Term not found");
    },

    /**
     * Average / min / max of a term across the company's contracts, plus how
     * many contracts have a value, do not mention it, say there is none, or
     * have no record for it at all. See aggregateTermRows for the rules.
     */
    aggregateTerm: async (
      companyId: string,
      key: string,
      filters: Pick<AggregateContractTermQuery, "type" | "statuses" | "partyOrganizationId"> = {},
    ): Promise<ContractTermAggregate> => {
      const parsedKey = contractTermKeySchema.safeParse(key);
      if (!parsedKey.success) throw unprocessable("Invalid term key");
      const statuses = filters.statuses && filters.statuses.length > 0 ? filters.statuses : DEFAULT_AGGREGATE_STATUSES;

      const conditions = [eq(contracts.companyId, companyId), inArray(contracts.status, statuses)];
      if (filters.type) conditions.push(eq(contracts.type, filters.type));
      if (filters.partyOrganizationId) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(contractParties)
              .where(
                and(
                  eq(contractParties.contractId, contracts.id),
                  eq(contractParties.companyId, companyId),
                  eq(contractParties.organizationId, filters.partyOrganizationId),
                ),
              ),
          ),
        );
      }

      const rows = await db
        .select({
          contractId: contracts.id,
          termId: contractTerms.id,
          valueKind: contractTerms.valueKind,
          numberValue: contractTerms.numberValue,
          currency: contractTerms.currency,
          textValue: contractTerms.textValue,
          boolValue: contractTerms.boolValue,
          clauseRef: contractTerms.clauseRef,
        })
        .from(contracts)
        .leftJoin(
          contractTerms,
          and(
            eq(contractTerms.contractId, contracts.id),
            eq(contractTerms.companyId, contracts.companyId),
            eq(contractTerms.key, parsedKey.data),
          ),
        )
        .where(and(...conditions));

      return aggregateTermRows(
        parsedKey.data,
        {
          type: filters.type ?? null,
          statuses: [...statuses],
          partyOrganizationId: filters.partyOrganizationId ?? null,
        },
        rows.map((row) => ({
          contractId: row.contractId,
          term:
            row.termId === null || row.valueKind === null
              ? null
              : {
                  valueKind: row.valueKind,
                  numberValue: row.numberValue,
                  currency: row.currency,
                  textValue: row.textValue,
                  boolValue: row.boolValue,
                  clauseRef: row.clauseRef,
                },
        })),
      );
    },

    // ------------------------------------------------------------ agent intake (Legal Phase 4)
    /** Contract, parties, terms and deadlines in one transaction: all of it or none of it. */
    registerContract: async (companyId: string, input: RegisterContract, actor: ActorRef) => {
      const { parties = [], terms = [], deadlines = [], ...fields } = input;
      await assertReferencesInCompany(companyId, {
        assetId: fields.assetId,
        sourceIssueId: fields.sourceIssueId,
        organizationIds: parties.map((party) => party.organizationId).filter((id): id is string => Boolean(id)),
      });
      return withCompanyScope(rawDb, companyId, async (tx) => {
        const t = tx as unknown as Db;
        const created = await t
          .insert(contracts)
          .values({
            ...fields,
            companyId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          })
          .returning(contractListColumns)
          .then((rows) => rows[0]);
        await insertParties(t, companyId, created.id, parties);
        if (terms.length > 0) {
          await t
            .insert(contractTerms)
            .values(terms.map(({ key, ...term }) => ({ companyId, contractId: created.id, key, ...toTermColumns(term) })));
        }
        if (deadlines.length > 0) {
          await t.insert(contractDeadlines).values(deadlines.map((deadline) => toDeadlineValues(companyId, created.id, deadline)));
        }
        return { ...created, partyCount: parties.length, termCount: terms.length, deadlineCount: deadlines.length };
      });
    },

    /**
     * Older contracts this one may be a newer version of: same type and the
     * same parties, or named in this contract's own text. Candidates only; a
     * link still needs a board member's confirmation. No contract text out.
     */
    findRelatedContracts: async (companyId: string, id: string): Promise<RelatedContractsResult> => {
      const current = await db
        .select({
          id: contracts.id,
          type: contracts.type,
          status: contracts.status,
          supersedesContractId: contracts.supersedesContractId,
          extractedText: contracts.extractedText,
          summary: contracts.summary,
        })
        .from(contracts)
        .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Contract not found");
      if (current.supersedesContractId || current.status === "superseded") {
        return { contractId: id, alreadyHasPreviousVersion: Boolean(current.supersedesContractId), candidates: [] };
      }

      const all = await db
        .select({
          id: contracts.id,
          title: contracts.title,
          type: contracts.type,
          status: contracts.status,
          versionNo: contracts.versionNo,
          effectiveDate: contracts.effectiveDate,
          expiryDate: contracts.expiryDate,
          supersedesContractId: contracts.supersedesContractId,
        })
        .from(contracts)
        .where(eq(contracts.companyId, companyId))
        .limit(5000);
      const supersedesOf = new Map(all.map((row) => [row.id, row.supersedesContractId]));
      const isDescendantOfCurrent = (candidateId: string) => {
        const seen = new Set<string>();
        let cursor: string | null | undefined = candidateId;
        while (cursor && !seen.has(cursor)) {
          if (cursor === id) return true;
          seen.add(cursor);
          cursor = supersedesOf.get(cursor);
        }
        return false;
      };
      const candidates = all.filter((row) => row.id !== id && row.status !== "superseded" && !isDescendantOfCurrent(row.id));
      if (candidates.length === 0) return { contractId: id, alreadyHasPreviousVersion: false, candidates: [] };

      const partyRows = await db
        .select({ contractId: contractParties.contractId, organizationId: contractParties.organizationId, name: contractParties.name })
        .from(contractParties)
        .where(and(eq(contractParties.companyId, companyId), inArray(contractParties.contractId, [id, ...candidates.map((row) => row.id)])));
      const partiesByContract = new Map<string, PartyIdentity[]>();
      for (const row of partyRows) {
        const list = partiesByContract.get(row.contractId) ?? [];
        list.push({ organizationId: row.organizationId, name: row.name });
        partiesByContract.set(row.contractId, list);
      }
      const currentParties = partiesByContract.get(id) ?? [];
      const currentText = `${current.extractedText ?? ""}\n${current.summary ?? ""}`.toLowerCase();

      const result: RelatedContractCandidate[] = [];
      for (const candidate of candidates) {
        const reasons: ContractRelatedReason[] = [];
        if (candidate.type === current.type && samePartiesForVersioning(currentParties, partiesByContract.get(candidate.id) ?? [])) {
          reasons.push("same_parties_and_type");
        }
        const title = candidate.title.trim().toLowerCase();
        if (title.length >= 6 && currentText.includes(title)) reasons.push("named_in_contract_text");
        if (reasons.length === 0) continue;
        result.push({
          id: candidate.id,
          title: candidate.title,
          type: candidate.type as RelatedContractCandidate["type"],
          status: candidate.status as ContractStatus,
          versionNo: candidate.versionNo,
          effectiveDate: candidate.effectiveDate,
          expiryDate: candidate.expiryDate,
          reasons,
        });
      }
      result.sort(
        (a, b) =>
          b.reasons.length - a.reasons.length || (b.effectiveDate ?? "").localeCompare(a.effectiveDate ?? "") || a.title.localeCompare(b.title),
      );
      return { contractId: id, alreadyHasPreviousVersion: false, candidates: result.slice(0, 10) };
    },

    /**
     * Fuzzy find by title / party / type. Returns summary and a link to the
     * stored file, never the extracted text.
     */
    findContracts: async (companyId: string, query: FindContractsQuery = {}) => {
      const conditions = [eq(contracts.companyId, companyId)];
      if (query.type) conditions.push(eq(contracts.type, query.type));
      if (query.includeSuperseded !== "true") conditions.push(ne(contracts.status, "superseded"));
      const rows = await db
        .select({
          id: contracts.id,
          title: contracts.title,
          type: contracts.type,
          status: contracts.status,
          versionNo: contracts.versionNo,
          effectiveDate: contracts.effectiveDate,
          expiryDate: contracts.expiryDate,
          summary: contracts.summary,
          createdAt: contracts.createdAt,
          assetId: assets.id,
          filename: assets.originalFilename,
          contentType: assets.contentType,
        })
        .from(contracts)
        .leftJoin(assets, and(eq(assets.id, contracts.assetId), eq(assets.companyId, contracts.companyId)))
        .where(and(...conditions))
        .orderBy(desc(contracts.createdAt))
        .limit(2000);
      if (rows.length === 0) return { contracts: [] as FoundContract[], totalMatches: 0 };

      const partyRows = await db
        .select({
          contractId: contractParties.contractId,
          role: contractParties.role,
          name: sql<string | null>`coalesce(${contractParties.name}, ${crmOrganizations.name})`,
        })
        .from(contractParties)
        .leftJoin(
          crmOrganizations,
          and(eq(crmOrganizations.id, contractParties.organizationId), eq(crmOrganizations.companyId, contractParties.companyId)),
        )
        .where(and(eq(contractParties.companyId, companyId), inArray(contractParties.contractId, rows.map((row) => row.id))));
      const partiesByContract = new Map<string, Array<{ role: string; name: string | null }>>();
      for (const row of partyRows) {
        const list = partiesByContract.get(row.contractId) ?? [];
        list.push({ role: row.role, name: row.name });
        partiesByContract.set(row.contractId, list);
      }

      const tokens = tokenize(query.q ?? "");
      const partyFilter = query.party ? normalizePartyName(query.party) : null;
      const scored: FoundContract[] = [];
      for (const row of rows) {
        const parties = partiesByContract.get(row.id) ?? [];
        if (partyFilter && !parties.some((party) => party.name && normalizePartyName(party.name).includes(partyFilter))) continue;
        let score = 0;
        if (tokens.length > 0) {
          const titleWords = tokenize(row.title);
          const partyWords = parties.flatMap((party) => tokenize(party.name ?? ""));
          const summaryWords = tokenize(row.summary ?? "");
          const typeWords = tokenize(row.type.replace(/_/g, " "));
          for (const token of tokens) {
            if (wordMatches(token, titleWords)) score += 4;
            if (wordMatches(token, partyWords)) score += 3;
            if (wordMatches(token, typeWords)) score += 2;
            if (wordMatches(token, summaryWords)) score += 1;
          }
          if (score === 0) continue;
        }
        scored.push({
          id: row.id,
          title: row.title,
          type: row.type,
          status: row.status,
          versionNo: row.versionNo,
          effectiveDate: row.effectiveDate,
          expiryDate: row.expiryDate,
          summary: row.summary,
          parties,
          file: row.assetId
            ? {
                assetId: row.assetId,
                contentPath: `/api/assets/${row.assetId}/content`,
                filename: row.filename,
                contentType: row.contentType,
              }
            : null,
          score,
          createdAt: row.createdAt,
        });
      }
      scored.sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());
      const limit = query.limit ?? 10;
      return {
        contracts: scored.slice(0, limit).map(({ createdAt: _createdAt, ...rest }) => rest),
        totalMatches: scored.length,
      };
    },

    /**
     * Case-insensitive text search over the extracted text, as snippets. It
     * always reports how many contracts in scope have no readable text, so
     * "not found" is never mistaken for "not in the contract".
     */
    searchContractText: async (companyId: string, query: SearchContractTextQuery) => {
      const statuses = query.statuses && query.statuses.length > 0 ? query.statuses : DEFAULT_AGGREGATE_STATUSES;
      const scope = [eq(contracts.companyId, companyId), inArray(contracts.status, statuses)];
      if (query.type) scope.push(eq(contracts.type, query.type));
      const hasText = sql<boolean>`coalesce(length(${contracts.extractedText}), 0) > 0`;

      const inScope = await db
        .select({ id: contracts.id, title: contracts.title, textStatus: contracts.textStatus, hasText })
        .from(contracts)
        .where(and(...scope))
        .limit(5000);

      const limit = query.limit ?? 10;
      const matched = await db
        .select({
          id: contracts.id,
          title: contracts.title,
          type: contracts.type,
          status: contracts.status,
          extractedText: contracts.extractedText,
        })
        .from(contracts)
        .where(and(...scope, ilike(contracts.extractedText, `%${escapeLike(query.q)}%`)))
        .orderBy(desc(contracts.createdAt))
        .limit(limit + 1);

      return {
        contractsInScope: inScope.length,
        withExtractedText: inScope.filter((row) => row.hasText).length,
        withoutExtractedText: inScope
          .filter((row) => !row.hasText)
          .map((row) => ({ contractId: row.id, title: row.title, textStatus: row.textStatus })),
        matches: matched.slice(0, limit).map((row) => ({
          contractId: row.id,
          title: row.title,
          type: row.type,
          status: row.status,
          snippets: extractSnippets(row.extractedText ?? "", query.q),
        })),
        moreMatchesThanShown: matched.length > limit,
      };
    },

    /** Registry keys plus any free-form keys already in use in this company. */
    listTermKeys: async (companyId: string) => {
      const used = await db
        .selectDistinct({ key: contractTerms.key })
        .from(contractTerms)
        .where(eq(contractTerms.companyId, companyId));
      return [...new Set([...CONTRACT_TERM_REGISTRY_KEYS, ...used.map((row) => row.key)])].sort();
    },
  };

  return {
    ...api,

    /** The aggregate plus contract titles and the plain-words coverage an answer must quote. */
    aggregateTermReport: async (
      companyId: string,
      key: string,
      filters: Pick<AggregateContractTermQuery, "type" | "statuses" | "partyOrganizationId"> = {},
    ): Promise<ContractTermCoverageReport> => {
      const aggregate = await api.aggregateTerm(companyId, key, filters);
      const ids = new Set<string>();
      for (const bucket of [aggregate.withValue, aggregate.notMentioned, aggregate.explicitlyNone, aggregate.noTermRecorded, aggregate.malformed]) {
        for (const ref of bucket.contracts) ids.add(ref.contractId);
      }
      const contractTitles: Record<string, string> = {};
      if (ids.size > 0) {
        const rows = await db
          .select({ id: contracts.id, title: contracts.title })
          .from(contracts)
          .where(and(eq(contracts.companyId, companyId), inArray(contracts.id, [...ids])));
        for (const row of rows) contractTitles[row.id] = row.title;
      }
      return { ...aggregate, contractTitles, coverageText: describeAggregateCoverage(aggregate, contractTitles) };
    },
  };
}
