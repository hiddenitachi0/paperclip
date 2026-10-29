import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { approvals, tradingLedgerEntries, tradingOrders, tradingStrategies, tradingStrategyVersions, withCompanyScope, type Db } from "@paperclipai/db";
import {
  TRADING_STRATEGY_VERSION_APPROVAL_KIND,
  describeStrategyDocument,
  describeStrategyLoosening,
  legacySmaCrossoverDocument,
  projectStrategyCache,
  smaCrossoverConfigSchema,
  splitStrategyDocument,
  strategyDigestInput,
  strategyDocumentSchema,
  strategyEngineSpecSchema,
  tradingRiskConfigSchema,
  type StrategyDocument,
  type StrategyEngineSpec,
  type TradingAsset,
  type TradingTimeframe,
  type TradingStrategyVersionProposerType,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

/**
 * DUR-5002: the versioned rule book (plan section 3 of the trading rebuild).
 *
 * One source of truth: the tick reads only the version
 * `trading_strategies.active_version_id` points at. `rule_config` and
 * `risk_config` on the strategy row are a cache of it, written only in the
 * activation transaction (and, for a brand-new strategy, together with its first
 * version) -- the database trigger from migration 0262 refuses any other write.
 * A proposal never activates anything: it stores an immutable draft and files a
 * card-only approval (kind "trading_strategy_version") built from that stored
 * draft; approving the card on the card itself activates exactly that stored
 * version (routes/approvals.ts passes the activation hook; services/approvals.ts
 * refuses every other path).
 *
 * Multi-statement writes use withCompanyScope on the raw connection: the
 * request-scoped db does not support transactions.
 */

export type TradingStrategyVersionRow = typeof tradingStrategyVersions.$inferSelect;
export type TradingStrategyRow = typeof tradingStrategies.$inferSelect;

export interface TradingStrategyProposer {
  type: TradingStrategyVersionProposerType;
  id: string | null;
}

export interface ActiveStrategyVersion {
  row: TradingStrategyVersionRow;
  /** Engine spec, parsed from the stored jsonb. Never carries guidelines. */
  spec: StrategyEngineSpec;
  guidelines: string;
}

export function digestStrategySpec(spec: StrategyEngineSpec, guidelines: string): string {
  return createHash("sha256").update(strategyDigestInput(spec, guidelines), "utf8").digest("hex");
}

/** Parses a stored version row and checks its recorded digest against its content. Throws if either is wrong. */
export function readStoredVersion(row: TradingStrategyVersionRow): ActiveStrategyVersion {
  const parsed = strategyEngineSpecSchema.safeParse(row.spec);
  if (!parsed.success) {
    throw unprocessable(`Strategy version ${row.version} is stored in a shape the engine does not accept; it was not used.`, { code: "trading_version_invalid" });
  }
  const digest = digestStrategySpec(parsed.data, row.guidelines);
  if (digest !== row.specDigest) {
    throw unprocessable(`Strategy version ${row.version} does not match its recorded digest; it was not used.`, { code: "trading_version_digest_mismatch" });
  }
  return { row, spec: parsed.data, guidelines: row.guidelines };
}

/**
 * The approval card's payload, a pure function of the stored version row. The
 * card is filed from it and, at approve time, the card on file must equal it
 * exactly: a card whose text differs from the stored draft cannot be produced
 * by this service and cannot be approved.
 */
export function buildStrategyVersionCardPayload(row: TradingStrategyVersionRow): Record<string, unknown> {
  const { spec, guidelines } = readStoredVersion(row);
  const cardText = describeStrategyDocument(spec, guidelines);
  const proposer = row.proposedByType === "agent" ? "An agent" : row.proposedByType === "system" ? "Paperclip" : "A team member";
  const summary = `${proposer} proposed version ${row.version} of the trading strategy "${spec.meta.name}". It is not running yet. Nothing changes until you approve this card.`;
  return {
    kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND,
    title: `Approve trading strategy "${spec.meta.name}", version ${row.version}`,
    summary,
    plainSummary: `${summary} Approving switches the strategy to exactly the rules written below (paper money only). Read them first.`,
    recommendedAction: "Read the rules and the limits below. The first line of each section is what the strategy will do.",
    nextActionOnApproval: "This version becomes the strategy's active rule book, replacing the current one. A running strategy picks it up on its next check.",
    risks: ["Paper money only. Real money stays locked server-wide."],
    strategyId: row.strategyId,
    strategyVersionId: row.id,
    versionNo: row.version,
    specDigest: row.specDigest,
    proposedBy: { type: row.proposedByType, id: row.proposedById },
    cardText,
  };
}

/**
 * Is `card` exactly the card of a stored draft? Reads only the version whose
 * own approval_id is this card (never an id from the payload) and compares the
 * whole payload with the one rebuilt from the stored row. Returns the version.
 * Used by services/approvals.ts before it will decide the card.
 */
export async function verifyStrategyVersionCard(db: Db, card: { id: string; companyId: string; payload: unknown }): Promise<TradingStrategyVersionRow> {
  const [version] = await db
    .select()
    .from(tradingStrategyVersions)
    .where(and(eq(tradingStrategyVersions.approvalId, card.id), eq(tradingStrategyVersions.companyId, card.companyId)))
    .limit(1);
  if (!version) {
    throw unprocessable("This card is not the approval card of any stored strategy version, so it cannot approve anything.", { code: "trading_version_card_not_linked" });
  }
  if (version.status !== "draft") {
    throw conflict(`This card's version is already ${version.status}. Nothing was changed.`, { code: "trading_version_not_draft" });
  }
  const expected = buildStrategyVersionCardPayload(version);
  if (JSON.stringify(sortKeys(card.payload)) !== JSON.stringify(sortKeys(expected))) {
    throw unprocessable("The text on this card is not the stored draft, so it cannot be approved. Reject it and ask for a new one.", { code: "trading_version_card_mismatch" });
  }
  return version;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** The card was rejected: its draft will never be activated, so it no longer counts as the open draft. */
export async function closeStrategyVersionDraftForCard(db: Db, card: { id: string; companyId: string }, at: Date = new Date()): Promise<void> {
  await db
    .update(tradingStrategyVersions)
    .set({ status: "superseded", supersededAt: at, updatedAt: at })
    .where(and(eq(tradingStrategyVersions.approvalId, card.id), eq(tradingStrategyVersions.companyId, card.companyId), eq(tradingStrategyVersions.status, "draft")));
}

export interface TradingStrategyVersionServiceDeps {
  /** The raw connection, for transactions. Defaults to `db` (tests, the scheduler). */
  rawDb?: Db;
  now?: () => Date;
}

type ScopedDb = Parameters<Parameters<typeof withCompanyScope>[2]>[0];

export function tradingStrategyVersionService(db: Db, deps: TradingStrategyVersionServiceDeps = {}) {
  const rawDb = deps.rawDb ?? db;
  const nowOf = () => deps.now?.() ?? new Date();

  async function requireStrategy(companyId: string, strategyId: string): Promise<TradingStrategyRow> {
    const [row] = await db.select().from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!row) throw notFound("Trading strategy not found.");
    return row;
  }

  async function listVersions(companyId: string, strategyId: string): Promise<TradingStrategyVersionRow[]> {
    return db
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.companyId, companyId), eq(tradingStrategyVersions.strategyId, strategyId)))
      .orderBy(desc(tradingStrategyVersions.version));
  }

  /** The active version of a strategy row, verified against its digest; null when it has none yet. */
  async function loadActive(strategy: Pick<TradingStrategyRow, "id" | "companyId" | "activeVersionId">): Promise<ActiveStrategyVersion | null> {
    if (!strategy.activeVersionId) return null;
    const [row] = await db
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.id, strategy.activeVersionId), eq(tradingStrategyVersions.strategyId, strategy.id), eq(tradingStrategyVersions.companyId, strategy.companyId)));
    if (!row || row.status !== "approved") return null;
    return readStoredVersion(row);
  }

  /** Document checks that need the strategy row: the document must be about this strategy's asset and candle size. */
  function assertDocumentFitsStrategy(strategy: Pick<TradingStrategyRow, "asset" | "timeframe">, doc: StrategyDocument) {
    if (!doc.universe.assets.includes(strategy.asset as TradingAsset)) {
      throw unprocessable(`This rule book does not list ${strategy.asset}, the coin this strategy trades.`, { code: "trading_version_asset_mismatch" });
    }
    if (doc.universe.decisionTimeframe !== (strategy.timeframe as TradingTimeframe)) {
      throw unprocessable(
        `This rule book decides on ${doc.universe.decisionTimeframe} candles but the strategy runs on ${strategy.timeframe}. A different candle size is a different strategy.`,
        { code: "trading_version_timeframe_mismatch" },
      );
    }
  }

  /**
   * Stores `doc` as a new draft version and files the card for it, replacing
   * any older draft (its card is withdrawn). Nothing is activated. An agent
   * proposal may not loosen anything against the active version.
   */
  async function proposeVersion(
    companyId: string,
    strategyId: string,
    input: StrategyDocument,
    proposer: TradingStrategyProposer,
  ): Promise<{ version: TradingStrategyVersionRow; approvalId: string; unchanged: false } | { unchanged: true; activeVersion: TradingStrategyVersionRow }> {
    const doc = strategyDocumentSchema.parse(input);
    const strategy = await requireStrategy(companyId, strategyId);
    assertDocumentFitsStrategy(strategy, doc);
    const { spec, guidelines } = splitStrategyDocument(doc);
    const digest = digestStrategySpec(spec, guidelines);
    const active = await loadActive(strategy);
    if (active && active.row.specDigest === digest) return { unchanged: true, activeVersion: active.row };
    if (proposer.type === "agent" && active) {
      const loosened = describeStrategyLoosening(active.spec, spec);
      if (loosened.length > 0) {
        throw unprocessable(`An agent may only tighten a strategy, never loosen it. ${loosened.join(" ")}`, { code: "trading_version_loosens", loosened });
      }
    }
    if (proposer.type !== "system" && !proposer.id) throw unprocessable("A proposal must say who made it.");

    return withCompanyScope(rawDb, companyId, async (tx) => {
      await tx.execute(sql`SELECT id FROM trading_strategies WHERE id = ${strategyId} AND company_id = ${companyId} FOR UPDATE`);
      const [stale] = await tx
        .select()
        .from(tradingStrategyVersions)
        .where(and(eq(tradingStrategyVersions.strategyId, strategyId), eq(tradingStrategyVersions.status, "draft")));
      const now = nowOf();
      if (stale) {
        await tx.update(tradingStrategyVersions).set({ status: "superseded", supersededAt: now, updatedAt: now }).where(eq(tradingStrategyVersions.id, stale.id));
        if (stale.approvalId) {
          await tx
            .update(approvals)
            .set({ status: "cancelled", decisionNote: "Replaced by a newer proposal.", decidedAt: now, updatedAt: now })
            .where(and(eq(approvals.id, stale.approvalId), inArray(approvals.status, ["pending", "revision_requested"])));
        }
      }
      const [{ next }] = (await tx.execute(
        sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM trading_strategy_versions WHERE strategy_id = ${strategyId}`,
      )) as unknown as Array<{ next: number }>;
      const [draft] = await tx
        .insert(tradingStrategyVersions)
        .values({
          companyId,
          strategyId,
          version: Number(next),
          spec: spec as unknown as Record<string, unknown>,
          guidelines,
          status: "draft",
          proposedByType: proposer.type,
          proposedById: proposer.id,
          specDigest: digest,
        })
        .returning();
      const payload = buildStrategyVersionCardPayload(draft!);
      const [card] = await tx
        .insert(approvals)
        .values({
          companyId,
          type: "request_board_approval",
          requestedByAgentId: proposer.type === "agent" ? proposer.id : null,
          requestedByUserId: proposer.type === "user" ? proposer.id : null,
          status: "pending",
          payload,
        })
        .returning({ id: approvals.id });
      const [linked] = await tx.update(tradingStrategyVersions).set({ approvalId: card!.id, updatedAt: now }).where(eq(tradingStrategyVersions.id, draft!.id)).returning();
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: proposer.type === "agent" ? "agent" : proposer.type === "user" ? "user" : "system",
        actorId: proposer.id ?? "system",
        agentId: proposer.type === "agent" ? proposer.id : null,
        action: "trading_strategy_version.proposed",
        entityType: "trading_strategy_version",
        entityId: draft!.id,
        details: { strategyId, version: draft!.version, specDigest: digest, approvalId: card!.id, replacedDraftId: stale?.id ?? null },
      });
      return { version: linked!, approvalId: card!.id, unchanged: false as const };
    });
  }

  /** Writes the first version of a brand-new strategy together with its cache, in the strategy's own transaction. */
  async function insertStrategyWithFirstVersion(
    companyId: string,
    strategyValues: Omit<typeof tradingStrategies.$inferInsert, "ruleConfig" | "riskConfig" | "companyId" | "activeVersionId">,
    doc: StrategyDocument,
    actor: { actorType: "user" | "agent"; actorId: string },
  ): Promise<TradingStrategyRow> {
    const parsed = strategyDocumentSchema.parse(doc);
    assertDocumentFitsStrategy({ asset: strategyValues.asset, timeframe: strategyValues.timeframe ?? "15m" }, parsed);
    const { spec, guidelines } = splitStrategyDocument(parsed);
    const digest = digestStrategySpec(spec, guidelines);
    const cache = projectStrategyCache(spec, digest, 1);
    return withCompanyScope(rawDb, companyId, async (tx: ScopedDb) => {
      const [strategy] = await tx
        .insert(tradingStrategies)
        .values({ ...strategyValues, companyId, ruleConfig: cache.ruleConfig, riskConfig: cache.riskConfig })
        .returning();
      const now = nowOf();
      // The strategy's creator is the company owner/admin who made this strategy (the create route is owner/admin-only), and they wrote the rules: their create IS the approval of version 1.
      const [version] = await tx
        .insert(tradingStrategyVersions)
        .values({
          companyId,
          strategyId: strategy!.id,
          version: 1,
          spec: spec as unknown as Record<string, unknown>,
          guidelines,
          status: "approved",
          proposedByType: actor.actorType,
          proposedById: actor.actorId,
          approvedByUserId: actor.actorType === "user" ? actor.actorId : null,
          approvedAt: now,
          specDigest: digest,
        })
        .returning();
      const [activated] = await tx
        .update(tradingStrategies)
        .set({ activeVersionId: version!.id })
        .where(eq(tradingStrategies.id, strategy!.id))
        .returning();
      await tx.update(tradingStrategies).set({ updatedAt: now }).where(eq(tradingStrategies.id, strategy!.id));
      return activated!;
    });
  }

  /**
   * The activation: runs inside the approval of the card, via the hook that
   * routes/approvals.ts passes. Re-verifies that the card is exactly the stored
   * draft, then in ONE transaction supersedes the old active version, approves
   * this one, and writes the cache and pointer on the strategy row.
   */
  async function activateFromCard(card: { id: string; companyId: string; payload: unknown }, approvedByUserId: string): Promise<TradingStrategyVersionRow> {
    const checked = await verifyStrategyVersionCard(db, card);
    const stored = readStoredVersion(checked);
    return withCompanyScope(rawDb, card.companyId, async (tx) => {
      const [strategy] = (await tx.execute(
        sql`SELECT id, company_id AS "companyId", asset, timeframe, active_version_id AS "activeVersionId" FROM trading_strategies WHERE id = ${checked.strategyId} AND company_id = ${card.companyId} FOR UPDATE`,
      )) as unknown as Array<Pick<TradingStrategyRow, "id" | "companyId" | "asset" | "timeframe" | "activeVersionId">>;
      if (!strategy) throw notFound("Trading strategy not found.");
      const [fresh] = await tx.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, checked.id));
      if (!fresh || fresh.status !== "draft" || fresh.specDigest !== checked.specDigest) {
        throw conflict("This version is no longer the open draft. Nothing was changed.", { code: "trading_version_not_draft" });
      }
      const now = nowOf();
      if (strategy.activeVersionId) {
        await tx
          .update(tradingStrategyVersions)
          .set({ status: "superseded", supersededAt: now, updatedAt: now })
          .where(and(eq(tradingStrategyVersions.id, strategy.activeVersionId), eq(tradingStrategyVersions.status, "approved")));
      }
      const [approved] = await tx
        .update(tradingStrategyVersions)
        .set({ status: "approved", approvedByUserId, approvedAt: now, updatedAt: now })
        .where(and(eq(tradingStrategyVersions.id, checked.id), eq(tradingStrategyVersions.status, "draft")))
        .returning();
      if (!approved) throw conflict("This version is no longer the open draft. Nothing was changed.", { code: "trading_version_not_draft" });
      const cache = projectStrategyCache(stored.spec, approved.specDigest, approved.version);
      await tx
        .update(tradingStrategies)
        .set({ activeVersionId: approved.id, ruleConfig: cache.ruleConfig, riskConfig: cache.riskConfig, updatedAt: now })
        .where(and(eq(tradingStrategies.id, strategy.id), eq(tradingStrategies.companyId, card.companyId)));
      await tx.insert(tradingLedgerEntries).values({
        companyId: card.companyId,
        strategyId: strategy.id,
        strategyVersionId: approved.id,
        eventType: "reconciliation",
        detail: { reason: "strategy_version_activated", version: approved.version, specDigest: approved.specDigest, approvedByUserId, approvalId: card.id, previousVersionId: strategy.activeVersionId },
      });
      await logActivity(tx as unknown as Db, {
        companyId: card.companyId,
        actorType: "user",
        actorId: approvedByUserId,
        action: "trading_strategy_version.approved",
        entityType: "trading_strategy_version",
        entityId: approved.id,
        details: { strategyId: strategy.id, version: approved.version, specDigest: approved.specDigest, approvalId: card.id, previousVersionId: strategy.activeVersionId },
      });
      return approved;
    });
  }

  /**
   * Boot step: every strategy without an active version (everything that existed
   * before migration 0262) gets a grandfathered legacy version made from its
   * sma_crossover@1 rule_config and risk_config, and its existing orders and
   * ledger rows are stamped with it. Idempotent; one transaction per strategy.
   * The cache columns are not touched: they already hold what the version projects to.
   */
  async function convertLegacyStrategies(): Promise<{ converted: number; skipped: number }> {
    const pending = await db
      .select({ id: tradingStrategies.id, companyId: tradingStrategies.companyId })
      .from(tradingStrategies)
      .where(isNull(tradingStrategies.activeVersionId))
      .orderBy(asc(tradingStrategies.createdAt));
    let converted = 0;
    let skipped = 0;
    for (const { id, companyId } of pending) {
      try {
        const did = await withCompanyScope(rawDb, companyId, async (tx) => {
          const [row] = (await tx.execute(sql`SELECT * FROM trading_strategies WHERE id = ${id} AND company_id = ${companyId} AND active_version_id IS NULL FOR UPDATE`)) as unknown as Array<Record<string, unknown>>;
          if (!row) return false;
          const rule = smaCrossoverConfigSchema.safeParse(row.rule_config);
          const risk = tradingRiskConfigSchema.safeParse(row.risk_config);
          if (!rule.success || !risk.success) {
            logger.warn({ strategyId: id, companyId }, "trading: strategy without an active version has a rule or risk config the legacy conversion cannot read; left alone");
            return false;
          }
          const doc = strategyDocumentSchema.parse(
            legacySmaCrossoverDocument({ name: String(row.name), asset: row.asset as TradingAsset, timeframe: row.timeframe as TradingTimeframe, rule: rule.data, risk: risk.data }),
          );
          const { spec, guidelines } = splitStrategyDocument(doc);
          const digest = digestStrategySpec(spec, guidelines);
          const projected = projectStrategyCache(spec, digest, 1);
          if (JSON.stringify(sortKeys(projected.ruleConfig)) !== JSON.stringify(sortKeys(rule.data)) || JSON.stringify(sortKeys(projected.riskConfig)) !== JSON.stringify(sortKeys(risk.data))) {
            logger.warn({ strategyId: id, companyId }, "trading: legacy conversion would not reproduce the stored rule/risk config; left alone");
            return false;
          }
          const now = nowOf();
          const [version] = await tx
            .insert(tradingStrategyVersions)
            .values({
              companyId,
              strategyId: id,
              version: 1,
              spec: spec as unknown as Record<string, unknown>,
              guidelines,
              status: "approved",
              proposedByType: "system",
              proposedById: null,
              approvedAt: now,
              specDigest: digest,
              grandfathered: true,
            })
            .returning();
          await tx.update(tradingStrategies).set({ activeVersionId: version!.id }).where(eq(tradingStrategies.id, id));
          await tx.update(tradingOrders).set({ strategyVersionId: version!.id }).where(and(eq(tradingOrders.strategyId, id), isNull(tradingOrders.strategyVersionId)));
          await tx.update(tradingLedgerEntries).set({ strategyVersionId: version!.id }).where(and(eq(tradingLedgerEntries.strategyId, id), isNull(tradingLedgerEntries.strategyVersionId)));
          await tx.insert(tradingLedgerEntries).values({
            companyId,
            strategyId: id,
            strategyVersionId: version!.id,
            eventType: "reconciliation",
            detail: { reason: "legacy_version_created", version: 1, specDigest: digest, note: "The sma_crossover@1 rule was converted into a grandfathered legacy version of the rule book. Decisions on closed bars are identical." },
          });
          return true;
        });
        if (did) converted++;
        else skipped++;
      } catch (err) {
        skipped++;
        logger.error({ err, strategyId: id, companyId }, "trading: legacy strategy conversion failed");
      }
    }
    return { converted, skipped };
  }

  return {
    listVersions,
    loadActive,
    proposeVersion,
    insertStrategyWithFirstVersion,
    activateFromCard,
    convertLegacyStrategies,
    assertDocumentFitsStrategy,
  };
}
