import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, approvals, companies, createDb, tradingStrategies, tradingStrategyVersions } from "@paperclipai/db";
import { DEFAULT_TRADING_RISK_CONFIG, DEFAULT_TRADING_RULE_CONFIG } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { fakeTradingMarketData } from "../services/trading-market-data.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let tradingRoutes: typeof import("../routes/trading.js").tradingRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres trading route authz tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type MembershipRole = "owner" | "admin" | "operator" | "viewer";

/**
 * DUR-4171: trading.ts's own doc comment claims reading is open to any
 * active company member while changing a strategy (create/update/kill
 * switch) is owner/admin-only -- the same bar as company connections. This
 * is the first HTTP-level test proving that boundary actually holds over a
 * real request through companyScopeFromParam + assertCompanyOwnerAdminOrInstanceAdmin,
 * rather than only trusting the doc comment and the underlying authz
 * helper's own (separately tested) unit behavior.
 */
describeEmbeddedPostgres("tradingRoutes authz (DUR-4171)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trading-routes-authz-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/trading.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/trading.js")>("../routes/trading.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    tradingRoutes = routes.tradingRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(tradingStrategies); // its versions go with it
    await db.delete(approvals);
    await db.delete(activityLog); // the alert-settings route writes an audit row
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, membershipRole: MembershipRole) {
    if (!tradingRoutes || !errorHandler) {
      throw new Error("trading route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // source !== "local_implicit" and isInstanceAdmin: false so the
      // membershipRole below is what actually decides the outcome, instead
      // of one of assertCompanyOwnerAdminOrInstanceAdmin's other bypasses.
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: randomUUID(),
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
      };
      next();
    });
    // No network access -- see trading-market-data.ts's module doc comment (fakeTradingMarketData exists so exactly this kind of test never hits real Kraken).
    app.use("/api", tradingRoutes(db, { marketData: fakeTradingMarketData({}) }));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Trading Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  const strategyBody = {
    name: "Test strategy",
    asset: "BTC",
    checkEveryMinutes: 15,
    startingCashNok: 3_000,
    ruleConfig: DEFAULT_TRADING_RULE_CONFIG,
    riskConfig: DEFAULT_TRADING_RISK_CONFIG,
  };

  it.each(["owner", "admin"] as const)("lets an active %s create a strategy", async (membershipRole) => {
    const companyId = await seedCompany();
    const app = createApp(companyId, membershipRole);

    const res = await request(app).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ companyId, name: "Test strategy", status: "paused" });
  });

  it.each(["operator", "viewer"] as const)("refuses a %s creating a strategy with 403", async (membershipRole) => {
    const companyId = await seedCompany();
    const app = createApp(companyId, membershipRole);

    const res = await request(app).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);

    expect(res.status).toBe(403);
    const rows = await db.select().from(tradingStrategies);
    expect(rows).toHaveLength(0); // refused before any write, not just a misleading response code
  });

  it("lets any active member read market weather (DUR-5013) but not a company they do not belong to", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const app = createApp(companyId, "viewer");

    const current = await request(app).get(`/api/companies/${companyId}/trading/market-weather`);
    expect(current.status).toBe(200);
    expect(current.body).toEqual({ items: [] });

    const history = await request(app).get(`/api/companies/${companyId}/trading/market-weather/BTC`);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ asset: "BTC", name: "Bitcoin", current: null, spells: [] });

    expect((await request(app).get(`/api/companies/${companyId}/trading/market-weather/NOPE`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/trading/market-weather`)).status).toBe(403);
    expect((await request(app).post(`/api/companies/${companyId}/trading/market-weather`).send({})).status).toBe(404);
  });

  it("alert settings (DUR-5017): owners and admins read and change them, everyone else gets 403, and a bad value is refused before any write", async () => {
    const companyId = await seedCompany();
    const url = `/api/companies/${companyId}/trading/alert-settings`;
    for (const role of ["operator", "viewer"] as const) {
      const app = createApp(companyId, role);
      expect((await request(app).get(url)).status).toBe(403);
      expect((await request(app).patch(url).send({ dailySummary: false })).status).toBe(403);
    }
    const owner = createApp(companyId, "owner");
    const read = await request(owner).get(url);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ weatherFlips: true, bigMoves: true, breakerTrips: true, pausedAfterRestart: true, dailySummary: true, bigMoveAtrK: 3, pausedAfterRestartHours: 2 });

    const changed = await request(createApp(companyId, "admin")).patch(url).send({ bigMoves: false, bigMoveAtrK: 4 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ bigMoves: false, bigMoveAtrK: 4, dailySummary: true });
    expect((await request(owner).get(url)).body).toMatchObject({ bigMoves: false, bigMoveAtrK: 4 });

    expect((await request(owner).patch(url).send({ bigMoveAtrK: 50 })).status).toBe(400);
    expect((await request(owner).patch(url).send({ companyId: randomUUID() })).status).toBe(400);
    expect((await request(owner).patch(url).send({})).status).toBe(400);

    const otherCompanyId = await seedCompany();
    expect((await request(owner).get(`/api/companies/${otherCompanyId}/trading/alert-settings`)).status).toBe(403);
  });

  it("refuses a non-owner/admin pulling the kill switch (status route) with 403", async () => {
    const companyId = await seedCompany();
    const ownerApp = createApp(companyId, "owner");
    const created = await request(ownerApp).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
    expect(created.status).toBe(201);

    const viewerApp = createApp(companyId, "viewer");
    const res = await request(viewerApp)
      .post(`/api/companies/${companyId}/trading/strategies/${created.body.id}/status`)
      .send({ status: "running" });

    expect(res.status).toBe(403);
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, created.body.id));
    expect(row?.status).toBe("paused"); // untouched by the refused request
  });

  it.each(["owner", "admin", "operator", "viewer"] as const)("lets any active %s read the strategy list and dashboard", async (membershipRole) => {
    const companyId = await seedCompany();
    const ownerApp = createApp(companyId, "owner");
    const created = await request(ownerApp).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
    expect(created.status).toBe(201);

    const readerApp = createApp(companyId, membershipRole);
    const list = await request(readerApp).get(`/api/companies/${companyId}/trading/strategies`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const dashboard = await request(readerApp).get(`/api/companies/${companyId}/trading/strategies/${created.body.id}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject({ strategyId: created.body.id, status: "paused" });
  });

  it("refuses a board actor from a different company's companyIds with 403, not a data leak", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const ownerApp = createApp(companyId, "owner");
    const created = await request(ownerApp).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
    expect(created.status).toBe(201);

    const outsiderApp = createApp(otherCompanyId, "owner"); // owner of otherCompanyId, not companyId
    const res = await request(outsiderApp).get(`/api/companies/${companyId}/trading/strategies`);
    expect(res.status).toBe(403);
  });

  // ─── DUR-5002: rules change only as a draft plus a card ──────────────────

  const specBody = {
    spec: {
      specVersion: 2,
      meta: { name: "Test strategy", family: "trend", thesis: "A crossover with a stop." },
      universe: { assets: ["BTC"], decisionTimeframe: "4h" },
      indicators: { fast: { kind: "sma", period: 5 }, slow: { kind: "sma", period: 20 } },
      entry: { conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_above", right: { ref: "slow" } }] } },
      exit: { stop: { kind: "pct", pct: 4 } },
      sizing: { kind: "fraction_of_cash", fraction: 0.1 },
      neverDo: { maxPositionNok: 500 },
      prediction: { horizonBars: 6, kind: "direction", flatBandPct: 0.25, rUnit: "stop_distance" },
    },
    guidelines: "Stay calm.",
  };

  async function createStrategyAs(companyId: string) {
    const created = await request(createApp(companyId, "owner")).post(`/api/companies/${companyId}/trading/strategies`).send({ ...strategyBody, timeframe: "4h" });
    expect(created.status).toBe(201);
    return created.body as { id: string; ruleConfig: unknown; riskConfig: unknown; activeVersionId: string };
  }

  it.each(["owner", "admin"] as const)("an %s's PATCH with a rule change files a draft and a card (202) and changes nothing live", async (membershipRole) => {
    const companyId = await seedCompany();
    const strategy = await createStrategyAs(companyId);
    const app = createApp(companyId, membershipRole);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/trading/strategies/${strategy.id}`)
      .send({ name: "Renamed", ruleConfig: { ...DEFAULT_TRADING_RULE_CONFIG, fastPeriod: 4, slowPeriod: 12 } });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ name: "Renamed", activeVersionId: strategy.activeVersionId, pendingVersion: { outcome: "drafted", versionNumber: 2 } });
    expect(res.body.ruleConfig).toEqual(strategy.ruleConfig);
    expect(res.body.riskConfig).toEqual(strategy.riskConfig);
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategy.id));
    expect(row!.ruleConfig).toEqual(DEFAULT_TRADING_RULE_CONFIG);
    const [card] = await db.select().from(approvals).where(eq(approvals.id, res.body.pendingVersion.approvalId));
    expect(card).toMatchObject({ status: "pending", companyId });
    expect(card!.payload).toMatchObject({ kind: "trading_strategy_version" });
  });

  it("a PATCH that only renames is still direct (200)", async () => {
    const companyId = await seedCompany();
    const strategy = await createStrategyAs(companyId);
    const res = await request(createApp(companyId, "owner")).patch(`/api/companies/${companyId}/trading/strategies/${strategy.id}`).send({ name: "Just a name", checkEveryMinutes: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Just a name", checkEveryMinutes: 30 });
    expect(res.body.pendingVersion).toBeUndefined();
    expect(await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, strategy.id))).toHaveLength(1);
  });

  it.each(["operator", "viewer"] as const)("refuses a %s changing the rules (PATCH or a new version) with 403 and stores nothing", async (membershipRole) => {
    const companyId = await seedCompany();
    const strategy = await createStrategyAs(companyId);
    const app = createApp(companyId, membershipRole);
    const patch = await request(app).patch(`/api/companies/${companyId}/trading/strategies/${strategy.id}`).send({ riskConfig: { ...DEFAULT_TRADING_RISK_CONFIG, maxPositionNok: 100 } });
    const post = await request(app).post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`).send(specBody);
    expect(patch.status).toBe(403);
    expect(post.status).toBe(403);
    expect(await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, strategy.id))).toHaveLength(1);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toHaveLength(0);
  });

  it("an owner proposes a rule book (202); every member can read the versions and the stored source of the card", async () => {
    const companyId = await seedCompany();
    const strategy = await createStrategyAs(companyId);
    const proposed = await request(createApp(companyId, "owner")).post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`).send(specBody);
    expect(proposed.status).toBe(202);
    expect(proposed.body).toMatchObject({ outcome: "drafted", version: { version: 2, status: "draft", proposedByType: "user" } });

    const viewer = createApp(companyId, "viewer");
    const list = await request(viewer).get(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`);
    expect(list.status).toBe(200);
    expect(list.body.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, "draft"], [1, "approved"]]);
    const one = await request(viewer).get(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions/${proposed.body.version.id}`);
    expect(one.status).toBe(200);
    expect(one.body.guidelines).toBe("Stay calm.");
    const source = await request(viewer).get(`/api/companies/${companyId}/trading/approval-cards/${proposed.body.approvalId}/source`);
    expect(source.status).toBe(200);
    expect(source.body).toMatchObject({ matchesCard: true, storedRulesMatchDigest: true, versionNumber: 2 });

    // the same rules again are not a new draft
    const again = await request(createApp(companyId, "owner")).post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`).send(specBody);
    expect(again.body.outcome).toBe("already_pending");
  });

  it("refuses unknown fields and rules that are not valid with 400, and another company's strategy with 403/404", async () => {
    const companyId = await seedCompany();
    const other = await seedCompany();
    const strategy = await createStrategyAs(companyId);
    const app = createApp(companyId, "owner");
    const unknown = await request(app).post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`).send({ ...specBody, secret: 1 });
    const loose = await request(app)
      .post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`)
      .send({ ...specBody, spec: { ...specBody.spec, neverDo: { maxPositionNok: 999_999 } } });
    expect(unknown.status).toBe(400);
    expect(loose.status).toBe(400);
    const outsider = await request(createApp(other, "owner")).post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/versions`).send(specBody);
    expect(outsider.status).toBe(403);
    // an owner of the other company asking under their own company id cannot reach it either
    const crossed = await request(createApp(other, "owner")).post(`/api/companies/${other}/trading/strategies/${strategy.id}/versions`).send(specBody);
    expect(crossed.status).toBe(404);
    expect(await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, strategy.id))).toHaveLength(1);
  });
  it("DUR-5010: any member reads the scoreboard (collecting, no hit rate), another company cannot, a bad version is a 400", async () => {
    const companyId = await seedCompany();
    const other = await seedCompany();
    const strategy = await createStrategyAs(companyId);
    const viewer = createApp(companyId, "viewer");
    const board = await request(viewer).get(`/api/companies/${companyId}/trading/strategies/${strategy.id}/scoreboard`);
    expect(board.status).toBe(200);
    expect(board.body).toMatchObject({ strategyId: strategy.id, version: 1, status: { status: "collecting", samples: 0, targetSamples: 620 }, verdict: null, forecasters: [] });
    expect((await request(viewer).get(`/api/companies/${companyId}/trading/strategies/${strategy.id}/scoreboard?version=0`)).status).toBe(400);
    expect((await request(createApp(other, "owner")).get(`/api/companies/${companyId}/trading/strategies/${strategy.id}/scoreboard`)).status).toBe(403);
    expect((await request(createApp(other, "owner")).get(`/api/companies/${other}/trading/strategies/${strategy.id}/scoreboard`)).status).toBe(404);
  });

  describe("the start gate and past-data tests (DUR-5008)", () => {
    async function newStrategyAs(companyId: string) {
      const created = await request(createApp(companyId, "owner")).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
      expect(created.status).toBe(201);
      return created.body as { id: string };
    }
    const reason = "Paper money only; I watched these rules by hand for a week.";

    it.each(["owner", "admin"] as const)("an %s cannot start a brand-new version without the past-data test: 422, still paused", async (role) => {
      const companyId = await seedCompany();
      const strategy = await newStrategyAs(companyId);
      const res = await request(createApp(companyId, role)).post(`/api/companies/${companyId}/trading/strategies/${strategy.id}/status`).send({ status: "running" });
      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({ code: "trading_start_gate_not_passed" });
      const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategy.id));
      expect(row?.status).toBe("paused");
    });

    it("only an owner can start it with a written reason; an admin is refused with 403 and nothing is written", async () => {
      const companyId = await seedCompany();
      const strategy = await newStrategyAs(companyId);
      const url = `/api/companies/${companyId}/trading/strategies/${strategy.id}/status`;
      const asAdmin = await request(createApp(companyId, "admin")).post(url).send({ status: "running", overrideReason: reason });
      expect(asAdmin.status).toBe(403);
      expect((await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategy.id)))[0]?.status).toBe("paused");
      const asOwner = await request(createApp(companyId, "owner")).post(url).send({ status: "running", overrideReason: reason });
      expect(asOwner.status).toBe(200);
      expect(asOwner.body.status).toBe("running");
      const state = await request(createApp(companyId, "viewer")).get(`/api/companies/${companyId}/trading/strategies/${strategy.id}/start-gate`);
      expect(state.status).toBe(200);
      expect(state.body).toMatchObject({ cleared: true, basis: "override", overrides: [{ reason }] });
    });

    it("a reason that is too short, or sent with 'paused', is a 400", async () => {
      const companyId = await seedCompany();
      const strategy = await newStrategyAs(companyId);
      const url = `/api/companies/${companyId}/trading/strategies/${strategy.id}/status`;
      expect((await request(createApp(companyId, "owner")).post(url).send({ status: "running", overrideReason: "ok" })).status).toBe(400);
      expect((await request(createApp(companyId, "owner")).post(url).send({ status: "paused", overrideReason: reason })).status).toBe(400);
    });

    it("pausing is never gated", async () => {
      const companyId = await seedCompany();
      const strategy = await newStrategyAs(companyId);
      const url = `/api/companies/${companyId}/trading/strategies/${strategy.id}/status`;
      await request(createApp(companyId, "owner")).post(url).send({ status: "running", overrideReason: reason });
      const paused = await request(createApp(companyId, "admin")).post(url).send({ status: "paused" });
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe("paused");
    });

    it("an admin can queue a past-data test (202); a viewer cannot; every member can read it; a second one for the same version is a 409", async () => {
      const companyId = await seedCompany();
      const strategy = await newStrategyAs(companyId);
      const base = `/api/companies/${companyId}/trading/strategies/${strategy.id}/backtests`;
      expect((await request(createApp(companyId, "viewer")).post(base).send({})).status).toBe(403);
      const queued = await request(createApp(companyId, "admin")).post(base).send({ purpose: "gate" });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ status: "queued", purpose: "gate" });
      expect((await request(createApp(companyId, "admin")).post(base).send({})).status).toBe(409);
      const list = await request(createApp(companyId, "viewer")).get(base);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      const one = await request(createApp(companyId, "viewer")).get(`${base}/${queued.body.id}`);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ id: queued.body.id, status: "queued", gatePassed: null });
      expect((await request(createApp(companyId, "admin")).post(`${base}/${queued.body.id}/cancel`)).body.status).toBe("cancelled");
    });

    it("refuses what the request must not choose (unknown fields, a gate run that re-tunes) and another company's strategy", async () => {
      const companyId = await seedCompany();
      const other = await seedCompany();
      const strategy = await newStrategyAs(companyId);
      const base = `/api/companies/${companyId}/trading/strategies/${strategy.id}/backtests`;
      expect((await request(createApp(companyId, "owner")).post(base).send({ costs: { feeRatePct: 0 } })).status).toBe(400);
      expect((await request(createApp(companyId, "owner")).post(base).send({ asOf: "2020-01-01T00:00:00Z" })).status).toBe(400);
      expect((await request(createApp(companyId, "owner")).post(base).send({ purpose: "gate", selection: "best_in_sample" })).status).toBe(422);
      expect((await request(createApp(other, "owner")).post(base).send({})).status).toBe(403);
      expect((await request(createApp(other, "owner")).post(`/api/companies/${other}/trading/strategies/${strategy.id}/backtests`).send({})).status).toBe(404);
      expect((await request(createApp(other, "owner")).get(`/api/companies/${other}/trading/strategies/${strategy.id}/start-gate`)).status).toBe(404);
    });
  });
});
