import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  createDb,
  secretAccessEvents,
  watcherAlerts,
  watcherPricePoints,
  watcherWebPageSnapshots,
  watchers,
} from "@paperclipai/db";
import { WATCHER_MAX_ALERTS_PER_DAY } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { HttpError } from "../errors.ts";
import { resetWatcherSourceState } from "../services/watcher-sources.ts";
import {
  createFakeWatcherWebPageFetcher,
  type WatcherWebPageFetchError,
  type WatcherWebPageFetchResult,
} from "../services/watcher-web-page.ts";
import {
  WATCHER_ALERT_TASK,
  resetWatcherKeyCache,
  watcherService,
  type WatcherServiceDeps,
} from "../services/watchers.ts";

/**
 * Watchers against a real Postgres with every migration applied, and a fake
 * for every price request (no real price API is called) and for the quick
 * agent (no model is called):
 *   - setting one up: only a quick agent speaks, keyed sources need a key,
 *     the key is bound to the watcher and never shown
 *   - the tick: a due watcher is claimed once (two ticks at once check it
 *     once), the price is recorded, the rule fires, the watcher goes quiet
 *     for its cooldown, a failure backs off and never alerts
 *   - the alert: the agent words the facts (one call, with the watcher task),
 *     a picture is made when asked for, the facts line is always there, and
 *     when the agent cannot write it the facts go out anyway
 *   - the outbox: ready alerts per company, acknowledged once, old ones
 *     expire, another company sees nothing
 *   - the operator's first watchers: Bitcoin, Solana, Ethereum and DNB
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping watcher service tests: ${support.reason ?? "unsupported environment"}`);
}

const T0 = new Date("2026-09-28T12:00:00.000Z");
const FINNHUB_KEY = "d0fakefinnhubkeyABCDEFGH123456";
const EODHD_KEY = "68f0fakeeodhdtoken.99999999";
const USER = { userId: "filip" };

type Prices = Record<string, { usd: number; change?: number }>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

d("watchers", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-watchers-${randomUUID()}`);

  let now = T0;
  let coingecko: Prices = {};
  let coingeckoStatus = 200;
  let finnhub: { status: number; body: unknown } = { status: 200, body: {} };
  let eodhd: { status: number; body: unknown } = { status: 200, body: [] };
  let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  let pending: Promise<void>[] = [];
  const transform = vi.fn();
  const makePicture = vi.fn();

  vi.setConfig({ testTimeout: 60_000 });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    fetchCalls.push({ url: url.href, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.hostname === "api.coingecko.com") {
      if (coingeckoStatus !== 200) return new Response("", { status: coingeckoStatus });
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      const body: Record<string, unknown> = {};
      for (const id of ids) {
        const p = coingecko[id];
        if (p) body[id] = { usd: p.usd, usd_24h_change: p.change ?? 0, last_updated_at: Math.floor(now.getTime() / 1000) };
      }
      return json(body);
    }
    if (url.hostname === "data-api.binance.vision") return new Response("", { status: 503 });
    if (url.hostname === "finnhub.io") return json(finnhub.body, finnhub.status);
    if (url.hostname === "eodhd.com") return json(eodhd.body, eodhd.status);
    throw new Error(`unexpected request to ${url.hostname}`);
  }) as unknown as typeof fetch;

  function service(overrides: Partial<WatcherServiceDeps> = {}) {
    return watcherService(db, {
      fetchImpl,
      now: () => now,
      laneA: { transform, makePicture } as unknown as WatcherServiceDeps["laneA"],
      dispatch: (work) => {
        pending.push(work());
      },
      ...overrides,
    });
  }

  async function settle() {
    const work = pending;
    pending = [];
    await Promise.all(work);
  }

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("watchers");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  beforeEach(() => {
    now = T0;
    coingecko = {};
    coingeckoStatus = 200;
    finnhub = { status: 200, body: {} };
    eodhd = { status: 200, body: [] };
    fetchCalls = [];
    pending = [];
    resetWatcherSourceState();
    resetWatcherKeyCache();
    transform.mockReset();
    makePicture.mockReset();
    transform.mockResolvedValue({ text: "Big news: Bitcoin just jumped!", model: "fake", provider: "anthropic" });
    makePicture.mockResolvedValue({ ok: true, fileId: randomUUID(), seed: 7 });
  });

  afterEach(async () => {
    // Watchers from one test must never be due in the next one's tick.
    await db.update(watchers).set({ enabled: false });
    await db.update(watcherAlerts).set({ status: "delivered" });
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watch",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Maja", quick = true) {
    const created = await agentService(db).create(companyId, {
      name,
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    if (quick) await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    return created.id;
  }

  async function seedSecret(companyId: string, name: string, value: string) {
    const secret = await secretService(db).create(companyId, { name, provider: "local_encrypted", value });
    return secret.id;
  }

  async function row(watcherId: string) {
    const [found] = await db.select().from(watchers).where(eq(watchers.id, watcherId));
    return found!;
  }

  async function alertsOf(watcherId: string) {
    return db.select().from(watcherAlerts).where(eq(watcherAlerts.watcherId, watcherId));
  }

  const either5 = { kind: "change" as const, direction: "either" as const, percent: 5, windowHours: 24 };

  async function bitcoinWatcher(companyId: string, agentId: string, extra: Record<string, unknown> = {}) {
    return service().create(
      companyId,
      {
        name: "Bitcoin swings",
        agentId,
        source: "crypto",
        symbol: "BTC",
        rule: either5,
        checkEveryMinutes: 15,
        cooldownMinutes: 360,
        enabled: true,
        withPicture: false,
        keySecretId: null,
        ...extra,
      } as never,
      USER,
    );
  }

  describe("setting a watcher up", () => {
    it("only a quick agent can speak for a watcher", async () => {
      const companyId = await seedCompany();
      const fullAgent = await seedAgent(companyId, "Builder", false);
      await expect(bitcoinWatcher(companyId, fullAgent)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("does not have quick answers switched on"),
      });
      const otherCompany = await seedCompany();
      const stranger = await seedAgent(otherCompany, "Stranger");
      await expect(bitcoinWatcher(companyId, stranger)).rejects.toMatchObject({ status: 422 });
    });

    it("refuses an unlisted coin, a stock without a key, and Oslo checks more often than every 6 hours", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      await expect(bitcoinWatcher(companyId, maja, { symbol: "NOPECOIN" })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Pick one of the listed coins"),
      });
      await expect(bitcoinWatcher(companyId, maja, { source: "us_stock", symbol: "AAPL" })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("needs a Finnhub key"),
      });
      const key = await seedSecret(companyId, "EODHD", EODHD_KEY);
      await expect(
        bitcoinWatcher(companyId, maja, { source: "oslo_stock", symbol: "DNB", keySecretId: key, checkEveryMinutes: 60 }),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("at most every 6 hours") });
    });

    it("binds the key to the watcher and never returns it; deleting the watcher removes the binding", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const key = await seedSecret(companyId, "Finnhub", FINNHUB_KEY);
      const created = await bitcoinWatcher(companyId, maja, { source: "us_stock", symbol: "aapl", keySecretId: key });
      expect(created).toMatchObject({ symbol: "AAPL", keySecretId: key, ruleText: "AAPL moves 5% or more (up or down) within 24 hours" });
      expect(JSON.stringify(created)).not.toContain(FINNHUB_KEY);
      const bindings = await db
        .select()
        .from(companySecretBindings)
        .where(and(eq(companySecretBindings.targetType, "watcher"), eq(companySecretBindings.targetId, created.id)));
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ secretId: key, configPath: "source_key" });

      await service().remove(companyId, created.id, USER);
      const after = await db
        .select()
        .from(companySecretBindings)
        .where(and(eq(companySecretBindings.targetType, "watcher"), eq(companySecretBindings.targetId, created.id)));
      expect(after).toHaveLength(0);
      const log = await db.select().from(activityLog).where(eq(activityLog.entityId, created.id));
      expect(log.map((entry) => entry.action).sort()).toEqual(["watcher.created", "watcher.deleted"]);
    });
  });

  describe("the tick", () => {
    it("Bitcoin up 5% in 24 hours: one price request, the rule fires, the agent words it, a picture is made, it waits in the outbox", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja, { withPicture: true });
      coingecko = { bitcoin: { usd: 84000, change: 5 } };

      const result = await service().tick(now);
      expect(result).toMatchObject({ checked: 1, failed: 0, fired: 1, composing: 1 });
      expect(fetchCalls).toHaveLength(1);
      await settle();

      expect(transform).toHaveBeenCalledTimes(1);
      const call = transform.mock.calls[0]![0];
      expect(call.task).toBe(WATCHER_ALERT_TASK);
      expect(call.targetAgent).toMatchObject({ id: maja, name: "Maja", laneAEnabled: true });
      expect(call.input).toContain("Price now: $84,000");
      expect(call.input).toContain("Measured from: $80,000");
      expect(call.input).toContain("Change: +5%");
      expect(makePicture).toHaveBeenCalledTimes(1);
      expect(makePicture.mock.calls[0]![0].prompt).toContain("green price chart");

      const [alert] = await alertsOf(watcher.id);
      expect(alert).toMatchObject({ status: "ready", isTest: false, note: null });
      expect(alert!.text).toBe("Big news: Bitcoin just jumped!\n\nBitcoin (BTC): $84,000, +5% in 24 hours (from $80,000)");
      expect(alert!.imageFileId).toBeTruthy();

      const saved = await row(watcher.id);
      expect(saved).toMatchObject({ lastPrice: 84000, checksToday: 1, alertsToday: 1, lastCheckOk: true, checkLeaseUntil: null });
      expect(saved.nextCheckAt.getTime()).toBe(T0.getTime() + 15 * 60_000);

      const outbox = await service().outbox(companyId);
      expect(outbox).toEqual([
        expect.objectContaining({ id: alert!.id, agentId: maja, watcherName: "Bitcoin swings", imageFileId: alert!.imageFileId, text: alert!.text }),
      ]);
      await service().ack(companyId, alert!.id, { outcome: "delivered" });
      expect(await service().outbox(companyId)).toEqual([]);
      // A repeated acknowledgement (a retry) changes nothing and is no error.
      expect(await service().ack(companyId, alert!.id, { outcome: "failed" })).toMatchObject({ status: "delivered" });
    });

    it("Bitcoin, Solana and Ethereum share one CoinGecko request", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      await bitcoinWatcher(companyId, maja);
      await bitcoinWatcher(companyId, maja, { name: "Solana", symbol: "SOL" });
      await bitcoinWatcher(companyId, maja, { name: "Ethereum", symbol: "ETH" });
      coingecko = { bitcoin: { usd: 84000 }, solana: { usd: 150 }, ethereum: { usd: 2600 } };
      const result = await service().tick(now);
      expect(result).toMatchObject({ checked: 3, failed: 0, fired: 0 });
      expect(fetchCalls).toHaveLength(1);
      expect(new URL(fetchCalls[0]!.url).searchParams.get("ids")).toBe("bitcoin,solana,ethereum");
    });

    it("two ticks at the same moment check a watcher once", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja);
      coingecko = { bitcoin: { usd: 84000 } };
      const [a, b] = await Promise.all([service().tick(now), service().tick(now)]);
      expect(a.checked + b.checked).toBe(1);
      expect((await row(watcher.id)).checksToday).toBe(1);
      const points = await db.select().from(watcherPricePoints).where(eq(watcherPricePoints.watcherId, watcher.id));
      expect(points).toHaveLength(1);
    });

    it("stays quiet during the cooldown, then alerts on a fresh move from the last alert's price", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja, { cooldownMinutes: 60 });
      coingecko = { bitcoin: { usd: 84000, change: 5 } };
      await service().tick(now);
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(1);

      now = new Date(T0.getTime() + 20 * 60_000);
      coingecko = { bitcoin: { usd: 89000, change: 11 } };
      await service().tick(now);
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(1);
      expect((await row(watcher.id)).lastCheckMessage).toContain("quiet time");

      now = new Date(T0.getTime() + 65 * 60_000);
      coingecko = { bitcoin: { usd: 89000, change: 11 } };
      await service().tick(now);
      await settle();
      const alerts = await alertsOf(watcher.id);
      expect(alerts).toHaveLength(2);
      const second = alerts.find((alert) => alert.id !== alerts[0]!.id && (alert.facts as { price: number }).price === 89000);
      expect((second!.facts as { basePrice: number }).basePrice).toBe(84000);
    });

    it("a failed check backs off, says why in plain words, and never alerts", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja);
      coingeckoStatus = 500;
      const result = await service().tick(now);
      expect(result).toMatchObject({ checked: 1, failed: 1, fired: 0, composing: 0 });
      let saved = await row(watcher.id);
      expect(saved).toMatchObject({ lastCheckOk: false, consecutiveFailures: 1, checksToday: 1, alertsToday: 0 });
      expect(saved.lastCheckMessage).toBe("CoinGecko did not answer as expected. The next check tries again.");
      expect(saved.nextCheckAt.getTime()).toBe(T0.getTime() + 2 * 15 * 60_000);

      now = saved.nextCheckAt;
      await service().tick(now);
      saved = await row(watcher.id);
      expect(saved.consecutiveFailures).toBe(2);
      expect(saved.nextCheckAt.getTime()).toBe(now.getTime() + 4 * 15 * 60_000);
      expect(await alertsOf(watcher.id)).toHaveLength(0);
    });

    it("the price level rule fires once per crossing", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja, {
        rule: { kind: "level", direction: "above", price: 90000 },
        cooldownMinutes: 0,
      });
      const at = (minutes: number, usd: number) => {
        now = new Date(T0.getTime() + minutes * 60_000);
        coingecko = { bitcoin: { usd } };
        return service().tick(now);
      };
      await at(0, 89000);
      await at(15, 91000);
      await at(30, 92000);
      await at(45, 88000);
      await at(60, 90500);
      await settle();
      expect((await alertsOf(watcher.id)).map((alert) => (alert.facts as { price: number }).price).sort()).toEqual([90500, 91000]);
    });

    it("never more than the daily ceiling of alerts, whatever the rule says", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja, {
        rule: { kind: "since_last_alert", percent: 1 },
        cooldownMinutes: 0,
        checkEveryMinutes: 5,
      });
      let usd = 80000;
      for (let i = 0; i < WATCHER_MAX_ALERTS_PER_DAY + 5; i += 1) {
        now = new Date(T0.getTime() + i * 6 * 60_000);
        usd = usd * 1.02;
        coingecko = { bitcoin: { usd } };
        await service().tick(now);
      }
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(WATCHER_MAX_ALERTS_PER_DAY);
      expect((await row(watcher.id)).lastCheckMessage).toContain("alerts are used up");
    });
  });

  describe("writing the alert", () => {
    it("when the agent cannot write it, the facts go out anyway with a note", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja, { withPicture: true });
      transform.mockRejectedValue(new HttpError(403, "This quick agent is paused, so it is not doing any work right now."));
      makePicture.mockResolvedValue({ ok: false, reason: 'Maja is not allowed to make pictures. Tick "Generate image" on Maja\'s Tools tab.' });
      coingecko = { bitcoin: { usd: 76000, change: -5 } };
      await service().tick(now);
      await settle();
      const [alert] = await alertsOf(watcher.id);
      expect(alert!.status).toBe("ready");
      expect(alert!.text).toBe(
        "📈 Bitcoin swings\nBitcoin (BTC): $76,000, -5% in 24 hours (from $80,000)\nRule: Bitcoin moves 5% or more (up or down) within 24 hours.",
      );
      expect(alert!.imageFileId).toBeNull();
      expect(alert!.note).toContain("Maja could not write this one (This quick agent is paused");
      expect(alert!.note).toContain("No picture this time: Maja is not allowed to make pictures");
    });

    it("a falling price asks for a stormy red picture", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      await bitcoinWatcher(companyId, maja, { withPicture: true });
      coingecko = { bitcoin: { usd: 76000, change: -5 } };
      await service().tick(now);
      await settle();
      expect(makePicture.mock.calls[0]![0].prompt).toContain("red price chart");
    });

    it("an alert whose writing crashed is tried again after its lease, then sent as plain facts", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja);
      coingecko = { bitcoin: { usd: 84000, change: 5 } };
      // The first try dies (a restart mid-write): nothing is dispatched.
      await service({ dispatch: () => undefined }).tick(now);
      const [stuck] = await alertsOf(watcher.id);
      expect(stuck).toMatchObject({ status: "composing", composeAttempts: 1 });
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        now = new Date(now.getTime() + 11 * 60_000);
        await service({ dispatch: () => undefined }).tick(now);
      }
      now = new Date(now.getTime() + 11 * 60_000);
      await service().tick(now);
      await settle();
      const [done] = await alertsOf(watcher.id);
      expect(done).toMatchObject({ status: "ready", composeAttempts: 4 });
      expect(done!.note).toContain("could not write this alert after several tries");
      expect(transform).not.toHaveBeenCalled();
    });

    it("a test alert uses the last price, is marked as a test, counts toward the daily ceiling and leaves the cooldown alone", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja);
      coingecko = { bitcoin: { usd: 84000 } };
      await service().tick(now);
      const summary = await service().testAlert(companyId, watcher.id, USER);
      expect(summary).toMatchObject({ isTest: true, status: "composing" });
      await settle();
      const [alert] = await alertsOf(watcher.id);
      expect(alert).toMatchObject({ status: "ready", isTest: true });
      expect(alert!.text!.startsWith("🧪 Test alert\n")).toBe(true);
      expect(transform.mock.calls[0]![0].input).toContain("This is a TEST alert");
      const saved = await row(watcher.id);
      expect(saved).toMatchObject({ alertsToday: 1, lastAlertAt: null });
    });
  });

  describe("the outbox", () => {
    it("a ready alert nobody picked up within a day expires instead of going out late", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja);
      coingecko = { bitcoin: { usd: 84000, change: 5 } };
      await service().tick(now);
      await settle();
      expect(await service().outbox(companyId)).toHaveLength(1);
      now = new Date(T0.getTime() + 25 * 3_600_000);
      coingecko = { bitcoin: { usd: 84000, change: 0 } };
      const result = await service().tick(now);
      expect(result.expired).toBe(1);
      expect(await service().outbox(companyId)).toEqual([]);
      const [alert] = await alertsOf(watcher.id);
      expect(alert).toMatchObject({ status: "expired" });
      expect(alert!.note).toContain("Not sent");
    });

    it("another company sees none of it and cannot acknowledge it", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await bitcoinWatcher(companyId, maja);
      coingecko = { bitcoin: { usd: 84000, change: 5 } };
      await service().tick(now);
      await settle();
      const [alert] = await alertsOf(watcher.id);
      const otherCompany = await seedCompany();
      expect(await service().outbox(otherCompany)).toEqual([]);
      await expect(service().ack(otherCompany, alert!.id, { outcome: "delivered" })).rejects.toMatchObject({ status: 404 });
      expect((await alertsOf(watcher.id))[0]!.status).toBe("ready");
      await expect(service().list(otherCompany)).resolves.toEqual([]);
      await expect(service().testAlert(otherCompany, watcher.id, USER)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("web-page watchers", () => {
    const WATCHED_URL = "https://example.com/widget";

    async function webPageWatcher(companyId: string, agentId: string, extra: Record<string, unknown> = {}) {
      return service().create(
        companyId,
        {
          name: "Widget price",
          agentId,
          source: "web_page",
          symbol: "Widget",
          rule: {
            kind: "price",
            url: WATCHED_URL,
            selector: ".price",
            direction: "below",
            targetPrice: 100,
            currency: "USD",
          },
          checkEveryMinutes: 60,
          cooldownMinutes: 360,
          enabled: true,
          withPicture: false,
          keySecretId: null,
          ...extra,
        } as never,
        USER,
      );
    }

    function fetchResult(overrides: Partial<WatcherWebPageFetchResult> = {}): WatcherWebPageFetchResult {
      return { price: null, inStock: null, itemKeys: null, contentHash: null, snippet: "", observedAt: now, ...overrides };
    }

    it("reuses the tick/lease/compose pipeline through the fake fetcher: a price crossing fires, writes a snapshot, and composes an alert", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await webPageWatcher(companyId, maja);
      const fake = createFakeWatcherWebPageFetcher(new Map([[WATCHED_URL, fetchResult({ price: 89, snippet: "$89" })]]));

      const result = await service({ webPageFetcher: fake }).tick(now);
      expect(result).toMatchObject({ checked: 1, failed: 0, fired: 1, composing: 1 });
      await settle();

      expect(transform).toHaveBeenCalledTimes(1);
      const [alert] = await alertsOf(watcher.id);
      expect(alert).toMatchObject({ status: "ready" });
      expect((alert!.facts as { changeSummary: string }).changeSummary).toContain("89");

      const [snapshot] = await db
        .select()
        .from(watcherWebPageSnapshots)
        .where(eq(watcherWebPageSnapshots.watcherId, watcher.id));
      expect(snapshot).toMatchObject({ lastPrice: 89 });

      const saved = await row(watcher.id);
      expect(saved).toMatchObject({ lastCheckOk: true, checkLeaseUntil: null });
      expect(saved.nextCheckAt.getTime()).toBe(T0.getTime() + 60 * 60_000);
    });

    it("a robots.txt block backs off exactly like any other fetch failure, and never writes a snapshot or alert", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await webPageWatcher(companyId, maja);
      const blocked: WatcherWebPageFetchError = {
        kind: "robots_blocked",
        message: "robots.txt for example.com disallows fetching this page.",
      };
      const fake = createFakeWatcherWebPageFetcher(new Map([[WATCHED_URL, blocked]]));

      const result = await service({ webPageFetcher: fake }).tick(now);
      expect(result).toMatchObject({ checked: 1, failed: 1, fired: 0 });

      const saved = await row(watcher.id);
      expect(saved).toMatchObject({ lastCheckOk: false, consecutiveFailures: 1 });
      expect(saved.lastCheckMessage).toContain("disallows fetching");
      expect(saved.nextCheckAt.getTime()).toBe(T0.getTime() + 2 * 60 * 60_000);
      expect(await alertsOf(watcher.id)).toHaveLength(0);
      const snapshots = await db
        .select()
        .from(watcherWebPageSnapshots)
        .where(eq(watcherWebPageSnapshots.watcherId, watcher.id));
      expect(snapshots).toHaveLength(0);
    });

    it("a second check that no longer crosses the target stays quiet, and does not re-fire on the same crossing", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const watcher = await webPageWatcher(companyId, maja, { cooldownMinutes: 0 });
      const fakeBelow = createFakeWatcherWebPageFetcher(new Map([[WATCHED_URL, fetchResult({ price: 89 })]]));
      await service({ webPageFetcher: fakeBelow }).tick(now);
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(1);

      now = new Date(T0.getTime() + 60 * 60_000);
      const fakeStillBelow = createFakeWatcherWebPageFetcher(new Map([[WATCHED_URL, fetchResult({ price: 85 })]]));
      await service({ webPageFetcher: fakeStillBelow }).tick(now);
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(1);

      now = new Date(T0.getTime() + 120 * 60_000);
      const fakeBackAbove = createFakeWatcherWebPageFetcher(new Map([[WATCHED_URL, fetchResult({ price: 150 })]]));
      await service({ webPageFetcher: fakeBackAbove }).tick(now);
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(1);

      now = new Date(T0.getTime() + 180 * 60_000);
      const fakeCrossesAgain = createFakeWatcherWebPageFetcher(new Map([[WATCHED_URL, fetchResult({ price: 90 })]]));
      await service({ webPageFetcher: fakeCrossesAgain }).tick(now);
      await settle();
      expect(await alertsOf(watcher.id)).toHaveLength(2);
    });
  });

  describe("stocks", () => {
    it("US stock: the key is read through its binding (and logged as a read), sent in a header, and kept out of every message", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const key = await seedSecret(companyId, "Finnhub", FINNHUB_KEY);
      const watcher = await bitcoinWatcher(companyId, maja, { name: "Apple", source: "us_stock", symbol: "AAPL", keySecretId: key });
      finnhub = { status: 200, body: { c: 230, t: Math.floor(T0.getTime() / 1000) } };
      await service().tick(now);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]!.headers["X-Finnhub-Token"]).toBe(FINNHUB_KEY);
      expect(fetchCalls[0]!.url).not.toContain(FINNHUB_KEY);
      expect((await row(watcher.id)).lastPrice).toBe(230);
      const reads = await db
        .select()
        .from(secretAccessEvents)
        .where(and(eq(secretAccessEvents.secretId, key), eq(secretAccessEvents.consumerType, "watcher")));
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ consumerId: watcher.id, outcome: "success" });

      finnhub = { status: 401, body: { error: `bad key ${FINNHUB_KEY}` } };
      now = new Date(T0.getTime() + 16 * 60_000);
      await service().tick(now);
      const saved = await row(watcher.id);
      expect(saved.lastCheckMessage).toBe("Finnhub did not accept the key. Check the saved secret, or get a new key from Finnhub.");
      const listed = JSON.stringify(await service().list(companyId));
      expect(listed).not.toContain(FINNHUB_KEY);
    });

    it("DNB on Oslo Børs: closing prices, measured from the day before's close", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const key = await seedSecret(companyId, "EODHD", EODHD_KEY);
      const watcher = await bitcoinWatcher(companyId, maja, {
        name: "DNB",
        source: "oslo_stock",
        symbol: "DNB",
        keySecretId: key,
        checkEveryMinutes: 360,
      });
      expect(watcher).toMatchObject({ currency: "NOK", ruleText: "DNB moves 5% or more (up or down) within 24 hours" });
      eodhd = {
        status: 200,
        body: [
          { date: "2026-09-25", close: 250 },
          { date: "2026-09-28", close: 263 },
        ],
      };
      const result = await service().tick(now);
      expect(result).toMatchObject({ checked: 1, fired: 1 });
      expect(new URL(fetchCalls[0]!.url).pathname).toBe("/api/eod/DNB.OL");
      await settle();
      const [alert] = await alertsOf(watcher.id);
      expect(alert!.text).toContain("DNB: NOK 263.00, +5.2% in 24 hours (from NOK 250.00)");
    });
  });
});
