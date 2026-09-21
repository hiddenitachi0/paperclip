import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  dataConnections,
  dataDatasetSources,
  dataReadEvents,
  instanceSettings,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  agreement,
  createFakeShopify,
  fakeShopifySchemaViolations,
  order,
  placedOrder,
  product,
  productSale,
  refund,
  type FakeOrder,
} from "./helpers/fake-shopify.js";
import { errorHandler } from "../middleware/error-handler.js";
import { dataConnectionRoutes } from "../routes/data-connections.js";
import { resetShopifyTokenCache } from "../services/data-sources/shopify-client.js";
import { describeReconciliationWarnings, TRIAL_PER_MINUTE_LIMIT, zonedDayStart } from "../services/data-trial.js";

/**
 * DUR-3972 slice S2: the "Datakilder" settings screen's server side.
 *
 *  - Only the company's owner or an instance admin may use any Datakilder
 *    route. Company members with another role, agents, and people from
 *    another company are refused with a plain sentence.
 *  - "Prøveberegning" (trial calculation) counts units sold through the
 *    company's own connection with the S3 engine, writes one audit row per
 *    run (refusals included), and never shows a number it could not verify.
 *  - Another company's connection is "not found", and its shop gets zero
 *    requests.
 *
 * Real Postgres with every migration applied; Shopify is the S3 fake, whose
 * every response is checked against the committed Admin 2026-07 schema.
 * "Now" is Monday 21 September 2026, 10:14 in Oslo.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3972 Datakilder screen tests: ${support.reason ?? "unsupported environment"}`);
}

const KEY = "shp" + "at_s2scr33nK3yN0rdstrand0123456789"; // not a real credential
const NOW = Date.parse("2026-09-21T08:14:00.000Z");
const SHOP = "demo-butikk.myshopify.com";

d("DUR-3972 S2 Datakilder routes", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur3972-s2-${randomUUID()}`);
  let clock = NOW;

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur3972-datakilder-screen");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    clock = NOW;
    resetShopifyTokenCache();
    await setFlag(true);
  });

  afterEach(async () => {
    const violations = fakeShopifySchemaViolations.splice(0);
    expect(violations).toEqual([]);
    await db.delete(dataReadEvents);
    await db.delete(dataDatasetSources);
    await db.delete(dataConnections);
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setFlag(enabled: boolean) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { enableBusinessData: enabled },
    });
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  const memberActor = (companyId: string, membershipRole: string, userId = `user-${membershipRole}`) => ({
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole }],
  });
  const ownerActor = (companyId: string) => memberActor(companyId, "owner", "owner-user");
  // An instance admin still needs access to the company (as on every company
  // route); here as a plain operator member, so only the admin flag lets it in.
  const instanceAdminActor = (companyId: string) => ({
    type: "board",
    source: "session",
    userId: "instance-admin",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "operator" }],
  });
  const agentActor = (companyId: string) => ({
    type: "agent",
    agentId: randomUUID(),
    companyId,
    source: "agent_key",
    runId: null,
  });

  function createApp(actor: Record<string, unknown>, fetchImpl?: typeof fetch) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use(
      "/api",
      dataConnectionRoutes(db, {
        fetchImpl,
        now: () => clock,
        sleep: async () => undefined,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  const SOFA = product("Sofa");
  const HJORNESOFA = product("Hjørnesofa");

  /** July: 3 sofas + 1 corner sofa sold. August: 2 sofas sold, 1 July sofa returned. */
  function nordstrandOrders(): FakeOrder[] {
    const july = placedOrder("2026-07-10T10:00:00Z", [[SOFA, 3], [HJORNESOFA, 1]]);
    const august = placedOrder("2026-08-05T10:00:00Z", [[SOFA, 2]]);
    const returnedLine = july.sales[0]!.lineItemId!;
    return [
      order({ createdAt: "2024-03-02T09:15:00Z", agreements: [placedOrder("2024-03-02T09:15:00Z", [[SOFA, 1]]).agreement] }),
      order({
        createdAt: "2026-07-10T10:00:00Z",
        agreements: [
          july.agreement,
          agreement("RefundAgreement", "2026-08-12T09:00:00Z", [productSale("RETURN", -1, SOFA, returnedLine)]),
        ],
        refunds: [refund("2026-08-12T09:00:00Z", [{ quantity: 1, lineItemId: returnedLine, product: SOFA }])],
      }),
      order({ createdAt: "2026-08-05T10:00:00Z", agreements: [august.agreement] }),
    ];
  }

  async function connectActive(companyId: string, fetchImpl: typeof fetch, extra: Partial<typeof dataConnections.$inferInsert> = {}) {
    const app = createApp(ownerActor(companyId), fetchImpl);
    const created = await request(app)
      .post(`/api/companies/${companyId}/data-connections`)
      .send({ kind: "shopify", name: "Nettbutikken", shopDomain: SHOP, credential: { kind: "admin_access_token", accessToken: KEY } });
    expect(created.status).toBe(201);
    // Stands in for a passed Test (covered by the S1 suite): what Test stores when the key is read-only.
    await db
      .update(dataConnections)
      .set({
        status: "active",
        lastCheckOk: true,
        lastCheckAt: new Date(clock),
        observed: {
          shopName: "Demo Butikk",
          shopDomain: SHOP,
          ianaTimezone: "Europe/Oslo",
          currencyCode: "NOK",
          grantedScopes: ["read_all_orders", "read_orders", "read_products"],
          earliestVisibleOrderAt: "2024-03-02T09:15:00Z",
          productTypeCoverage: null,
          checkedAt: new Date(clock).toISOString(),
        },
        ...extra,
      })
      .where(eq(dataConnections.id, created.body.id));
    return created.body.id as string;
  }

  describe("who may use Datakilder", () => {
    it("lets the owner and an instance admin in, and refuses every other role with a plain sentence", async () => {
      const companyId = await seedCompany();
      const owner = await request(createApp(ownerActor(companyId))).get(`/api/companies/${companyId}/data-connections`);
      expect(owner.status).toBe(200);
      const admin = await request(createApp(instanceAdminActor(companyId))).get(`/api/companies/${companyId}/data-connections`);
      expect(admin.status).toBe(200);

      for (const role of ["admin", "operator", "viewer", "member"]) {
        const app = createApp(memberActor(companyId, role));
        const attempts = [
          request(app).get(`/api/companies/${companyId}/data-connections`),
          request(app).get(`/api/companies/${companyId}/data-reads`),
          request(app)
            .post(`/api/companies/${companyId}/data-connections`)
            .send({ kind: "shopify", shopDomain: SHOP, credential: { kind: "admin_access_token", accessToken: KEY } }),
          request(app).put(`/api/companies/${companyId}/dataset-sources/sales`).send({ connectionId: null }),
          request(app)
            .post(`/api/companies/${companyId}/data-connections/${randomUUID()}/trial`)
            .send({ periods: ["2026-07"] }),
        ];
        for (const res of await Promise.all(attempts)) {
          expect(res.status, `${role} ${res.req.method} ${res.req.path}`).toBe(403);
          expect(res.body.error).toContain("Bare eieren av selskapet");
        }
      }
      // A refused member stored nothing.
      expect(await db.select().from(dataConnections)).toHaveLength(0);
      expect(await db.select().from(companySecrets)).toHaveLength(0);
    });

    it("refuses an agent of the company, and the owner of another company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const agent = await request(createApp(agentActor(companyA))).get(`/api/companies/${companyA}/data-connections`);
      expect(agent.status).toBe(403);
      const otherOwner = await request(createApp(ownerActor(companyB))).get(`/api/companies/${companyA}/data-connections`);
      expect(otherOwner.status).toBe(403);
      const agentTrial = await request(createApp(agentActor(companyA)))
        .post(`/api/companies/${companyA}/data-connections/${randomUUID()}/trial`)
        .send({ periods: ["2026-07"] });
      expect(agentTrial.status).toBe(403);
    });

    it("the owner's membership must be active", async () => {
      const companyId = await seedCompany();
      const suspended = {
        ...ownerActor(companyId),
        memberships: [{ companyId, status: "suspended", membershipRole: "owner" }],
      };
      const res = await request(createApp(suspended)).get(`/api/companies/${companyId}/data-connections`);
      expect(res.status).toBe(403);
    });
  });

  describe("Prøveberegning (trial calculation)", () => {
    it("counts July and August through the company's own shop, with three lines per month, and audits it", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ name: "Demo Butikk", domain: SHOP, orders: nordstrandOrders(), products: [SOFA, HJORNESOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl);

      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07", "2026-08"], groupBy: "product_type" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const card = res.body.card as string;
      expect(card).toContain("Juli 2026 (1.–31. juli 2026, avsluttet)");
      expect(card).toContain("August 2026 (1.–31. august 2026, avsluttet)");
      // July: 4 sold, no returns. August: 2 sold, 1 return of a July order, net 1.
      expect(card).toContain("Solgt: 4 stk");
      expect(card).toContain("Solgt: 2 stk");
      expect(card).toContain("Returer i måneden: 1 stk (herav 1 fra tidligere måneder)");
      expect(card).toContain("Netto: 1 stk");
      expect(card).toContain("Sofa:");
      expect(card).toContain(`Kilde: Shopify (nettbutikken ${SHOP}), ikke regnskap`);
      expect(card).toContain(`oppslag ${res.body.lookupId}`);
      expect(res.body.reconciliationNotes).toEqual([]);

      // The key went to Shopify in the header, and nowhere back to the browser.
      expect(shop.requests.length).toBeGreaterThan(0);
      expect(shop.requests.every((entry) => entry.headers["x-shopify-access-token"] === KEY)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain(KEY);

      const [audit] = await db.select().from(dataReadEvents).where(eq(dataReadEvents.id, res.body.lookupId));
      expect(audit).toMatchObject({
        companyId,
        connectionId,
        dataset: "sales",
        channel: "settings_test",
        userId: "owner-user",
        agentId: null,
        outcome: "ok",
        refusalCode: null,
      });
      expect(audit!.params).toEqual({ action: "sales", periods: ["2026-07", "2026-08"], groupBy: "product_type", measure: ["units"] });
      expect(JSON.stringify(audit)).not.toContain(KEY);

      const activity = await db.select().from(activityLog).where(eq(activityLog.action, "data_connection.trial_calculated"));
      expect(activity).toHaveLength(1);
      expect(JSON.stringify(activity)).not.toContain(KEY);

      // The screen's lookup list shows it.
      const reads = await request(createApp(ownerActor(companyId))).get(`/api/companies/${companyId}/data-reads`);
      expect(reads.body[0]).toMatchObject({ id: res.body.lookupId, channel: "settings_test", outcome: "ok" });
    });

    it("says in plain words when Shopify's refunds disagree with its sales record", async () => {
      const companyId = await seedCompany();
      const july = placedOrder("2026-07-10T10:00:00Z", [[SOFA, 2]]);
      // A RETURN in the sales record with no matching refund line.
      const orders = [
        order({ createdAt: "2024-03-02T09:15:00Z", agreements: [placedOrder("2024-03-02T09:15:00Z", [[SOFA, 1]]).agreement] }),
        order({
          createdAt: "2026-07-10T10:00:00Z",
          agreements: [
            july.agreement,
            agreement("RefundAgreement", "2026-07-20T09:00:00Z", [productSale("RETURN", -1, SOFA, july.sales[0]!.lineItemId)]),
          ],
        }),
      ];
      const shop = createFakeShopify({ domain: SHOP, orders, products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.body.ok).toBe(true);
      expect(res.body.reconciliationNotes.join(" ")).toContain("juli 2026");
      expect(res.body.reconciliationNotes.join(" ")).toContain("Shopifys salgslogg viser 1 returnerte stk, men refusjonene viser 0 stk");
      expect(res.body.reconciliationNotes.join(" ")).not.toMatch(/refunds_cross_check|ledger/);
    });

    it("refuses before asking Shopify when the connection has not passed Test, and audits the refusal", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl, { status: "draft", lastCheckOk: null });
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, code: "data_connection_not_active" });
      expect(res.body.message).toContain("Trykk Test først");
      expect(res.body.card).toBeUndefined();
      expect(shop.requests).toHaveLength(0);
      const rows = await db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "refused", refusalCode: "data_connection_not_active", channel: "settings_test" });
    });

    it("refuses a month before the oldest order Shopify shows, instead of showing zero", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA], visibleFrom: "2026-07-01T00:00:00Z" });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-05", "2026-06"] });
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe("before_visible_window");
      expect(res.body.card).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/Solgt|Netto/);
      const [row] = await db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyId));
      expect(row).toMatchObject({ outcome: "refused", refusalCode: "before_visible_window" });
    });

    it("shows a future month as no data, never as zero", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-11"] });
      expect(res.body.ok).toBe(true);
      expect(res.body.card).toContain("Ingen data");
      expect(res.body.card).toContain("ikke det samme som 0");
      expect(res.body.card).not.toContain("Solgt: 0");
      const [row] = await db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyId));
      expect(row!.outcome).toBe("no_data");
    });

    it("gives no numbers when Shopify keeps throttling, and says so plainly", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({
        domain: SHOP,
        orders: nordstrandOrders(),
        products: [SOFA],
        throttleOnRequests: Array.from({ length: 80 }, (_, index) => index + 1),
      });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.body.ok).toBe(false);
      expect(res.body.card).toBeUndefined();
      expect(typeof res.body.message).toBe("string");
      expect(res.body.message.length).toBeGreaterThan(10);
      const [row] = await db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyId));
      expect(row!.outcome).toBe("upstream_error");
    });

    it("stops a burst of trial runs, counted from the audit table", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      await db.insert(dataReadEvents).values(
        Array.from({ length: TRIAL_PER_MINUTE_LIMIT }, () => ({
          companyId,
          connectionId,
          dataset: "sales",
          channel: "settings_test",
          params: {},
          outcome: "ok",
          createdAt: new Date(clock - 10_000),
        })),
      );
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.body).toMatchObject({ ok: false, code: "rate_limited_minute" });
      expect(res.body.message).toContain("Vent et minutt");
      expect(shop.requests).toHaveLength(0);
    });

    it("respects the company's daily cap and names who can raise it", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl, { dailyLookupCap: 2 });
      // Two lookups earlier today (Oslo), outside the per-minute window.
      await db.insert(dataReadEvents).values(
        [1, 2].map(() => ({
          companyId,
          connectionId,
          dataset: "sales",
          channel: "quick_chat",
          params: {},
          outcome: "ok",
          createdAt: new Date(clock - 2 * 60 * 60_000),
        })),
      );
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.body).toMatchObject({ ok: false, code: "rate_limited_day" });
      expect(res.body.message).toContain("Eieren av selskapet kan øke grensen");
      expect(shop.requests).toHaveLength(0);
    });

    it("never reaches another company's shop: its connection is simply not found", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const shopA = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const shopB = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      await connectActive(companyA, shopA.fetchImpl);
      const connectionB = await connectActive(companyB, shopB.fetchImpl);

      const res = await request(createApp(ownerActor(companyA), shopB.fetchImpl))
        .post(`/api/companies/${companyA}/data-connections/${connectionB}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.status).toBe(404);
      expect(shopB.requests).toHaveLength(0);
      expect(await db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyB))).toHaveLength(0);
    });

    it("accepts only one or two calendar months, nothing else", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      const app = createApp(ownerActor(companyId), shop.fetchImpl);
      const url = `/api/companies/${companyId}/data-connections/${connectionId}/trial`;
      for (const body of [
        { periods: [] },
        { periods: ["2026-06", "2026-07", "2026-08"] },
        { periods: ["last_month"] },
        { periods: ["2026-07-01"] },
        { periods: ["2026-13"] },
        { periods: ["2026-07"], shopDomain: "other.myshopify.com" },
        { periods: ["2026-07"], measure: ["kroner"] },
        { periods: ["2026-07"], companyId: randomUUID() },
      ]) {
        const res = await request(app).post(url).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(shop.requests).toHaveLength(0);
    });

    it("is off, like the rest of Datakilder, until the instance switch is on", async () => {
      const companyId = await seedCompany();
      const shop = createFakeShopify({ domain: SHOP, orders: nordstrandOrders(), products: [SOFA] });
      const connectionId = await connectActive(companyId, shop.fetchImpl);
      await setFlag(false);
      const res = await request(createApp(ownerActor(companyId), shop.fetchImpl))
        .post(`/api/companies/${companyId}/data-connections/${connectionId}/trial`)
        .send({ periods: ["2026-07"] });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("business_data_disabled");
      expect(shop.requests).toHaveLength(0);
    });
  });
});

describe("DUR-3972 S2 trial helpers", () => {
  it("finds midnight in Oslo, across summer and winter time", () => {
    expect(zonedDayStart(new Date("2026-09-21T08:14:00Z"), "Europe/Oslo").toISOString()).toBe("2026-09-20T22:00:00.000Z");
    expect(zonedDayStart(new Date("2026-01-15T23:30:00Z"), "Europe/Oslo").toISOString()).toBe("2026-01-15T23:00:00.000Z");
    // The day summer time starts (29 March 2026): midnight was still winter time.
    expect(zonedDayStart(new Date("2026-03-29T12:00:00Z"), "Europe/Oslo").toISOString()).toBe("2026-03-28T23:00:00.000Z");
  });

  it("turns the engine's log warnings into plain Norwegian, and counts the rest", () => {
    expect(
      describeReconciliationWarnings([
        "refunds_cross_check 2026-08 Sofa: ledger returns 2, refund lines 1",
        "catalog units sold skipped: request_budget_exceeded",
      ]),
    ).toEqual([
      "august 2026, produkttypen Sofa: Shopifys salgslogg viser 2 returnerte stk, men refusjonene viser 1 stk. Tallene over bruker salgsloggen, som Shopify Analytics. Forskjellen bør forklares før Salg slås på.",
      "1 annen merknad fra beregningen er lagret i loggen.",
    ]);
  });
});
