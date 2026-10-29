import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { approvals, tradingLedgerEntries, tradingStrategies, tradingStrategyVersions, withCompanyScope, type Db } from "@paperclipai/db";
import {
  TRADING_STRATEGY_VERSION_APPROVAL_KIND,
  canonicalTradingJson,
  deriveTradingRiskConfig,
  describeTradingSpec,
  legacySmaConfigFromSpec,
  legacySmaCrossoverSpec,
  tradingCacheForVersion,
  tradingRiskConfigSchema,
  tradingRiskLoosenings,
  tradingRuleBookDigestInput,
  tradingRuleBookSchema,
  tradingRuleConfigSchema,
  tradingRuleVersionLabel,
  tradingStrategySpecSchema,
  type TradingRuleBook,
  type TradingRuleBookInput,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * DUR-5002: the versions of a strategy's rule book.
 *
 * ONE SOURCE OF TRUTH. The tick reads only the strategy's active version
 * (trading_strategies.active_version_id -> an approved row here).
 * rule_config and risk_config on the strategy are a cache of that version,
 * and the only code that writes them is `writeActivation` below, inside the
 * activation transaction (plus the strategy's creation, which goes through
 * the same function).
 *
 * APPROVAL FIRST. A change to the rules is only ever a DRAFT version plus an
 * approval card (kind "trading_strategy_version") that the service files from
 * the stored draft. The card text is generated from the stored spec and
 * guidelines, so a card whose text differs from the stored draft cannot be
 * produced; approving it (approveFromCard) re-checks the digest and the text
 * and activates exactly that stored version. Only a company owner or admin
 * can do so, only on the card itself (routes/approvals.ts, and
 * isApprovalCardOnlyKind in services/approvals.ts for every other path).
 *
 * Every query filters on the caller's company; an id from another company is
 * simply "not found".
 */

export type TradingStrategyRow = typeof tradingStrategies.$inferSelect;
export type TradingStrategyVersionRow = typeof tradingStrategyVersions.$inferSelect;

export interface TradingVersionsDeps {
  now?: () => Date;
  /** The raw (non request-scoped) db, for transactions. Defaults to `db`. */
  rawDb?: Db;
}

export type TradingProposer = { type: "user"; id: string } | { type: "agent"; id: string } | { type: "system"; id: string };

export type ProposeVersionResult =
  | { outcome: "drafted"; version: TradingStrategyVersionRow; approvalId: string }
  | { outcome: "unchanged"; version: TradingStrategyVersionRow }
  | { outcome: "already_pending"; version: TradingStrategyVersionRow; approvalId: string | null };

/** SHA-256 over the canonical spec + guidelines. The card shows the same digest. */
export function tradingRuleBookDigest(book: Pick<TradingRuleBook, "spec" | "guidelines">): string {
  return createHash("sha256").update(tradingRuleBookDigestInput(book)).digest("hex");
}

/**
 * The label stamped on orders: the old `sma_crossover@1 · engine N` while the
 * rules are exactly that rule (so old history reads the same), else the
 * version number. The exact version is also stamped by id on every order.
 */
export function tradingVersionLabel(version: Pick<TradingStrategyVersionRow, "version" | "spec">, engineVersion: number): string {
  const parsed = tradingStrategySpecSchema.safeParse(version.spec);
  if (parsed.success) {
    const legacy = legacySmaConfigFromSpec(parsed.data);
    if (legacy) return tradingRuleVersionLabel(legacy);
  }
  return `strategy_spec@v${version.version} · engine ${engineVersion}`;
}

/** Everything on an approval card, generated from the stored version and nothing else. */
export function tradingVersionCardPayload(strategy: { id: string; name: string }, version: TradingStrategyVersionRow, spec: TradingStrategySpec): Record<string, unknown> {
  const readBack = describeTradingSpec(spec);
  const proposer = version.proposedByType === "agent" ? "The Trading Analyst" : version.proposedByType === "system" ? "The system" : "A team member";
  const summary = readBack.join(" ");
  return {
    kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND,
    strategyId: strategy.id,
    strategyName: strategy.name,
    versionId: version.id,
    versionNumber: version.version,
    specDigest: version.specDigest,
    proposedByType: version.proposedByType,
    proposedById: version.proposedById,
    title: tradingVersionCardTitle(strategy.name, version.version),
    summary,
    plainSummary: `${proposer} proposes new rules (version ${version.version}) for the paper-trading strategy "${strategy.name}". Approving switches the strategy to exactly these rules from its next check; it trades play money only. ${summary}`,
    readBack,
    guidelines: version.guidelines,
  };
}

function tradingVersionCardTitle(strategyName: string, versionNumber: number): string {
  return `Trading strategy "${strategyName}": new rules (version ${versionNumber})`;
}

/**
 * Why a card does not show the stored draft, or null when every field the
 * service writes matches what is generated from the stored row now. Extra keys
 * on the card are ignored: they cannot change what approving activates, which
 * is always the stored row.
 */
export function tradingVersionCardMismatch(payload: Record<string, unknown> | null, expected: Record<string, unknown>): string | null {
  if (!payload) return "the card has no content";
  for (const key of Object.keys(expected)) {
    if (canonicalTradingJson(payload[key]) !== canonicalTradingJson(expected[key])) return `the card's ${key} differs from the stored draft`;
  }
  return null;
}

/** The strategy name a card was filed under (the name can change afterwards without invalidating the card). */
function cardStrategyName(payload: unknown, fallback: string): string {
  const name = (payload as Record<string, unknown> | null)?.strategyName;
  return typeof name === "string" && name.length > 0 ? name : fallback;
}

export function tradingVersionsService(db: Db, deps: TradingVersionsDeps = {}) {
  const rawDb = deps.rawDb ?? db;
  const nowOf = () => deps.now?.() ?? new Date();

  async function inTransaction<T>(companyId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return withCompanyScope(rawDb, companyId, (tx) => fn(tx as unknown as Db));
  }

  async function requireStrategy(handle: Db, companyId: string, strategyId: string, lock = false): Promise<TradingStrategyRow> {
    const query = handle
      .select()
      .from(tradingStrategies)
      .where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    const [row] = lock ? await query.for("update") : await query;
    if (!row) throw notFound("Trading strategy not found.");
    return row;
  }

  async function loadVersion(handle: Db, companyId: string, versionId: string): Promise<TradingStrategyVersionRow | null> {
    const [row] = await handle
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.id, versionId), eq(tradingStrategyVersions.companyId, companyId)));
    return row ?? null;
  }

  function parseSpec(version: Pick<TradingStrategyVersionRow, "spec">): TradingStrategySpec {
    const parsed = tradingStrategySpecSchema.safeParse(version.spec);
    if (!parsed.success) {
      throw unprocessable("The stored rules of this version no longer pass validation, so it cannot be used.", { issues: parsed.error.issues.slice(0, 10) });
    }
    return parsed.data;
  }

  /** The policy every version must satisfy for its strategy; shared by drafting and approving. */
  function assertFitsStrategy(strategy: TradingStrategyRow, spec: TradingStrategySpec, activeSpec: TradingStrategySpec | null, proposer: { type: string }) {
    if (spec.universe.assets.length !== 1 || spec.universe.assets[0] !== strategy.asset) {
      throw unprocessable(`A strategy trades one coin. These rules must list exactly ${strategy.asset}; to trade another coin create another strategy.`);
    }
    if (spec.universe.decisionTimeframe !== strategy.timeframe) {
      throw unprocessable(`This strategy decides on ${strategy.timeframe} candles and that cannot change; a different timeframe is a different strategy.`);
    }
    // Limits are never loosened by an agent: it may only tighten what is in force.
    if (proposer.type === "agent" && activeSpec) {
      const loosened = tradingRiskLoosenings(deriveTradingRiskConfig(activeSpec), deriveTradingRiskConfig(spec));
      if (loosened.length > 0) {
        throw unprocessable(`An agent can only tighten the risk limits, never loosen them. These would be looser: ${loosened.join(", ")}.`, { loosened });
      }
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  async function listVersions(companyId: string, strategyId: string): Promise<TradingStrategyVersionRow[]> {
    await requireStrategy(db, companyId, strategyId);
    return db
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.companyId, companyId), eq(tradingStrategyVersions.strategyId, strategyId)))
      .orderBy(desc(tradingStrategyVersions.version));
  }

  async function getVersion(companyId: string, strategyId: string, versionId: string): Promise<TradingStrategyVersionRow> {
    const row = await loadVersion(db, companyId, versionId);
    if (!row || row.strategyId !== strategyId) throw notFound("Strategy version not found.");
    return row;
  }

  // ─── Activation: the only writer of the cache columns ──────────────────

  /**
   * Inside the caller's transaction and with the strategy row locked: make
   * `version` (a draft, or a version being created as approved) the active
   * version, supersede the previous one, and rewrite the cache columns from
   * the version.
   */
  async function writeActivation(tx: Db, strategy: TradingStrategyRow, version: TradingStrategyVersionRow, approvedByUserId: string | null, at: Date, note: string, writeLedgerNote = true) {
    const spec = parseSpec(version);
    if (strategy.activeVersionId && strategy.activeVersionId !== version.id) {
      await tx
        .update(tradingStrategyVersions)
        .set({ status: "superseded", supersededAt: at, updatedAt: at })
        .where(and(eq(tradingStrategyVersions.id, strategy.activeVersionId), eq(tradingStrategyVersions.status, "approved")));
    }
    if (version.status !== "approved") {
      await tx
        .update(tradingStrategyVersions)
        .set({ status: "approved", approvedByUserId, approvedAt: at, updatedAt: at })
        .where(and(eq(tradingStrategyVersions.id, version.id), eq(tradingStrategyVersions.status, "draft")));
    }
    const cache = tradingCacheForVersion({ spec, versionId: version.id, versionNumber: version.version, specDigest: version.specDigest });
    await tx
      .update(tradingStrategies)
      .set({ activeVersionId: version.id, ruleConfig: cache.ruleConfig, riskConfig: cache.riskConfig, updatedAt: at })
      .where(eq(tradingStrategies.id, strategy.id));
    // A brand-new strategy's first version is its own record; every later switch is also written to the ledger.
    if (!writeLedgerNote) return;
    await tx.insert(tradingLedgerEntries).values({
      companyId: strategy.companyId,
      strategyId: strategy.id,
      strategyVersionId: version.id,
      eventType: "reconciliation",
      detail: {
        reason: "strategy_version_activated",
        note,
        versionId: version.id,
        versionNumber: version.version,
        previousVersionId: strategy.activeVersionId,
        specDigest: version.specDigest,
        approvedByUserId,
      },
    });
  }

  /**
   * Creating a strategy: the owner/admin who creates it approves its first
   * version by creating it. Call inside the transaction that inserted the
   * strategy row.
   */
  async function createInitialVersion(tx: Db, strategy: TradingStrategyRow, book: TradingRuleBook, userId: string): Promise<TradingStrategyVersionRow> {
    const at = nowOf();
    const [created] = await tx
      .insert(tradingStrategyVersions)
      .values({
        companyId: strategy.companyId,
        strategyId: strategy.id,
        version: 1,
        spec: book.spec,
        guidelines: book.guidelines,
        status: "draft",
        proposedByType: "user",
        proposedById: userId,
        specDigest: tradingRuleBookDigest(book),
        grandfathered: false,
      })
      .returning();
    await writeActivation(tx, strategy, created!, userId, at, "first version, approved by the person who created the strategy", false);
    return (await loadVersion(tx, strategy.companyId, created!.id))!;
  }

  // ─── Legacy conversion ─────────────────────────────────────────────────

  /**
   * Converts a strategy that predates the versions table (active_version_id
   * NULL) into an approved, grandfathered version 1 built from its
   * sma_crossover@1 rule_config and risk_config. Idempotent and safe to race:
   * the strategy row is locked, and a second caller finds the version already
   * there.
   */
  async function ensureActiveVersion(strategy: TradingStrategyRow): Promise<{ strategy: TradingStrategyRow; version: TradingStrategyVersionRow; spec: TradingStrategySpec }> {
    if (strategy.activeVersionId) {
      const version = await loadVersion(db, strategy.companyId, strategy.activeVersionId);
      if (version && version.status === "approved" && version.strategyId === strategy.id) return { strategy, version, spec: parseSpec(version) };
    }
    return inTransaction(strategy.companyId, async (tx) => {
      const locked = await requireStrategy(tx, strategy.companyId, strategy.id, true);
      if (locked.activeVersionId) {
        const existing = await loadVersion(tx, locked.companyId, locked.activeVersionId);
        if (existing && existing.status === "approved") return { strategy: locked, version: existing, spec: parseSpec(existing) };
      }
      const rule = tradingRuleConfigSchema.safeParse(locked.ruleConfig);
      const risk = tradingRiskConfigSchema.safeParse(locked.riskConfig);
      if (!rule.success || !risk.success) {
        throw unprocessable("This strategy's stored rule or risk settings are not a valid sma_crossover@1 setup, so it could not be converted to a rule-book version.", {
          strategyId: locked.id,
        });
      }
      const spec = legacySmaCrossoverSpec({ name: locked.name, asset: locked.asset as TradingStrategySpec["universe"]["assets"][number], timeframe: locked.timeframe as TradingStrategySpec["universe"]["decisionTimeframe"], rule: rule.data, risk: risk.data });
      const book: TradingRuleBook = { spec, guidelines: "" };
      const at = nowOf();
      const [maxRow] = await tx
        .select({ max: sql<number>`coalesce(max(${tradingStrategyVersions.version}), 0)::int` })
        .from(tradingStrategyVersions)
        .where(eq(tradingStrategyVersions.strategyId, locked.id));
      const [created] = await tx
        .insert(tradingStrategyVersions)
        .values({
          companyId: locked.companyId,
          strategyId: locked.id,
          version: (maxRow?.max ?? 0) + 1,
          spec,
          guidelines: "",
          status: "draft",
          proposedByType: "system",
          proposedById: "legacy_conversion",
          specDigest: tradingRuleBookDigest(book),
          grandfathered: true,
        })
        .returning();
      await writeActivation(tx, locked, created!, null, at, "converted from the original sma_crossover@1 rule; exempt from the past-data start gate");
      const version = (await loadVersion(tx, locked.companyId, created!.id))!;
      const [reloaded] = await tx.select().from(tradingStrategies).where(eq(tradingStrategies.id, locked.id));
      return { strategy: reloaded!, version, spec };
    });
  }

  /** Boot: convert every strategy that has no active version yet. Never throws for one bad row. */
  async function convertLegacyStrategies(): Promise<{ converted: number; failed: number }> {
    const rows = await db.select().from(tradingStrategies).where(sql`${tradingStrategies.activeVersionId} IS NULL`).orderBy(asc(tradingStrategies.createdAt));
    let converted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await ensureActiveVersion(row);
        converted++;
      } catch (err) {
        failed++;
        logger.error({ err, strategyId: row.id, companyId: row.companyId }, "trading: could not convert a legacy strategy to a rule-book version");
      }
    }
    return { converted, failed };
  }

  // ─── Drafting ──────────────────────────────────────────────────────────

  /**
   * Stores a proposed rule book as a draft version and files the approval
   * card for it, from the stored row. Nothing changes for the running
   * strategy until an owner or admin approves the card. A newer proposal
   * supersedes an older open draft and closes its card.
   */
  async function proposeVersion(companyId: string, strategyId: string, input: TradingRuleBookInput, proposer: TradingProposer): Promise<ProposeVersionResult> {
    const strategyRow = await requireStrategy(db, companyId, strategyId);
    const { strategy, version: active, spec: activeSpec } = await ensureActiveVersion(strategyRow);
    const parsed = tradingRuleBookSchema.safeParse(input);
    if (!parsed.success) {
      throw unprocessable("These rules are not valid.", { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const book = parsed.data;
    assertFitsStrategy(strategy, book.spec, activeSpec, proposer);
    const digest = tradingRuleBookDigest(book);
    if (digest === active.specDigest) return { outcome: "unchanged", version: active };

    return inTransaction(companyId, async (tx) => {
      const locked = await requireStrategy(tx, companyId, strategyId, true);
      const openDrafts = await tx
        .select()
        .from(tradingStrategyVersions)
        .where(and(eq(tradingStrategyVersions.strategyId, strategyId), eq(tradingStrategyVersions.status, "draft")));
      const same = openDrafts.find((d) => d.specDigest === digest);
      if (same) return { outcome: "already_pending" as const, version: same, approvalId: same.approvalId };
      const at = nowOf();
      for (const draft of openDrafts) {
        await tx.update(tradingStrategyVersions).set({ status: "superseded", supersededAt: at, updatedAt: at }).where(eq(tradingStrategyVersions.id, draft.id));
        if (draft.approvalId) {
          await tx
            .update(approvals)
            .set({ status: "cancelled", decisionNote: "Replaced by a newer proposal for the same strategy.", decidedAt: at, updatedAt: at })
            .where(and(eq(approvals.id, draft.approvalId), inArray(approvals.status, ["pending", "revision_requested"])));
        }
      }
      const [maxRow] = await tx
        .select({ max: sql<number>`coalesce(max(${tradingStrategyVersions.version}), 0)::int` })
        .from(tradingStrategyVersions)
        .where(eq(tradingStrategyVersions.strategyId, strategyId));
      const [draft] = await tx
        .insert(tradingStrategyVersions)
        .values({
          companyId,
          strategyId,
          version: (maxRow?.max ?? 0) + 1,
          spec: book.spec,
          guidelines: book.guidelines,
          status: "draft",
          proposedByType: proposer.type,
          proposedById: proposer.id,
          specDigest: digest,
          grandfathered: false,
        })
        .returning();
      const stored = draft!;
      const [card] = await tx
        .insert(approvals)
        .values({
          companyId,
          type: "request_board_approval",
          requestedByAgentId: proposer.type === "agent" ? proposer.id : null,
          requestedByUserId: proposer.type === "user" ? proposer.id : null,
          status: "pending",
          // Built from the stored row (what the database holds), not from the request body.
          payload: tradingVersionCardPayload({ id: locked.id, name: locked.name }, stored, parseSpec(stored)),
        })
        .returning({ id: approvals.id });
      await tx.update(tradingStrategyVersions).set({ approvalId: card!.id, updatedAt: at }).where(eq(tradingStrategyVersions.id, stored.id));
      await tx.insert(tradingLedgerEntries).values({
        companyId,
        strategyId,
        strategyVersionId: stored.id,
        eventType: "reconciliation",
        detail: { reason: "strategy_version_proposed", versionId: stored.id, versionNumber: stored.version, specDigest: digest, proposedBy: proposer, approvalId: card!.id },
      });
      return { outcome: "drafted" as const, version: (await loadVersion(tx, companyId, stored.id))!, approvalId: card!.id };
    });
  }

  // ─── Approving ─────────────────────────────────────────────────────────

  async function versionForCard(handle: Db, companyId: string, approvalId: string): Promise<TradingStrategyVersionRow | null> {
    const [row] = await handle
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.approvalId, approvalId), eq(tradingStrategyVersions.companyId, companyId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The owner/admin's approve action on the card. The caller (the approvals
   * route) has already checked the actor is a person who is a company owner
   * or admin. The card is only the button: the version is the one whose own
   * approval_id is this card, and what is activated is that stored row,
   * after its digest and the card text have been checked against it.
   */
  async function approveFromCard(companyId: string, approvalId: string, userId: string): Promise<{ strategy: TradingStrategyRow; version: TradingStrategyVersionRow }> {
    const linked = await versionForCard(db, companyId, approvalId);
    if (!linked) {
      throw unprocessable("This card is not the approval card of any strategy version, so it cannot change anything. Do not trust the rules it shows.", { code: "trading_version_card_not_linked" });
    }
    return inTransaction(companyId, async (tx) => {
      const strategy = await requireStrategy(tx, companyId, linked.strategyId, true);
      const version = await loadVersion(tx, companyId, linked.id);
      if (!version) throw notFound("Strategy version not found.");
      if (version.status === "approved" && strategy.activeVersionId === version.id) return { strategy, version }; // already live: approving twice is harmless
      if (version.status !== "draft") {
        throw unprocessable("These rules were replaced by a newer proposal. Approve the newer card instead.", { code: "trading_version_not_a_draft" });
      }
      const [card] = await tx.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));
      if (!card || (card.status !== "pending" && card.status !== "revision_requested")) {
        throw unprocessable("There is no open approval card for this version.", { code: "trading_version_card_closed" });
      }
      if (tradingRuleBookDigest({ spec: version.spec as TradingStrategySpec, guidelines: version.guidelines }) !== version.specDigest) {
        throw conflict("The stored rules do not match their recorded digest. Nothing was approved.", { code: "trading_version_digest_mismatch" });
      }
      const spec = parseSpec(version);
      const mismatch = tradingVersionCardMismatch((card.payload ?? null) as Record<string, unknown> | null, tradingVersionCardPayload({ id: strategy.id, name: cardStrategyName(card.payload, strategy.name) }, version, spec));
      if (mismatch) {
        throw conflict(`The card does not show the stored rules (${mismatch}). Nothing was approved.`, { code: "trading_version_card_mismatch" });
      }
      const active = strategy.activeVersionId ? await loadVersion(tx, companyId, strategy.activeVersionId) : null;
      assertFitsStrategy(strategy, spec, active ? parseSpec(active) : null, { type: version.proposedByType });
      await writeActivation(tx, strategy, version, userId, nowOf(), "approved on its approval card");
      const [reloaded] = await tx.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategy.id));
      return { strategy: reloaded!, version: (await loadVersion(tx, companyId, version.id))! };
    });
  }

  /** A rejected or withdrawn card closes its draft. Harmless if the version is not a draft any more. */
  async function supersedeDraftForCard(companyId: string, approvalId: string): Promise<void> {
    const at = nowOf();
    await db
      .update(tradingStrategyVersions)
      .set({ status: "superseded", supersededAt: at, updatedAt: at })
      .where(and(eq(tradingStrategyVersions.approvalId, approvalId), eq(tradingStrategyVersions.companyId, companyId), eq(tradingStrategyVersions.status, "draft")));
  }

  /**
   * What the card UI shows: the rules as STORED (never the payload's copy),
   * whether the card text matches them, and whether the digest still holds.
   */
  async function getCardSource(companyId: string, approvalId: string) {
    const [card] = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));
    const version = card ? await versionForCard(db, companyId, approvalId) : null;
    if (!card || !version) throw notFound("This card is not linked to any strategy version. Do not approve it.");
    const strategy = await requireStrategy(db, companyId, version.strategyId);
    const spec = parseSpec(version);
    const digestHolds = tradingRuleBookDigest({ spec: version.spec as TradingStrategySpec, guidelines: version.guidelines }) === version.specDigest;
    const mismatch = tradingVersionCardMismatch((card.payload ?? null) as Record<string, unknown> | null, tradingVersionCardPayload({ id: strategy.id, name: cardStrategyName(card.payload, strategy.name) }, version, spec));
    return {
      approvalId,
      strategyId: strategy.id,
      versionId: version.id,
      versionNumber: version.version,
      status: version.status,
      spec,
      guidelines: version.guidelines,
      specDigest: version.specDigest,
      readBack: describeTradingSpec(spec),
      storedRulesMatchDigest: digestHolds,
      matchesCard: mismatch === null,
      mismatch,
    };
  }

  return {
    listVersions,
    getVersion,
    ensureActiveVersion,
    convertLegacyStrategies,
    createInitialVersion,
    proposeVersion,
    approveFromCard,
    supersedeDraftForCard,
    getCardSource,
    parseSpec,
    inTransaction,
  };
}
