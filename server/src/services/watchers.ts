import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, runInPooledScope, watcherAlerts, watcherPricePoints, watcherWebPageSnapshots, watchers } from "@paperclipai/db";
import {
  WATCHER_MAX_ALERTS_PER_DAY,
  WATCHER_MAX_PER_COMPANY,
  WATCHER_SOURCE_INFO,
  describeWatcherRule,
  describeWatcherWebPageRule,
  formatWatcherPrice,
  watcherCheckEveryProblem,
  watcherRuleSchema,
  watcherSymbolName,
  watcherSymbolProblem,
  watcherWebPageRuleSchema,
  type CreateWatcherInput,
  type UpdateWatcherInput,
  type WatcherAlertFacts,
  type WatcherAlertStatus,
  type WatcherAlertSummary,
  type WatcherOutboxItem,
  type WatcherRule,
  type WatcherSource,
  type WatcherSummary,
  type WatcherWebPageRule,
} from "@paperclipai/shared";
import { conflict, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { laneAService } from "./lane-a.js";
import { secretService } from "./secrets.js";
import {
  WATCHER_PRICE_SOURCES,
  isWatcherQuoteError,
  scrubWatcherText,
  type WatcherQuote,
  type WatcherQuoteError,
  type WatcherSourceDeps,
} from "./watcher-sources.js";
import { evaluateWatcherRule, watcherRuleHistoryHours } from "./watcher-rules.js";
import { evaluateWatcherWebPageRule, type WatcherWebPageSnapshot } from "./watcher-web-page-rules.js";
import {
  createWatcherWebPageFetcher,
  isWatcherWebPageFetchError,
  type WatcherWebPageFetchResult,
  type WatcherWebPageFetcher,
} from "./watcher-web-page.js";

/**
 * Watchers: scheduled price checks that alert the operator on Telegram only
 * when a rule fires.
 *
 * How a check runs (tick, from the server's scheduler loop in index.ts, as
 * its own single-flight chain):
 *   1. Due watchers are claimed one by one with a conditional UPDATE of
 *      check_lease_until, so a watcher is never checked twice at once (not by
 *      an overlapping tick, not by a second server process).
 *   2. Prices are fetched in code (watcher-sources.ts): all crypto watchers of
 *      a tick share one CoinGecko request; stock watchers one request each.
 *   3. The rule is evaluated in code (watcher-rules.ts). No AI in any of this.
 *   4. A failed check backs off (twice the interval per failure in a row, up
 *      to six hours) and never alerts; its plain reason is shown on the page.
 *   5. A fired rule, outside the watcher's quiet time and under the daily
 *      ceiling, writes an alert row ('composing').
 *
 * How an alert is written: the tick claims composing alerts the same way
 * (compose_lease_until) and hands each to a detached continuation
 * (runInPooledScope), so a two-minute picture never holds the scheduler's
 * database connection. The quick agent words the facts once (Lane A
 * transform: one short model call), Media Studio makes the picture when the
 * watcher asks for one (the agent's own daily picture limit and default look
 * apply), and the alert becomes 'ready'. If the agent cannot write it (paused,
 * over a limit, no model set up) the facts go out in plain words instead, with
 * a note; after three tries the same happens. An alert is never lost to an AI
 * problem, and never sent twice.
 *
 * How it reaches Telegram: this server holds no bot tokens for this. The
 * host-side Telegram bridge polls the outbox (ready alerts, per company) via
 * the CLI, sends each through the agent's bot, and acknowledges it.
 */

type WatcherRow = typeof watchers.$inferSelect;
type WatcherAlertRow = typeof watcherAlerts.$inferSelect;

export const WATCHER_KEY_CONFIG_PATH = "source_key";
/** How many due watchers one tick checks at most; the rest wait for the next tick. */
export const WATCHER_TICK_BATCH = 50;
export const WATCHER_CHECK_LEASE_MS = 10 * 60_000;
export const WATCHER_COMPOSE_LEASE_MS = 10 * 60_000;
export const WATCHER_COMPOSE_MAX_ATTEMPTS = 3;
export const WATCHER_COMPOSE_BATCH = 5;
/** Longest wait between two checks after failures in a row. */
export const WATCHER_MAX_BACKOFF_MS = 6 * 3_600_000;
/** A ready alert nobody picked up in this long is not sent any more (old news). */
export const WATCHER_OUTBOX_MAX_AGE_MS = 24 * 3_600_000;
/** Price history kept beyond the longest window a rule needs. */
const HISTORY_SLACK_HOURS = 24;
/** A resolved source key is reused this long, so a 5-minute watcher does not log a secret read every 5 minutes. */
export const WATCHER_KEY_CACHE_MS = 30 * 60_000;
const RECENT_ALERTS_SHOWN = 5;
const OUTBOX_BATCH = 20;

/** Instructions for the one model call an alert costs. The facts travel as data, never in here. */
export const WATCHER_ALERT_TASK =
  "You write one short Telegram message to the person you work for, telling them about a market price move a watcher of theirs just noticed. " +
  "Write in your own voice, at most three short sentences. Use the facts exactly as given: do not change, round differently or invent any number, " +
  "and give no predictions and no financial advice.";

export interface WatcherActor {
  userId: string | null;
}

export interface WatcherServiceDeps extends WatcherSourceDeps {
  /** Test seam: the quick-agent calls an alert makes. */
  laneA?: {
    transform: ReturnType<typeof laneAService>["transform"];
    makePicture: ReturnType<typeof laneAService>["makePicture"];
  };
  /**
   * How a composing alert is handed off. Production detaches it onto the
   * pool (runInPooledScope); tests pass a function that collects the promise.
   */
  dispatch?: (work: () => Promise<void>) => void;
  /** Test seam: swap the real (Crawl4AI-backed) fetcher for a fake with fixed responses. */
  webPageFetcher?: WatcherWebPageFetcher;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function readRule(row: Pick<WatcherRow, "rule">): WatcherRule | null {
  const parsed = watcherRuleSchema.safeParse(row.rule);
  return parsed.success ? parsed.data : null;
}

function readWebPageRule(row: Pick<WatcherRow, "rule">): WatcherWebPageRule | null {
  const parsed = watcherWebPageRuleSchema.safeParse(row.rule);
  return parsed.success ? parsed.data : null;
}

/** Either rule shape, picked by the watcher's own source -- see watcherWebPageRuleSchema vs watcherRuleSchema. */
function readAnyRule(row: Pick<WatcherRow, "source" | "rule">): WatcherRule | WatcherWebPageRule | null {
  return row.source === "web_page" ? readWebPageRule(row) : readRule(row);
}

function describeAnyRule(row: Pick<WatcherRow, "source" | "symbol">, rule: WatcherRule | WatcherWebPageRule): string {
  if (row.source === "web_page") return describeWatcherWebPageRule(rule as WatcherWebPageRule);
  return describeWatcherRule(rule as WatcherRule, subjectOf(row), currencyOf(row));
}

function subjectOf(row: Pick<WatcherRow, "source" | "symbol">): string {
  return watcherSymbolName(row.source as WatcherSource, row.symbol);
}

function currencyOf(row: Pick<WatcherRow, "source">): string {
  return WATCHER_SOURCE_INFO[row.source as WatcherSource]?.currency ?? "USD";
}

function formatSignedPercent(value: number): string {
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function windowWords(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) return hours === 24 ? "24 hours" : `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The facts in one plain line: "Bitcoin (BTC): $87,300, +5.2% in 24 hours (from $83,000)". */
export function watcherFactsLine(facts: WatcherAlertFacts): string {
  const head = facts.subject === facts.symbol ? facts.symbol : `${facts.subject} (${facts.symbol})`;
  if (facts.price === null) return facts.changeSummary ? `${head}: ${facts.changeSummary}` : head;
  let line = `${head}: ${formatWatcherPrice(facts.price, facts.currency)}`;
  if (facts.changePercent !== null && facts.basePrice !== null) {
    const span = facts.windowHours ? ` in ${windowWords(facts.windowHours)}` : facts.ruleText.includes("since the last alert") ? " since the last alert" : "";
    line += `, ${formatSignedPercent(facts.changePercent)}${span} (from ${formatWatcherPrice(facts.basePrice, facts.currency)})`;
  }
  return line;
}

/** The whole alert without any agent: what goes out when the agent cannot write it. */
export function watcherPlainAlertText(facts: WatcherAlertFacts): string {
  const emoji = facts.price === null ? "🔔" : "📈";
  const head = facts.isTest ? `🧪 Test alert from the watcher "${facts.watcherName}"` : `${emoji} ${facts.watcherName}`;
  return `${head}\n${watcherFactsLine(facts)}\nRule: ${facts.ruleText}.`;
}

/** The data the agent words. Labelled fields, so nothing in them can pose as an instruction. */
export function watcherFactsForAgent(facts: WatcherAlertFacts): string {
  const lines = [
    `Watcher: ${facts.watcherName}`,
    `What it watches: ${facts.subject} (${facts.symbol})`,
    `Rule that fired: ${facts.ruleText}`,
  ];
  if (facts.price !== null) {
    lines.push(`Price now: ${formatWatcherPrice(facts.price, facts.currency)}`);
    if (facts.basePrice !== null && facts.changePercent !== null) {
      lines.push(`Measured from: ${formatWatcherPrice(facts.basePrice, facts.currency)}`);
      lines.push(`Change: ${formatSignedPercent(facts.changePercent)}`);
    }
    if (facts.windowHours) lines.push(`Within: ${windowWords(facts.windowHours)}`);
  } else if (facts.changeSummary) {
    lines.push(`What changed: ${facts.changeSummary}`);
  }
  if (facts.isTest) lines.push("This is a TEST alert the person asked for, not a real move. Say that it is a test.");
  return lines.join("\n");
}

/** A picture description written by code (no model call): the mood follows the direction of the move. */
export function watcherPicturePrompt(facts: WatcherAlertFacts): string {
  if (facts.price === null) {
    return `A clean, editorial illustration representing a web page update: ${facts.changeSummary ?? facts.ruleText}, no text, no numbers`;
  }
  const up = (facts.changePercent ?? 0) >= 0;
  const what = facts.source === "crypto" ? `a shiny ${facts.subject} coin` : `the ${facts.subject} stock ticker on a trading screen`;
  return up
    ? `An upbeat, celebratory illustration of ${what} riding a bright green price chart that climbs steeply upward, confetti and sunshine, no text, no numbers`
    : `A dramatic, stormy illustration of ${what} sliding down a red price chart that falls steeply, dark clouds and rain, no text, no numbers`;
}

const keyCache = new Map<string, { value: string; at: number }>();

/** Exported for tests. */
export function resetWatcherKeyCache(): void {
  keyCache.clear();
}

export function watcherService(db: Db, deps: WatcherServiceDeps = {}) {
  const secrets = secretService(db);
  const laneA = deps.laneA ?? laneAService(db);
  const nowOf = () => deps.now?.() ?? new Date();
  const dispatch =
    deps.dispatch ??
    ((work: () => Promise<void>) => {
      void runInPooledScope(db, work).catch((err) => {
        logger.error({ err }, "watchers: writing an alert failed");
      });
    });
  const webPageFetcher = deps.webPageFetcher ?? createWatcherWebPageFetcher();

  // ─── Reading ───────────────────────────────────────────────────────────────

  function toAlertSummary(row: WatcherAlertRow): WatcherAlertSummary {
    return {
      id: row.id,
      watcherId: row.watcherId,
      status: row.status as WatcherAlertStatus,
      isTest: row.isTest,
      text: row.text,
      hasPicture: Boolean(row.imageFileId),
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      readyAt: iso(row.readyAt),
      deliveredAt: iso(row.deliveredAt),
    };
  }

  function toSummary(row: WatcherRow, agentName: string | null, alerts: WatcherAlertRow[], now: Date): WatcherSummary {
    const rule = readAnyRule(row) ?? ({ kind: "since_last_alert", percent: 99 } as WatcherRule);
    const today = utcDay(now);
    const subject = subjectOf(row);
    return {
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      agentName,
      name: row.name,
      source: row.source as WatcherSource,
      symbol: row.symbol,
      subject,
      currency: currencyOf(row),
      rule,
      ruleText: readAnyRule(row) ? describeAnyRule(row, rule) : "The rule could not be read. Edit the watcher and save it again.",
      checkEveryMinutes: row.checkEveryMinutes,
      cooldownMinutes: row.cooldownMinutes,
      enabled: row.enabled,
      withPicture: row.withPicture,
      keySecretId: row.keySecretId,
      lastPrice: row.lastPrice,
      lastPriceAt: iso(row.lastPriceAt),
      lastCheckAt: iso(row.lastCheckAt),
      lastCheckOk: row.lastCheckOk,
      lastCheckMessage: row.lastCheckMessage,
      lastAlertAt: iso(row.lastAlertAt),
      nextCheckAt: row.enabled ? iso(row.nextCheckAt) : null,
      checksToday: row.countersDay === today ? row.checksToday : 0,
      alertsToday: row.countersDay === today ? row.alertsToday : 0,
      recentAlerts: alerts.map(toAlertSummary),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function agentNames(companyId: string): Promise<Map<string, string>> {
    const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async function recentAlerts(companyId: string, watcherIds: string[]): Promise<Map<string, WatcherAlertRow[]>> {
    const byWatcher = new Map<string, WatcherAlertRow[]>();
    if (watcherIds.length === 0) return byWatcher;
    const rows = await db
      .select()
      .from(watcherAlerts)
      .where(and(eq(watcherAlerts.companyId, companyId), inArray(watcherAlerts.watcherId, watcherIds)))
      .orderBy(desc(watcherAlerts.createdAt))
      .limit(watcherIds.length * RECENT_ALERTS_SHOWN * 4);
    for (const row of rows) {
      const list = byWatcher.get(row.watcherId) ?? [];
      if (list.length < RECENT_ALERTS_SHOWN) list.push(row);
      byWatcher.set(row.watcherId, list);
    }
    return byWatcher;
  }

  async function getRow(companyId: string, watcherId: string): Promise<WatcherRow> {
    const [row] = await db
      .select()
      .from(watchers)
      .where(and(eq(watchers.id, watcherId), eq(watchers.companyId, companyId)));
    if (!row) throw notFound("That watcher was not found. It may have been deleted.");
    return row;
  }

  async function list(companyId: string): Promise<WatcherSummary[]> {
    const rows = await db
      .select()
      .from(watchers)
      .where(eq(watchers.companyId, companyId))
      .orderBy(asc(watchers.createdAt));
    const [names, alerts] = await Promise.all([agentNames(companyId), recentAlerts(companyId, rows.map((row) => row.id))]);
    const now = nowOf();
    return rows.map((row) => toSummary(row, names.get(row.agentId) ?? null, alerts.get(row.id) ?? [], now));
  }

  async function get(companyId: string, watcherId: string): Promise<WatcherSummary> {
    const row = await getRow(companyId, watcherId);
    const [names, alerts] = await Promise.all([agentNames(companyId), recentAlerts(companyId, [row.id])]);
    return toSummary(row, names.get(row.agentId) ?? null, alerts.get(row.id) ?? [], nowOf());
  }

  // ─── Changing ──────────────────────────────────────────────────────────────

  async function assertQuickAgent(companyId: string, agentId: string) {
    const [agent] = await db
      .select({ id: agents.id, name: agents.name, laneAEnabled: agents.laneAEnabled })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) throw unprocessable("Pick an agent from this company.");
    if (!agent.laneAEnabled) {
      throw unprocessable(`${agent.name} does not have quick answers switched on. Pick a quick agent to speak for this watcher.`);
    }
    return agent;
  }

  function assertWatcherShape(input: {
    source: WatcherSource;
    symbol: string;
    checkEveryMinutes: number;
    keySecretId: string | null;
  }) {
    const symbolProblem = watcherSymbolProblem(input.source, input.symbol);
    if (symbolProblem) throw unprocessable(symbolProblem);
    const everyProblem = watcherCheckEveryProblem(input.source, input.checkEveryMinutes);
    if (everyProblem) throw unprocessable(everyProblem);
    const info = WATCHER_SOURCE_INFO[input.source];
    if (info.needsKey && !input.keySecretId) {
      throw unprocessable(`${info.label} needs a ${info.keyLabel ?? "key"}. Pick the secret that holds it, or add one.`);
    }
  }

  async function syncKeyBinding(companyId: string, watcherId: string, name: string, keySecretId: string | null) {
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "watcher", targetId: watcherId },
      keySecretId ? [{ secretId: keySecretId, configPath: WATCHER_KEY_CONFIG_PATH, label: `Watcher: ${name}` }] : [],
      { replaceAll: true },
    );
    for (const cacheKey of keyCache.keys()) if (cacheKey.startsWith(`${watcherId}:`)) keyCache.delete(cacheKey);
  }

  async function create(companyId: string, input: CreateWatcherInput, actor: WatcherActor): Promise<WatcherSummary> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(watchers)
      .where(eq(watchers.companyId, companyId));
    if (Number(count) >= WATCHER_MAX_PER_COMPANY) {
      throw conflict(`A company can have at most ${WATCHER_MAX_PER_COMPANY} watchers. Delete one you no longer need first.`);
    }
    await assertQuickAgent(companyId, input.agentId);
    input = { ...input, symbol: input.symbol.trim().toUpperCase() };
    const keySecretId = WATCHER_SOURCE_INFO[input.source].needsKey ? input.keySecretId ?? null : null;
    assertWatcherShape({ source: input.source, symbol: input.symbol, checkEveryMinutes: input.checkEveryMinutes, keySecretId });
    const now = nowOf();
    const [row] = await db
      .insert(watchers)
      .values({
        companyId,
        agentId: input.agentId,
        name: input.name,
        source: input.source,
        symbol: input.symbol,
        rule: input.rule as Record<string, unknown>,
        checkEveryMinutes: input.checkEveryMinutes,
        cooldownMinutes: input.cooldownMinutes,
        enabled: input.enabled,
        withPicture: input.withPicture,
        keySecretId,
        nextCheckAt: now,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    try {
      await syncKeyBinding(companyId, row!.id, row!.name, keySecretId);
    } catch (err) {
      // A binding that cannot be made (a secret of another company, a
      // dedicated credential) must not leave a watcher without its key.
      await db.delete(watchers).where(eq(watchers.id, row!.id));
      throw err;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "watcher.created",
      entityType: "watcher",
      entityId: row!.id,
      agentId: row!.agentId,
      details: { name: row!.name, source: row!.source, symbol: row!.symbol, rule: row!.rule },
    });
    return get(companyId, row!.id);
  }

  async function update(companyId: string, watcherId: string, patch: UpdateWatcherInput, actor: WatcherActor): Promise<WatcherSummary> {
    const row = await getRow(companyId, watcherId);
    const next = {
      name: patch.name ?? row.name,
      agentId: patch.agentId ?? row.agentId,
      source: (patch.source ?? row.source) as WatcherSource,
      symbol: (patch.symbol ?? row.symbol).trim().toUpperCase(),
      rule: patch.rule ?? readAnyRule(row),
      checkEveryMinutes: patch.checkEveryMinutes ?? row.checkEveryMinutes,
      cooldownMinutes: patch.cooldownMinutes ?? row.cooldownMinutes,
      enabled: patch.enabled ?? row.enabled,
      withPicture: patch.withPicture ?? row.withPicture,
      keySecretId: patch.keySecretId !== undefined ? patch.keySecretId : row.keySecretId,
    };
    if (!next.rule) throw unprocessable("Set the rule again: the saved one could not be read.");
    if (patch.agentId && patch.agentId !== row.agentId) await assertQuickAgent(companyId, patch.agentId);
    if (!WATCHER_SOURCE_INFO[next.source].needsKey) next.keySecretId = null;
    assertWatcherShape(next);

    const watchedChanged = next.source !== row.source || next.symbol !== row.symbol;
    const ruleChanged = watchedChanged || JSON.stringify(next.rule) !== JSON.stringify(row.rule);
    const now = nowOf();
    await db
      .update(watchers)
      .set({
        name: next.name,
        agentId: next.agentId,
        source: next.source,
        symbol: next.symbol,
        rule: next.rule as Record<string, unknown>,
        checkEveryMinutes: next.checkEveryMinutes,
        cooldownMinutes: next.cooldownMinutes,
        enabled: next.enabled,
        withPicture: next.withPicture,
        keySecretId: next.keySecretId,
        // A new rule starts from a clean slate: no remembered crossing, no
        // old baseline. A new symbol also drops the old symbol's prices.
        ...(ruleChanged ? { conditionMet: false, lastAlertPrice: null } : {}),
        ...(watchedChanged ? { lastPrice: null, lastPriceAt: null, consecutiveFailures: 0, lastCheckOk: null, lastCheckMessage: null } : {}),
        // Switching on, or changing what is watched, checks right away.
        ...((next.enabled && !row.enabled) || watchedChanged ? { nextCheckAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(watchers.id, row.id), eq(watchers.companyId, companyId)));
    if (watchedChanged) {
      await db.delete(watcherPricePoints).where(eq(watcherPricePoints.watcherId, row.id));
    }
    if (next.keySecretId !== row.keySecretId || next.name !== row.name) {
      await syncKeyBinding(companyId, row.id, next.name, next.keySecretId);
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "watcher.updated",
      entityType: "watcher",
      entityId: row.id,
      agentId: next.agentId,
      details: { name: next.name, changed: Object.keys(patch) },
    });
    return get(companyId, row.id);
  }

  async function remove(companyId: string, watcherId: string, actor: WatcherActor): Promise<void> {
    const row = await getRow(companyId, watcherId);
    await db.delete(watchers).where(and(eq(watchers.id, row.id), eq(watchers.companyId, companyId)));
    await secrets
      .syncSecretRefsForTarget(companyId, { targetType: "watcher", targetId: row.id }, [], { replaceAll: true })
      .catch((err) => logger.warn({ err, companyId }, "watchers: could not remove a deleted watcher's key binding"));
    for (const cacheKey of keyCache.keys()) if (cacheKey.startsWith(`${row.id}:`)) keyCache.delete(cacheKey);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "watcher.deleted",
      entityType: "watcher",
      entityId: row.id,
      agentId: row.agentId,
      details: { name: row.name, source: row.source, symbol: row.symbol },
    });
  }

  // ─── Prices ────────────────────────────────────────────────────────────────

  async function resolveKey(row: WatcherRow): Promise<string | null> {
    if (!row.keySecretId) return null;
    const cacheKey = `${row.id}:${row.keySecretId}`;
    const cached = keyCache.get(cacheKey);
    const nowMs = nowOf().getTime();
    if (cached && nowMs - cached.at < WATCHER_KEY_CACHE_MS) return cached.value;
    const value = await secrets.resolveSecretValue(row.companyId, row.keySecretId, "latest", {
      consumerType: "watcher",
      consumerId: row.id,
      configPath: WATCHER_KEY_CONFIG_PATH,
      actorType: "system",
      actorId: null,
    });
    keyCache.set(cacheKey, { value, at: nowMs });
    return value;
  }

  /** Prices for a set of watchers: one request per source (crypto), or per watcher's key (stocks). */
  async function fetchPrices(rows: WatcherRow[], now: Date): Promise<Map<string, WatcherQuote | WatcherQuoteError>> {
    const out = new Map<string, WatcherQuote | WatcherQuoteError>();
    const crypto = rows.filter((row) => row.source === "crypto");
    if (crypto.length > 0) {
      const quotes = await WATCHER_PRICE_SOURCES.crypto.fetchQuotes({ symbols: crypto.map((row) => row.symbol), now }, deps);
      for (const row of crypto) {
        out.set(row.id, quotes.get(row.symbol) ?? { kind: "upstream", message: "No price came back for this coin." });
      }
    }
    for (const row of rows.filter((candidate) => candidate.source !== "crypto")) {
      const source = WATCHER_PRICE_SOURCES[row.source as WatcherSource];
      const info = WATCHER_SOURCE_INFO[row.source as WatcherSource];
      if (!source || !info?.available) {
        out.set(row.id, { kind: "unavailable", message: `${info?.label ?? "This market"} is not available yet.` });
        continue;
      }
      let key: string | null = null;
      try {
        key = await resolveKey(row);
      } catch {
        out.set(row.id, {
          kind: "key_missing",
          message: `The ${info.keyLabel ?? "key"} for this watcher could not be read. Pick the secret again on the Watchers page.`,
        });
        continue;
      }
      try {
        const quotes = await source.fetchQuotes({ symbols: [row.symbol], key, now }, deps);
        const quote = quotes.get(row.symbol) ?? { kind: "upstream" as const, message: "No price came back." };
        out.set(row.id, isWatcherQuoteError(quote) ? { ...quote, message: scrubWatcherText(quote.message, [key]) } : quote);
      } catch {
        out.set(row.id, { kind: "upstream", message: `${info.label}: the price request failed. The next check tries again.` });
      }
    }
    return out;
  }

  // ─── The tick ──────────────────────────────────────────────────────────────

  async function claimDueWatchers(now: Date): Promise<WatcherRow[]> {
    const due = await db
      .select({ id: watchers.id })
      .from(watchers)
      .where(
        and(
          eq(watchers.enabled, true),
          lte(watchers.nextCheckAt, now),
          or(isNull(watchers.checkLeaseUntil), lt(watchers.checkLeaseUntil, now)),
        ),
      )
      .orderBy(asc(watchers.nextCheckAt))
      .limit(WATCHER_TICK_BATCH);
    const claimed: WatcherRow[] = [];
    for (const { id } of due) {
      // The claim is the single-flight: only one caller's UPDATE matches.
      const [row] = await db
        .update(watchers)
        .set({ checkLeaseUntil: new Date(now.getTime() + WATCHER_CHECK_LEASE_MS) })
        .where(
          and(
            eq(watchers.id, id),
            eq(watchers.enabled, true),
            or(isNull(watchers.checkLeaseUntil), lt(watchers.checkLeaseUntil, now)),
          ),
        )
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  function counters(row: WatcherRow, now: Date) {
    const today = utcDay(now);
    return row.countersDay === today
      ? { countersDay: today, checksToday: row.checksToday, alertsToday: row.alertsToday }
      : { countersDay: today, checksToday: 0, alertsToday: 0 };
  }

  async function recordFailure(row: WatcherRow, error: { kind: string; message: string }, now: Date) {
    const failures = row.consecutiveFailures + 1;
    const interval = row.checkEveryMinutes * 60_000;
    const backoff = Math.min(interval * 2 ** Math.min(failures, 8), WATCHER_MAX_BACKOFF_MS);
    const c = counters(row, now);
    await db
      .update(watchers)
      .set({
        consecutiveFailures: failures,
        lastCheckAt: now,
        lastCheckOk: false,
        lastCheckMessage: error.message.slice(0, 300),
        nextCheckAt: new Date(now.getTime() + Math.max(interval, backoff)),
        checkLeaseUntil: null,
        countersDay: c.countersDay,
        checksToday: c.checksToday + 1,
        alertsToday: c.alertsToday,
      })
      .where(eq(watchers.id, row.id));
    // Once per run of failures, not once per check.
    if (failures === 1) {
      logger.warn({ watcherId: row.id, companyId: row.companyId, kind: error.kind }, "watchers: a price check failed");
    }
  }

  async function loadHistory(row: WatcherRow, rule: WatcherRule, observedAt: Date) {
    const hours = watcherRuleHistoryHours(rule);
    if (hours <= 0) return [];
    const since = new Date(observedAt.getTime() - hours * 3_600_000);
    const rows = await db
      .select({ at: watcherPricePoints.observedAt, price: watcherPricePoints.price })
      .from(watcherPricePoints)
      .where(and(eq(watcherPricePoints.watcherId, row.id), gte(watcherPricePoints.observedAt, since)))
      .orderBy(asc(watcherPricePoints.observedAt));
    return rows;
  }

  async function recordSuccess(row: WatcherRow, quote: WatcherQuote, now: Date): Promise<string | null> {
    const rule = readRule(row);
    const c = counters(row, now);
    const next = new Date(now.getTime() + row.checkEveryMinutes * 60_000);
    const base = {
      lastPrice: quote.price,
      lastPriceAt: quote.observedAt,
      lastCheckAt: now,
      consecutiveFailures: 0,
      nextCheckAt: next,
      checkLeaseUntil: null,
      countersDay: c.countersDay,
      checksToday: c.checksToday + 1,
    };
    if (!rule) {
      await db
        .update(watchers)
        .set({ ...base, lastCheckOk: false, lastCheckMessage: "The rule could not be read. Edit the watcher and save it again.", alertsToday: c.alertsToday })
        .where(eq(watchers.id, row.id));
      return null;
    }

    const history = await loadHistory(row, rule, quote.observedAt);
    const outcome = evaluateWatcherRule({
      rule,
      price: quote.price,
      observedAt: quote.observedAt,
      history,
      reference: quote.reference,
      lastAlertAt: row.lastAlertAt,
      lastAlertPrice: row.lastAlertPrice,
      alertedThisCrossing: row.conditionMet,
    });

    const cooling = row.lastAlertAt !== null && now.getTime() - row.lastAlertAt.getTime() < row.cooldownMinutes * 60_000;
    const capped = c.alertsToday >= WATCHER_MAX_ALERTS_PER_DAY;
    const fires = outcome.wantsAlert && !cooling && !capped;

    let conditionMet = row.conditionMet;
    if (rule.kind === "level") conditionMet = outcome.conditionNow ? (fires ? true : row.conditionMet) : false;
    // since_last_alert: the first price is the baseline, not a reason to alert.
    let lastAlertPrice = row.lastAlertPrice;
    if (rule.kind === "since_last_alert" && lastAlertPrice === null) lastAlertPrice = quote.price;

    let message: string | null = null;
    if (outcome.wantsAlert && cooling) message = "The rule fired, but the watcher is in its quiet time after the last alert.";
    if (outcome.wantsAlert && capped) message = `The rule fired, but today's ${WATCHER_MAX_ALERTS_PER_DAY} alerts are used up.`;

    // The watcher row first: if writing the alert then fails, nothing is sent
    // (a missed alert), never the same alert twice (spam).
    await db
      .update(watchers)
      .set({
        ...base,
        lastCheckOk: true,
        lastCheckMessage: message,
        conditionMet,
        lastAlertPrice: fires ? quote.price : lastAlertPrice,
        ...(fires ? { lastAlertAt: now } : {}),
        alertsToday: c.alertsToday + (fires ? 1 : 0),
      })
      .where(eq(watchers.id, row.id));

    const isNewPoint = !row.lastPriceAt || quote.observedAt.getTime() > row.lastPriceAt.getTime();
    if (isNewPoint) {
      await db.insert(watcherPricePoints).values({
        companyId: row.companyId,
        watcherId: row.id,
        price: quote.price,
        observedAt: quote.observedAt,
      });
      const keepHours = Math.max(watcherRuleHistoryHours(rule), 24) + HISTORY_SLACK_HOURS;
      await db
        .delete(watcherPricePoints)
        .where(
          and(
            eq(watcherPricePoints.watcherId, row.id),
            lt(watcherPricePoints.observedAt, new Date(now.getTime() - keepHours * 3_600_000)),
          ),
        );
    }

    if (!fires) return null;
    const facts: WatcherAlertFacts = {
      watcherName: row.name,
      source: row.source as WatcherSource,
      symbol: row.symbol,
      subject: subjectOf(row),
      currency: currencyOf(row),
      price: quote.price,
      basePrice: outcome.basePrice,
      changePercent: outcome.changePercent,
      windowHours: outcome.windowHours,
      ruleText: describeWatcherRule(rule, subjectOf(row), currencyOf(row)),
      changeSummary: null,
      isTest: false,
      observedAt: quote.observedAt.toISOString(),
    };
    const [alert] = await db
      .insert(watcherAlerts)
      .values({
        companyId: row.companyId,
        watcherId: row.id,
        agentId: row.agentId,
        status: "composing",
        facts: facts as unknown as Record<string, unknown>,
        createdAt: now,
      })
      .returning({ id: watcherAlerts.id });
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "watchers",
      action: "watcher.fired",
      entityType: "watcher",
      entityId: row.id,
      agentId: row.agentId,
      details: { name: row.name, symbol: row.symbol, price: quote.price, changePercent: outcome.changePercent, alertId: alert!.id },
    }).catch(() => undefined);
    return alert!.id;
  }

  async function loadWebPageSnapshot(watcherId: string): Promise<WatcherWebPageSnapshot | null> {
    const [row] = await db
      .select({
        lastPrice: watcherWebPageSnapshots.lastPrice,
        lastInStock: watcherWebPageSnapshots.lastInStock,
        lastItemKeys: watcherWebPageSnapshots.lastItemKeys,
        lastContentHash: watcherWebPageSnapshots.lastContentHash,
      })
      .from(watcherWebPageSnapshots)
      .where(eq(watcherWebPageSnapshots.watcherId, watcherId));
    return row ?? null;
  }

  /** Web-page watchers' analog of recordSuccess: a fetch result compared to a last-seen snapshot, not a price history window. */
  async function recordWebPageSuccess(row: WatcherRow, fetched: WatcherWebPageFetchResult, now: Date): Promise<string | null> {
    const rule = readWebPageRule(row);
    const c = counters(row, now);
    const next = new Date(now.getTime() + row.checkEveryMinutes * 60_000);
    const base = {
      lastCheckAt: now,
      consecutiveFailures: 0,
      nextCheckAt: next,
      checkLeaseUntil: null,
      countersDay: c.countersDay,
      checksToday: c.checksToday + 1,
    };
    if (!rule) {
      await db
        .update(watchers)
        .set({ ...base, lastCheckOk: false, lastCheckMessage: "The rule could not be read. Edit the watcher and save it again.", alertsToday: c.alertsToday })
        .where(eq(watchers.id, row.id));
      return null;
    }

    const previous = await loadWebPageSnapshot(row.id);
    const outcome = evaluateWatcherWebPageRule(rule, fetched, previous, row.conditionMet);

    const cooling = row.lastAlertAt !== null && now.getTime() - row.lastAlertAt.getTime() < row.cooldownMinutes * 60_000;
    const capped = c.alertsToday >= WATCHER_MAX_ALERTS_PER_DAY;
    const fires = outcome.wantsAlert && !cooling && !capped;

    // Only the `price` rule has a crossing to remember (the same shape as the numeric `level` rule).
    const conditionMet = rule.kind === "price" ? (outcome.conditionNow ? fires || row.conditionMet : false) : row.conditionMet;

    let message: string | null = null;
    if (outcome.wantsAlert && cooling) message = "The rule fired, but the watcher is in its quiet time after the last alert.";
    if (outcome.wantsAlert && capped) message = `The rule fired, but today's ${WATCHER_MAX_ALERTS_PER_DAY} alerts are used up.`;

    await db
      .update(watchers)
      .set({
        ...base,
        lastCheckOk: true,
        lastCheckMessage: message,
        conditionMet,
        ...(fires && rule.kind === "price" ? { lastAlertPrice: outcome.nextSnapshot.lastPrice } : {}),
        ...(fires ? { lastAlertAt: now } : {}),
        alertsToday: c.alertsToday + (fires ? 1 : 0),
      })
      .where(eq(watchers.id, row.id));

    await db
      .insert(watcherWebPageSnapshots)
      .values({
        companyId: row.companyId,
        watcherId: row.id,
        lastPrice: outcome.nextSnapshot.lastPrice,
        lastInStock: outcome.nextSnapshot.lastInStock,
        lastItemKeys: outcome.nextSnapshot.lastItemKeys,
        lastContentHash: outcome.nextSnapshot.lastContentHash,
        observedAt: fetched.observedAt,
      })
      .onConflictDoUpdate({
        target: watcherWebPageSnapshots.watcherId,
        set: {
          lastPrice: outcome.nextSnapshot.lastPrice,
          lastInStock: outcome.nextSnapshot.lastInStock,
          lastItemKeys: outcome.nextSnapshot.lastItemKeys,
          lastContentHash: outcome.nextSnapshot.lastContentHash,
          observedAt: fetched.observedAt,
          updatedAt: now,
        },
      });

    if (!fires) return null;
    const facts: WatcherAlertFacts = {
      watcherName: row.name,
      source: row.source as WatcherSource,
      symbol: row.symbol,
      subject: subjectOf(row),
      currency: currencyOf(row),
      price: null,
      basePrice: null,
      changePercent: null,
      windowHours: null,
      ruleText: describeWatcherWebPageRule(rule),
      changeSummary: outcome.changeSummary,
      isTest: false,
      observedAt: fetched.observedAt.toISOString(),
    };
    const [alert] = await db
      .insert(watcherAlerts)
      .values({
        companyId: row.companyId,
        watcherId: row.id,
        agentId: row.agentId,
        status: "composing",
        facts: facts as unknown as Record<string, unknown>,
        createdAt: now,
      })
      .returning({ id: watcherAlerts.id });
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "watchers",
      action: "watcher.fired",
      entityType: "watcher",
      entityId: row.id,
      agentId: row.agentId,
      details: { name: row.name, symbol: row.symbol, changeSummary: outcome.changeSummary, alertId: alert!.id },
    }).catch(() => undefined);
    return alert!.id;
  }

  async function checkPriceWatchers(rows: WatcherRow[], now: Date): Promise<{ failed: number; fired: number }> {
    let failed = 0;
    let fired = 0;
    const prices = await fetchPrices(rows, now);
    for (const row of rows) {
      const quote = prices.get(row.id);
      try {
        if (!quote || isWatcherQuoteError(quote)) {
          failed += 1;
          await recordFailure(row, quote ?? { kind: "upstream", message: "No price came back." }, now);
          continue;
        }
        if (await recordSuccess(row, quote, now)) fired += 1;
      } catch (err) {
        failed += 1;
        logger.error({ err, watcherId: row.id }, "watchers: recording a check failed");
        // The lease expires on its own; the watcher is checked again then.
      }
    }
    return { failed, fired };
  }

  async function checkWebPageWatchers(rows: WatcherRow[], now: Date): Promise<{ failed: number; fired: number }> {
    let failed = 0;
    let fired = 0;
    for (const row of rows) {
      try {
        const rule = readWebPageRule(row);
        if (!rule) {
          failed += 1;
          await recordFailure(row, { kind: "upstream", message: "The rule could not be read." }, now);
          continue;
        }
        const fetched = await webPageFetcher.fetch(rule, now);
        if (isWatcherWebPageFetchError(fetched)) {
          failed += 1;
          await recordFailure(row, fetched, now);
          continue;
        }
        if (await recordWebPageSuccess(row, fetched, now)) fired += 1;
      } catch (err) {
        failed += 1;
        logger.error({ err, watcherId: row.id }, "watchers: recording a web-page check failed");
      }
    }
    return { failed, fired };
  }

  async function checkWatchers(rows: WatcherRow[], now: Date): Promise<{ checked: number; failed: number; fired: number }> {
    const priceRows = rows.filter((row) => row.source !== "web_page");
    const webPageRows = rows.filter((row) => row.source === "web_page");
    const [priceResult, webPageResult] = await Promise.all([
      priceRows.length > 0 ? checkPriceWatchers(priceRows, now) : { failed: 0, fired: 0 },
      webPageRows.length > 0 ? checkWebPageWatchers(webPageRows, now) : { failed: 0, fired: 0 },
    ]);
    return {
      checked: rows.length,
      failed: priceResult.failed + webPageResult.failed,
      fired: priceResult.fired + webPageResult.fired,
    };
  }

  async function expireStaleAlerts(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - WATCHER_OUTBOX_MAX_AGE_MS);
    const rows = await db
      .update(watcherAlerts)
      .set({ status: "expired", note: "Not sent: nobody picked it up within a day (is the Telegram bridge running, and has the bot been started?)." })
      .where(and(eq(watcherAlerts.status, "ready"), lt(watcherAlerts.readyAt, cutoff)))
      .returning({ id: watcherAlerts.id });
    return rows.length;
  }

  async function claimAlertsToCompose(now: Date): Promise<WatcherAlertRow[]> {
    const waiting = await db
      .select({ id: watcherAlerts.id })
      .from(watcherAlerts)
      .where(
        and(
          eq(watcherAlerts.status, "composing"),
          or(isNull(watcherAlerts.composeLeaseUntil), lt(watcherAlerts.composeLeaseUntil, now)),
        ),
      )
      .orderBy(asc(watcherAlerts.createdAt))
      .limit(WATCHER_COMPOSE_BATCH);
    const claimed: WatcherAlertRow[] = [];
    for (const { id } of waiting) {
      const [row] = await db
        .update(watcherAlerts)
        .set({
          composeLeaseUntil: new Date(now.getTime() + WATCHER_COMPOSE_LEASE_MS),
          composeAttempts: sql`${watcherAlerts.composeAttempts} + 1`,
        })
        .where(
          and(
            eq(watcherAlerts.id, id),
            eq(watcherAlerts.status, "composing"),
            or(isNull(watcherAlerts.composeLeaseUntil), lt(watcherAlerts.composeLeaseUntil, now)),
          ),
        )
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  function dispatchCompose(alert: WatcherAlertRow) {
    dispatch(async () => {
      try {
        await composeAlert(alert.id);
      } catch (err) {
        // The lease runs out and the next tick tries again (up to three times).
        logger.error({ err, alertId: alert.id }, "watchers: writing an alert failed; it will be tried again");
      }
    });
  }

  async function tick(now: Date = nowOf()) {
    const expired = await expireStaleAlerts(now);
    const due = await claimDueWatchers(now);
    const result = due.length > 0 ? await checkWatchers(due, now) : { checked: 0, failed: 0, fired: 0 };
    const composing = await claimAlertsToCompose(now);
    for (const alert of composing) dispatchCompose(alert);
    return { ...result, composing: composing.length, expired };
  }

  // ─── Writing an alert ──────────────────────────────────────────────────────

  async function composeAlert(alertId: string): Promise<void> {
    const [alert] = await db.select().from(watcherAlerts).where(eq(watcherAlerts.id, alertId));
    if (!alert || alert.status !== "composing") return;
    const facts = alert.facts as unknown as WatcherAlertFacts;
    const [watcher] = await db
      .select()
      .from(watchers)
      .where(and(eq(watchers.id, alert.watcherId), eq(watchers.companyId, alert.companyId)));
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, alert.agentId), eq(agents.companyId, alert.companyId)));
    const notes: string[] = [];
    let text = watcherPlainAlertText(facts);

    if (alert.composeAttempts > WATCHER_COMPOSE_MAX_ATTEMPTS) {
      notes.push("The agent could not write this alert after several tries, so the facts were sent as they are.");
    } else if (!agent || !agent.laneAEnabled) {
      notes.push("The watcher's agent is not a quick agent any more, so the facts were sent as they are.");
    } else {
      try {
        const written = await laneA.transform({
          companyId: alert.companyId,
          targetAgent: {
            id: agent.id,
            companyId: agent.companyId,
            name: agent.name,
            role: agent.role,
            laneAEnabled: agent.laneAEnabled,
            laneAInstructions: agent.laneAInstructions ?? null,
            status: agent.status ?? null,
            laneAModel: agent.laneAModel ?? null,
            laneAMaxOutputTokens: agent.laneAMaxOutputTokens ?? null,
            laneATransformDailyCallCap: agent.laneATransformDailyCallCap ?? null,
          },
          input: watcherFactsForAgent(facts),
          task: WATCHER_ALERT_TASK,
          maxOutputChars: 700,
        });
        const words = written.text.trim();
        if (words) {
          // The agent's words, then the facts exactly as measured, so a
          // number the model got wrong can never be the only one shown.
          text = `${facts.isTest ? "🧪 Test alert\n" : ""}${words}\n\n${watcherFactsLine(facts)}`;
        } else {
          notes.push(`${agent.name} gave no text, so the facts were sent as they are.`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown reason";
        notes.push(`${agent.name} could not write this one (${reason.slice(0, 200)}), so the facts were sent as they are.`);
      }
    }

    let imageFileId: string | null = null;
    if (watcher?.withPicture) {
      if (!agent) {
        notes.push("No picture: the agent was not found.");
      } else {
        try {
          const picture = await laneA.makePicture({
            companyId: alert.companyId,
            agentId: agent.id,
            prompt: watcherPicturePrompt(facts),
            runLabel: alert.id,
          });
          if (picture.ok) imageFileId = picture.fileId;
          else notes.push(`No picture this time: ${picture.reason}`);
        } catch (err) {
          notes.push(`No picture this time: ${err instanceof Error ? err.message.slice(0, 200) : "the picture failed"}.`);
        }
      }
    }

    const now = nowOf();
    await db
      .update(watcherAlerts)
      .set({
        status: "ready",
        text,
        imageFileId,
        note: notes.length > 0 ? notes.join(" ").slice(0, 1000) : null,
        readyAt: now,
        composeLeaseUntil: null,
      })
      .where(and(eq(watcherAlerts.id, alert.id), eq(watcherAlerts.status, "composing")));
  }

  // ─── Test alert ────────────────────────────────────────────────────────────

  async function testAlert(companyId: string, watcherId: string, actor: WatcherActor): Promise<WatcherAlertSummary> {
    const row = await getRow(companyId, watcherId);
    const now = nowOf();
    const c = counters(row, now);
    if (c.alertsToday >= WATCHER_MAX_ALERTS_PER_DAY) {
      throw tooManyRequests(`This watcher has sent its ${WATCHER_MAX_ALERTS_PER_DAY} alerts for today (tests count too). Try again tomorrow.`);
    }
    const rule = readAnyRule(row);
    if (!rule) throw unprocessable("Set the rule again: the saved one could not be read.");
    let facts: WatcherAlertFacts;
    if (row.source === "web_page") {
      const fetched = await webPageFetcher.fetch(rule as WatcherWebPageRule, now);
      if (isWatcherWebPageFetchError(fetched)) throw unprocessable(`No page data to test with yet. ${fetched.message}`.trim());
      facts = {
        watcherName: row.name,
        source: row.source as WatcherSource,
        symbol: row.symbol,
        subject: subjectOf(row),
        currency: currencyOf(row),
        price: null,
        basePrice: null,
        changePercent: null,
        windowHours: null,
        ruleText: describeWatcherWebPageRule(rule as WatcherWebPageRule),
        changeSummary: fetched.snippet || "No change detected yet.",
        isTest: true,
        observedAt: fetched.observedAt.toISOString(),
      };
    } else {
      let price = row.lastPrice;
      let observedAt = row.lastPriceAt ?? now;
      if (price === null) {
        const quote = (await fetchPrices([row], now)).get(row.id);
        if (!quote || isWatcherQuoteError(quote)) {
          throw unprocessable(`No price to test with yet. ${quote?.message ?? ""}`.trim());
        }
        price = quote.price;
        observedAt = quote.observedAt;
      }
      facts = {
        watcherName: row.name,
        source: row.source as WatcherSource,
        symbol: row.symbol,
        subject: subjectOf(row),
        currency: currencyOf(row),
        price,
        basePrice: null,
        changePercent: null,
        windowHours: null,
        ruleText: describeWatcherRule(rule as WatcherRule, subjectOf(row), currencyOf(row)),
        changeSummary: null,
        isTest: true,
        observedAt: observedAt.toISOString(),
      };
    }
    // Counted like any alert, so the test button cannot become a way round
    // the daily ceiling; cooldown and baseline are left alone.
    await db
      .update(watchers)
      .set({ countersDay: c.countersDay, checksToday: c.checksToday, alertsToday: c.alertsToday + 1 })
      .where(eq(watchers.id, row.id));
    const [alert] = await db
      .insert(watcherAlerts)
      .values({
        companyId,
        watcherId: row.id,
        agentId: row.agentId,
        status: "composing",
        isTest: true,
        facts: facts as unknown as Record<string, unknown>,
        composeAttempts: 1,
        composeLeaseUntil: new Date(now.getTime() + WATCHER_COMPOSE_LEASE_MS),
        createdAt: now,
      })
      .returning();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "watcher.test_alert",
      entityType: "watcher",
      entityId: row.id,
      agentId: row.agentId,
      details: { name: row.name, alertId: alert!.id },
    });
    dispatchCompose(alert!);
    return toAlertSummary(alert!);
  }

  // ─── Outbox (the Telegram bridge) ──────────────────────────────────────────

  async function outbox(companyId: string): Promise<WatcherOutboxItem[]> {
    const cutoff = new Date(nowOf().getTime() - WATCHER_OUTBOX_MAX_AGE_MS);
    const rows = await db
      .select({ alert: watcherAlerts, watcherName: watchers.name })
      .from(watcherAlerts)
      .innerJoin(watchers, eq(watchers.id, watcherAlerts.watcherId))
      .where(
        and(
          eq(watcherAlerts.companyId, companyId),
          eq(watcherAlerts.status, "ready"),
          gte(watcherAlerts.readyAt, cutoff),
        ),
      )
      .orderBy(asc(watcherAlerts.createdAt))
      .limit(OUTBOX_BATCH);
    return rows.map(({ alert, watcherName }) => ({
      id: alert.id,
      companyId: alert.companyId,
      watcherId: alert.watcherId,
      watcherName,
      agentId: alert.agentId,
      text: alert.text ?? watcherPlainAlertText(alert.facts as unknown as WatcherAlertFacts),
      imageFileId: alert.imageFileId,
      isTest: alert.isTest,
      createdAt: alert.createdAt.toISOString(),
    }));
  }

  async function ack(
    companyId: string,
    alertId: string,
    input: { outcome: "delivered" | "failed"; note?: string },
  ): Promise<WatcherAlertSummary> {
    const [row] = await db
      .select()
      .from(watcherAlerts)
      .where(and(eq(watcherAlerts.id, alertId), eq(watcherAlerts.companyId, companyId)));
    if (!row) throw notFound("That alert was not found.");
    // Idempotent: a second acknowledgement (a retry after a lost answer)
    // changes nothing and is not an error.
    if (row.status !== "ready") return toAlertSummary(row);
    const [updated] = await db
      .update(watcherAlerts)
      .set({
        status: input.outcome,
        deliveredAt: input.outcome === "delivered" ? nowOf() : null,
        note: input.note ? [row.note, input.note].filter(Boolean).join(" ").slice(0, 1000) : row.note,
      })
      .where(and(eq(watcherAlerts.id, row.id), eq(watcherAlerts.status, "ready")))
      .returning();
    return toAlertSummary(updated ?? row);
  }

  return { list, get, create, update, remove, testAlert, tick, composeAlert, outbox, ack };
}
