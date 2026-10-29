import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, companies, createDb, tradingStrategies, tradingStrategyVersions } from "@paperclipai/db";
import { DEFAULT_TRADING_RISK_CONFIG, DEFAULT_TRADING_RULE_CONFIG, TRADING_STRATEGY_VERSION_APPROVAL_KIND } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { fakeTradingMarketData } from "../services/trading-market-data.js";

/**
 * DUR-5002, over real HTTP routes and a real database: PATCH files a draft + card
 * instead of writing; the card can be approved only by a person who is the
 * company's owner/admin, signed in on the approvals page itself (not by the
 * command line, which is what the Telegram buttons use, and not by an agent);
 * nobody can file the card by hand.
 */

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let tradingRoutes: typeof import("../routes/trading.js").tradingRoutes;
let approvalRoutes: typeof import("../routes/approvals.js").approvalRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping trading strategy version route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Source = "session" | "board_key" | "local_implicit";
type Role = "owner" | "admin" | "operator" | "viewer";

describeEmbeddedPostgres("trading strategy version routes (DUR-5002)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trading-version-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    const [trading, approvalsRoutes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/trading.js")>("../routes/trading.js"),
      vi.importActual<typeof import("../routes/approvals.js")>("../routes/approvals.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    tradingRoutes = trading.tradingRoutes;
    approvalRoutes = approvalsRoutes.approvalRoutes;
    errorHandler = middleware.errorHandler;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(companyId: string, actor: { source: Source; role: Role; instanceAdmin?: boolean } | { agent: true }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor =
        "agent" in actor
          ? { type: "agent", source: "agent_key", agentId: randomUUID(), companyId, keyId: randomUUID() }
          : {
              type: "board",
              source: actor.source,
              userId: "owner-user",
              isInstanceAdmin: actor.instanceAdmin === true,
              companyIds: [companyId],
              memberships: [{ companyId, membershipRole: actor.role, status: "active" }],
            };
      next();
    });
    app.use("/api", tradingRoutes(db, { marketData: fakeTradingMarketData({}) }));
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Trading ${companyId.slice(0, 8)}`, issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return companyId;
  }

  const body = { name: "Routed", asset: "BTC", checkEveryMinutes: 15, startingCashNok: 3_000, ruleConfig: DEFAULT_TRADING_RULE_CONFIG, riskConfig: DEFAULT_TRADING_RISK_CONFIG };

  async function strategyWithDraft() {
    const companyId = await seedCompany();
    const owner = appFor(companyId, { source: "session", role: "owner" });
    const created = await request(owner).post(`/api/companies/${companyId}/trading/strategies`).send(body);
    expect(created.status).toBe(201);
    const patched = await request(owner)
      .patch(`/api/companies/${companyId}/trading/strategies/${created.body.id}`)
      .send({ riskConfig: { ...DEFAULT_TRADING_RISK_CONFIG, maxOrdersPerDay: 2 } });
    expect(patched.status).toBe(200);
    return { companyId, strategyId: created.body.id as string, patched: patched.body, owner };
  }

  it("PATCH with a risk change returns the pending draft and leaves the live rules alone", async () => {
    const { strategyId, patched } = await strategyWithDraft();
    expect(patched.pendingVersion).toMatchObject({ version: 2 });
    expect(patched.riskConfig).toMatchObject({ maxOrdersPerDay: DEFAULT_TRADING_RISK_CONFIG.maxOrdersPerDay });
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.riskConfig).toMatchObject({ maxOrdersPerDay: DEFAULT_TRADING_RISK_CONFIG.maxOrdersPerDay });
  });

  it("PATCH refuses unknown fields and a rule book that loosens past the ceiling", async () => {
    const companyId = await seedCompany();
    const owner = appFor(companyId, { source: "session", role: "owner" });
    const created = await request(owner).post(`/api/companies/${companyId}/trading/strategies`).send(body);
    const url = `/api/companies/${companyId}/trading/strategies/${created.body.id}`;
    expect((await request(owner).patch(url).send({ status: "running" })).status).toBe(400);
    expect((await request(owner).patch(url).send({ riskConfig: { ...DEFAULT_TRADING_RISK_CONFIG, maxPositionNok: 999_999 } })).status).toBe(400);
    expect((await request(owner).patch(url).send({ document: { specVersion: 2, guidelines: "x", surprise: true } })).status).toBe(400);
  });

  it("an owner signed in on the approvals page can approve the card, which activates exactly that draft", async () => {
    const { companyId, strategyId, patched, owner } = await strategyWithDraft();
    const res = await request(owner).post(`/api/approvals/${patched.pendingVersion.approvalId}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.activeVersionId).toBe(patched.pendingVersion.versionId);
    expect(row!.riskConfig).toMatchObject({ maxOrdersPerDay: 2 });
    const versions = await request(owner).get(`/api/companies/${companyId}/trading/strategies/${strategyId}/versions`);
    expect(versions.body.map((v: any) => [v.version, v.status])).toEqual([[2, "approved"], [1, "superseded"]]);
  });

  it.each([
    ["an admin", { source: "session", role: "admin" } as const, 200],
    ["an operator", { source: "session", role: "operator" } as const, 403],
    ["a viewer", { source: "session", role: "viewer" } as const, 403],
    ["the command line (Telegram's Approve button)", { source: "board_key", role: "owner" } as const, 403],
    ["an agent", { agent: true } as const, 403],
  ])("%s approving the card gets %i", async (_label, actor, status) => {
    const { companyId, strategyId, patched } = await strategyWithDraft();
    const res = await request(appFor(companyId, actor)).post(`/api/approvals/${patched.pendingVersion.approvalId}/approve`).send({});
    expect(res.status).toBe(status);
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.activeVersionId === patched.pendingVersion.versionId).toBe(status === 200);
    const [card] = await db.select().from(approvals).where(eq(approvals.id, patched.pendingVersion.approvalId));
    expect(card!.status).toBe(status === 200 ? "approved" : "pending");
  });

  it("another company's owner cannot approve it", async () => {
    const { patched, strategyId } = await strategyWithDraft();
    const otherCompany = await seedCompany();
    const res = await request(appFor(otherCompany, { source: "session", role: "owner" })).post(`/api/approvals/${patched.pendingVersion.approvalId}/approve`).send({});
    expect(res.status).toBe(403);
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.activeVersionId).not.toBe(patched.pendingVersion.versionId);
  });

  it("the card cannot be filed by hand through the approvals API", async () => {
    const { companyId, strategyId } = await strategyWithDraft();
    const [draft] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, strategyId));
    const res = await request(appFor(companyId, { source: "session", role: "owner", instanceAdmin: true }))
      .post(`/api/companies/${companyId}/approvals`)
      .send({ type: "request_board_approval", payload: { kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, strategyVersionId: draft!.id, cardText: "harmless" } });
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 422 });
    expect(res.body.code).toBe("trading_strategy_version_card_filed_elsewhere");
  });
});
