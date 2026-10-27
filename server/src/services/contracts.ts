import { and, asc, desc, eq, exists, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companyAgentRoles,
  contractDeadlines,
  contractParties,
  contractTerms,
  contracts,
  crmOrganizations,
  issues,
  withCompanyScope,
} from "@paperclipai/db";
import {
  CONTRACT_STATUSES,
  CONTRACT_TERM_REGISTRY_KEYS,
  contractTermKeySchema,
  defaultLeadTimesDaysForKind,
  type AggregateContractTermQuery,
  type ContractStatus,
  type ContractTermAggregate,
  type ContractTermNumericStats,
  type ContractTermRef,
  type CreateContract,
  type CreateContractDeadline,
  type CreateContractParty,
  type LinkPreviousContractVersion,
  type ListContractDeadlinesQuery,
  type ListContractsQuery,
  type UpdateContract,
  type UpdateContractDeadline,
  type UpdateContractParty,
  type UpsertContractTerm,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
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

  function toDeadlineValues(companyId: string, contractId: string, input: CreateContractDeadline) {
    return {
      companyId,
      contractId,
      kind: input.kind,
      dueDate: input.dueDate,
      leadTimesDays: input.leadTimesDays ?? defaultLeadTimesDaysForKind(input.kind),
      clauseRef: input.clauseRef ?? null,
      note: input.note ?? null,
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

  return {
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
    linkPreviousVersion: async (companyId: string, currentId: string, input: LinkPreviousContractVersion) => {
      if (currentId === input.previousContractId) throw unprocessable("A contract cannot supersede itself");
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
        .values(toDeadlineValues(companyId, contractId, input))
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
      const values = {
        valueKind: input.valueKind,
        numberValue: input.valueKind === "number" ? String(input.numberValue) : null,
        currency: input.valueKind === "number" && input.currency ? input.currency.toUpperCase() : null,
        textValue: input.valueKind === "text" ? input.textValue ?? null : null,
        boolValue: input.valueKind === "bool" ? input.boolValue ?? null : null,
        clauseRef: input.clauseRef ?? null,
        pageRef: input.pageRef ?? null,
      };
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

    /** Registry keys plus any free-form keys already in use in this company. */
    listTermKeys: async (companyId: string) => {
      const used = await db
        .selectDistinct({ key: contractTerms.key })
        .from(contractTerms)
        .where(eq(contractTerms.companyId, companyId));
      return [...new Set([...CONTRACT_TERM_REGISTRY_KEYS, ...used.map((row) => row.key)])].sort();
    },
  };
}
