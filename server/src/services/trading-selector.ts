import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  tradingLedgerEntries,
  tradingSelectorConfirmations,
  tradingSelectorDecisions,
  tradingSelectorRules,
  tradingShadowCells,
  tradingShadowTrades,
  type Db,
} from "@paperclipai/db";
import {
  TRADING_SELECTOR_RULES_V1,
  canonicalTradingJson,
  latestSelectorCheckpoint,
  runSelector,
  selectorConfirmationTransition,
  walkForwardSelector,
  type SelectorAction,
  type SelectorConfirmationState,
  type SelectorInput,
  type SelectorOutput,
  type ShadowTradeFact,
  type TradingSelectorRules,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";

/**
 * DUR-5015: the strategy selector, monthly.
 *
 * At each fixed checkpoint (00:00 UTC on the 1st) the selector reads what the
 * shadow runs have recorded, decides, and writes the decision as an immutable
 * row. It only chooses among cells and "cash": it has no path to a risk cap,
 * an order, a balance or an approval card. Whoever places paper trades reads
 * the promoted cells from the latest decision; a company with none holds cash.
 *
 * Reproducible: a decision stores the rules version and digest, the state it
 * went in with (confirmation windows, last drawdown stop) and digests of the
 * full input and the output. `reproduce()` rebuilds the input from the stored
 * shadow trades (closed trades never change) and checks both digests.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const digestOf = (value: unknown) => sha256(canonicalTradingJson(value));

type CellRow = typeof tradingShadowCells.$inferSelect;

export const cellKeyOf = (cell: Pick<CellRow, "templateKey" | "templateVersion" | "weather" | "asset">) => `${cell.templateKey}@${cell.templateVersion}|${cell.weather}|${cell.asset}`;

interface StoredConfirmationState {
  cellKey: string;
  status: SelectorConfirmationState["status"];
  checkpointsElapsed: number;
  checkpointsSinceEnd: number | null;
  promoted: boolean;
  /** Trades entered at or after this count toward the window. */
  windowOpenedAt: string;
}

interface StateBefore {
  confirmations: StoredConfirmationState[];
  lastDrawdownAt: string | null;
}

export interface TradingSelectorDeps {
  now?: () => Date;
  rules?: TradingSelectorRules;
}

export function tradingSelectorService(db: Db, deps: TradingSelectorDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const rules: TradingSelectorRules = deps.rules ?? (TRADING_SELECTOR_RULES_V1 as unknown as TradingSelectorRules);

  // ─── Rules ──────────────────────────────────────────────────────────

  /** Writes the rules version if it is not stored yet. A stored version with different content is an error, never an overwrite. */
  async function ensureRules(): Promise<{ version: number; digest: string }> {
    const digest = digestOf(rules);
    await db
      .insert(tradingSelectorRules)
      .values({ version: rules.version, rules: rules as unknown as Record<string, unknown>, digest, note: "Selector rules, written before any shadow result existed (DUR-5015). A change is a new version." })
      .onConflictDoNothing();
    const [stored] = await db.select({ digest: tradingSelectorRules.digest }).from(tradingSelectorRules).where(eq(tradingSelectorRules.version, rules.version));
    if (!stored || stored.digest !== digest) {
      throw new Error(`Selector rules version ${rules.version} is stored with different content than the code. Rule versions never change: add a new version.`);
    }
    return { version: rules.version, digest };
  }

  // ─── Reading the shadow data as the selector sees it ──────────────────

  async function cellsAt(companyId: string, at: Date): Promise<CellRow[]> {
    const rows = await db
      .select()
      .from(tradingShadowCells)
      .where(and(eq(tradingShadowCells.companyId, companyId), lte(tradingShadowCells.firstSeenAt, at)));
    return rows.sort((a, b) => (cellKeyOf(a) < cellKeyOf(b) ? -1 : 1));
  }

  async function closedTrades(companyId: string, cellIds: readonly string[], checkpointAt: Date, decidedAt: Date) {
    if (cellIds.length === 0) return [];
    const rows = await db
      .select({ cellId: tradingShadowTrades.cellId, entryAt: tradingShadowTrades.entryAt, exitAt: tradingShadowTrades.exitAt, r2x: tradingShadowTrades.r2x, id: tradingShadowTrades.id })
      .from(tradingShadowTrades)
      .where(
        and(
          eq(tradingShadowTrades.companyId, companyId),
          inArray(tradingShadowTrades.cellId, [...cellIds]),
          eq(tradingShadowTrades.status, "closed"),
          lte(tradingShadowTrades.exitAt, checkpointAt),
          lte(tradingShadowTrades.resolvedAt, decidedAt),
          sql`${tradingShadowTrades.r2x} IS NOT NULL`,
        ),
      )
      .orderBy(asc(tradingShadowTrades.exitAt), asc(tradingShadowTrades.id));
    return rows.map((r) => ({ cellId: r.cellId, entryAt: r.entryAt!, exitAt: r.exitAt!, r: r.r2x! }));
  }

  /** Builds exactly what the selector is given, from stored data plus the state going in. The cells are the ones registered by the checkpoint; the trades are the ones closed and resolved by then. */
  async function buildInput(companyId: string, checkpointAt: Date, decidedAt: Date, state: StateBefore): Promise<{ input: SelectorInput; cells: CellRow[] }> {
    const cells = await cellsAt(companyId, checkpointAt);
    const trades = await closedTrades(companyId, cells.map((c) => c.id), checkpointAt, decidedAt);
    const byCell = new Map<string, typeof trades>();
    for (const t of trades) {
      const list = byCell.get(t.cellId);
      if (list) list.push(t);
      else byCell.set(t.cellId, [t]);
    }
    const keyToId = new Map(cells.map((c) => [cellKeyOf(c), c.id]));
    const confirmations: SelectorConfirmationState[] = state.confirmations.map((c) => {
      const id = keyToId.get(c.cellKey);
      const opened = Date.parse(c.windowOpenedAt);
      const windowResults = (id ? (byCell.get(id) ?? []) : []).filter((t) => t.entryAt.getTime() >= opened).map((t) => t.r);
      return { cellKey: c.cellKey, status: c.status, checkpointsElapsed: c.checkpointsElapsed, checkpointsSinceEnd: c.checkpointsSinceEnd, promoted: c.promoted, windowResults };
    });
    const input: SelectorInput = {
      rules,
      checkpointAt: checkpointAt.toISOString(),
      cells: cells.map((c) => ({ key: cellKeyOf(c), family: c.family, results: (byCell.get(c.id) ?? []).map((t) => t.r) })),
      confirmations,
      lastDrawdownAt: state.lastDrawdownAt,
    };
    return { input, cells };
  }

  /** The state going into a checkpoint, read from the confirmation table and the decision history. */
  async function stateBefore(companyId: string, checkpointAt: Date, decidedAt: Date): Promise<StateBefore> {
    const live = await db
      .select({ c: tradingSelectorConfirmations, cell: tradingShadowCells })
      .from(tradingSelectorConfirmations)
      .innerJoin(tradingShadowCells, eq(tradingShadowCells.id, tradingSelectorConfirmations.cellId))
      .where(eq(tradingSelectorConfirmations.companyId, companyId))
      .orderBy(asc(tradingSelectorConfirmations.openedCheckpointAt));
    const decisions = await db
      .select({ checkpointAt: tradingSelectorDecisions.checkpointAt })
      .from(tradingSelectorDecisions)
      .where(and(eq(tradingSelectorDecisions.companyId, companyId)));
    const checkpointsAfter = (at: Date) => decisions.filter((d) => d.checkpointAt.getTime() > at.getTime() && d.checkpointAt.getTime() < checkpointAt.getTime()).length + 1;
    // One record per cell: the newest. A cell with an older ended window and a newer live one is described by the live one.
    const newest = new Map<string, (typeof live)[number]>();
    for (const row of live) newest.set(row.c.cellId, row);
    const confirmations: StoredConfirmationState[] = [];
    for (const { c, cell } of newest.values()) {
      if (c.openedCheckpointAt.getTime() >= checkpointAt.getTime()) continue;
      const ended = c.status === "failed" || c.status === "expired";
      confirmations.push({
        cellKey: cellKeyOf(cell),
        status: c.status as StoredConfirmationState["status"],
        checkpointsElapsed: ended ? 0 : checkpointsAfter(c.openedCheckpointAt),
        checkpointsSinceEnd: ended && c.endedCheckpointAt ? checkpointsAfter(c.endedCheckpointAt) : null,
        promoted: c.promoted,
        windowOpenedAt: c.openedCheckpointAt.toISOString(),
      });
    }
    confirmations.sort((a, b) => (a.cellKey < b.cellKey ? -1 : 1));
    const [drawdown] = await db
      .select({ at: sql<Date | null>`max(${tradingLedgerEntries.createdAt})` })
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.companyId, companyId), eq(tradingLedgerEntries.eventType, "circuit_breaker"), lte(tradingLedgerEntries.createdAt, decidedAt)));
    return { confirmations, lastDrawdownAt: drawdown?.at ? new Date(drawdown.at).toISOString() : null };
  }

  // ─── A checkpoint ───────────────────────────────────────────────────

  async function runCheckpoint(companyId: string, checkpointAt: Date, now: Date = nowOf()): Promise<{ created: boolean; decisionId: string; output: SelectorOutput | null }> {
    const [existing] = await db
      .select({ id: tradingSelectorDecisions.id })
      .from(tradingSelectorDecisions)
      .where(and(eq(tradingSelectorDecisions.companyId, companyId), eq(tradingSelectorDecisions.checkpointAt, checkpointAt)));
    if (existing) return { created: false, decisionId: existing.id, output: null };

    const stored = await ensureRules();
    const state = await stateBefore(companyId, checkpointAt, now);
    const { input, cells } = await buildInput(companyId, checkpointAt, now, state);
    const output = runSelector(input);
    const cellIdOf = new Map(cells.map((c) => [cellKeyOf(c), c.id]));

    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tradingSelectorDecisions)
        .values({
          companyId,
          checkpointAt,
          rulesVersion: stored.version,
          rulesDigest: stored.digest,
          decidedAt: now,
          stateBefore: state as unknown as Record<string, unknown>,
          output: output as unknown as Record<string, unknown>,
          inputDigest: digestOf(input),
          outputDigest: digestOf(output),
          choice: output.choice,
          trials: output.trials,
          tested: output.tested,
          discoveries: output.discoveries,
          reason: output.reason,
        })
        .onConflictDoNothing()
        .returning({ id: tradingSelectorDecisions.id });
      if (!row) {
        const [again] = await tx
          .select({ id: tradingSelectorDecisions.id })
          .from(tradingSelectorDecisions)
          .where(and(eq(tradingSelectorDecisions.companyId, companyId), eq(tradingSelectorDecisions.checkpointAt, checkpointAt)));
        return { created: false, decisionId: again!.id, output: null };
      }
      for (const cell of output.cells) {
        const change = selectorConfirmationTransition(cell.action as SelectorAction);
        const cellId = cellIdOf.get(cell.key);
        if (!change || !cellId) continue;
        if (change.opens) {
          await tx.insert(tradingSelectorConfirmations).values({ companyId, cellId, status: "running", openedCheckpointAt: checkpointAt, openedDecisionId: row.id });
          continue;
        }
        const [live] = await tx
          .select()
          .from(tradingSelectorConfirmations)
          .where(and(eq(tradingSelectorConfirmations.cellId, cellId), inArray(tradingSelectorConfirmations.status, ["running", "passed"])));
        if (!live) continue;
        await tx
          .update(tradingSelectorConfirmations)
          .set({
            status: change.status,
            promoted: change.promoted,
            promotedAt: change.promoted && !live.promoted ? now : live.promotedAt,
            demotedAt: !change.promoted && live.promoted ? now : live.demotedAt,
            endedCheckpointAt: change.ends ? checkpointAt : live.endedCheckpointAt,
            endedDecisionId: change.ends ? row.id : live.endedDecisionId,
            windowTrades: cell.windowTrades,
            windowMeanR: cell.windowMeanR,
            updatedAt: now,
          })
          .where(eq(tradingSelectorConfirmations.id, live.id));
      }
      return { created: true, decisionId: row.id, output };
    });
  }

  /** The runner's tick: the checkpoint at or before now, for every company that has a shadow cell older than it and no decision yet. */
  async function tick(now: Date = nowOf()): Promise<{ checkpointAt: string; decisions: number }> {
    const checkpointAt = latestSelectorCheckpoint(now);
    const companies = await db
      .selectDistinct({ companyId: tradingShadowCells.companyId })
      .from(tradingShadowCells)
      .where(lte(tradingShadowCells.firstSeenAt, checkpointAt));
    let decisions = 0;
    for (const { companyId } of companies) {
      try {
        const result = await runCheckpoint(companyId, checkpointAt, now);
        if (result.created) decisions++;
      } catch (err) {
        logger.error({ err, companyId }, "trading selector: checkpoint failed");
      }
    }
    return { checkpointAt: checkpointAt.toISOString(), decisions };
  }

  // ─── Reading ────────────────────────────────────────────────────────

  async function listDecisions(companyId: string, limit = 24) {
    return db
      .select({
        id: tradingSelectorDecisions.id,
        checkpointAt: tradingSelectorDecisions.checkpointAt,
        rulesVersion: tradingSelectorDecisions.rulesVersion,
        choice: tradingSelectorDecisions.choice,
        trials: tradingSelectorDecisions.trials,
        tested: tradingSelectorDecisions.tested,
        discoveries: tradingSelectorDecisions.discoveries,
        reason: tradingSelectorDecisions.reason,
        riskCapsChanged: tradingSelectorDecisions.riskCapsChanged,
        decidedAt: tradingSelectorDecisions.decidedAt,
      })
      .from(tradingSelectorDecisions)
      .where(eq(tradingSelectorDecisions.companyId, companyId))
      .orderBy(desc(tradingSelectorDecisions.checkpointAt))
      .limit(limit);
  }

  async function getDecision(companyId: string, decisionId: string) {
    const [row] = await db
      .select()
      .from(tradingSelectorDecisions)
      .where(and(eq(tradingSelectorDecisions.companyId, companyId), eq(tradingSelectorDecisions.id, decisionId)));
    if (!row) throw notFound("Selector decision not found");
    return row;
  }

  /** The cells that hold paper cash right now (from the live confirmations). Empty = cash. */
  async function promotedCells(companyId: string) {
    const rows = await db
      .select({ cell: tradingShadowCells, c: tradingSelectorConfirmations })
      .from(tradingSelectorConfirmations)
      .innerJoin(tradingShadowCells, eq(tradingShadowCells.id, tradingSelectorConfirmations.cellId))
      .where(and(eq(tradingSelectorConfirmations.companyId, companyId), eq(tradingSelectorConfirmations.promoted, true)));
    return rows.map((r) => ({ cellKey: cellKeyOf(r.cell), templateKey: r.cell.templateKey, templateVersion: r.cell.templateVersion, weather: r.cell.weather, asset: r.cell.asset, promotedAt: r.c.promotedAt }));
  }

  /**
   * Rebuilds a stored decision from the stored shadow trades and compares the
   * digests. Closed shadow trades are final and a decision only reads trades
   * resolved before it was made, so this must agree unless something was
   * tampered with.
   */
  async function reproduce(companyId: string, decisionId: string) {
    const stored = await getDecision(companyId, decisionId);
    const [rulesRow] = await db.select().from(tradingSelectorRules).where(eq(tradingSelectorRules.version, stored.rulesVersion));
    const storedRules = (rulesRow?.rules ?? null) as unknown as TradingSelectorRules | null;
    if (!rulesRow || !storedRules) return { reproduced: false, reason: "The rules version of this decision is missing." };
    const rulesDigestMatches = rulesRow.digest === stored.rulesDigest && digestOf(storedRules) === stored.rulesDigest;
    const state = stored.stateBefore as unknown as StateBefore;
    const { input } = await buildInput(companyId, stored.checkpointAt, stored.decidedAt, state);
    const rebuilt: SelectorInput = { ...input, rules: storedRules };
    const output = runSelector(rebuilt);
    const inputDigestMatches = digestOf(rebuilt) === stored.inputDigest;
    const outputDigestMatches = digestOf(output) === stored.outputDigest;
    return {
      reproduced: rulesDigestMatches && inputDigestMatches && outputDigestMatches,
      rulesDigestMatches,
      inputDigestMatches,
      outputDigestMatches,
      choice: output.choice,
      promoted: output.promoted,
    };
  }

  /** The selector replayed over the stored history: at each past checkpoint it sees only what had closed by then. */
  async function walkForward(companyId: string, now: Date = nowOf()) {
    const cells = await cellsAt(companyId, now);
    const keyOf = new Map(cells.map((c) => [c.id, cellKeyOf(c)]));
    const familyOf = new Map(cells.map((c) => [c.id, c.family]));
    const rows = await db
      .select({ cellId: tradingShadowTrades.cellId, entryAt: tradingShadowTrades.entryAt, exitAt: tradingShadowTrades.exitAt, r2x: tradingShadowTrades.r2x })
      .from(tradingShadowTrades)
      .where(and(eq(tradingShadowTrades.companyId, companyId), eq(tradingShadowTrades.status, "closed"), sql`${tradingShadowTrades.r2x} IS NOT NULL`, lte(tradingShadowTrades.resolvedAt, now)));
    const trades: ShadowTradeFact[] = rows.map((r) => ({ cellKey: keyOf.get(r.cellId)!, family: familyOf.get(r.cellId)!, entryAt: r.entryAt!, exitAt: r.exitAt!, r: r.r2x! }));
    const first = trades.reduce<Date | null>((min, t) => (min === null || t.exitAt < min ? t.exitAt : min), null);
    const checkpoints: Date[] = [];
    if (first) {
      let cp = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
      const last = latestSelectorCheckpoint(now);
      while (cp.getTime() <= last.getTime()) {
        checkpoints.push(cp);
        cp = new Date(Date.UTC(cp.getUTCFullYear(), cp.getUTCMonth() + 1, 1));
      }
    }
    const drawdowns = await db
      .select({ at: tradingLedgerEntries.createdAt })
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.companyId, companyId), eq(tradingLedgerEntries.eventType, "circuit_breaker")));
    return walkForwardSelector({ rules, trades, cellKeys: cells.map(cellKeyOf), checkpoints, drawdownAts: drawdowns.map((d) => d.at) });
  }

  /** Per cell: how many shadow trades are open / closed and their average result at the paper fee and at double. */
  async function shadowSummary(companyId: string) {
    const rows = await db
      .select({
        cell: tradingShadowCells,
        open: sql<number>`count(*) FILTER (WHERE ${tradingShadowTrades.status} = 'open')::int`,
        closed: sql<number>`count(*) FILTER (WHERE ${tradingShadowTrades.status} = 'closed')::int`,
        voided: sql<number>`count(*) FILTER (WHERE ${tradingShadowTrades.status} = 'void')::int`,
        meanR1x: sql<number | null>`avg(${tradingShadowTrades.r1x}) FILTER (WHERE ${tradingShadowTrades.status} = 'closed')`,
        meanR2x: sql<number | null>`avg(${tradingShadowTrades.r2x}) FILTER (WHERE ${tradingShadowTrades.status} = 'closed')`,
      })
      .from(tradingShadowCells)
      .leftJoin(tradingShadowTrades, eq(tradingShadowTrades.cellId, tradingShadowCells.id))
      .where(eq(tradingShadowCells.companyId, companyId))
      .groupBy(tradingShadowCells.id);
    return rows
      .map((r) => ({ cellKey: cellKeyOf(r.cell), family: r.cell.family, templateKey: r.cell.templateKey, templateVersion: r.cell.templateVersion, weather: r.cell.weather, asset: r.cell.asset, open: r.open, closed: r.closed, voided: r.voided, meanR1x: r.meanR1x === null ? null : Number(r.meanR1x), meanR2x: r.meanR2x === null ? null : Number(r.meanR2x) }))
      .sort((a, b) => (a.cellKey < b.cellKey ? -1 : 1));
  }

  return { ensureRules, runCheckpoint, tick, listDecisions, getDecision, promotedCells, reproduce, walkForward, shadowSummary, rules };
}

export type TradingSelectorService = ReturnType<typeof tradingSelectorService>;
