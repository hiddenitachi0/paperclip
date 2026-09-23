import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  createDb,
  dataConnections,
  dataReadEvents,
  instanceSettings,
  laneAMessages,
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
import { chatRouterRoutes } from "../routes/chat-router.js";
import { dataConnectionRoutes } from "../routes/data-connections.js";
import { agentService } from "../services/agents.js";
import { dataConnectionService } from "../services/data-connections.js";
import { recordDataReadEvent } from "../services/data-read-audit.js";
import {
  BUSINESS_DATA_LIMITS,
  businessDataService,
  type BusinessDataCaller,
} from "../services/business-data.js";
import { NO_LOOKUP_SENTENCE, NUMBER_CHECK_REPLACEMENT_NOTE } from "../services/business-data-number-check.js";
import { KRONER_NOT_ENABLED_MESSAGE } from "../services/data-sources/contract.js";
import { resetShopifyTokenCache } from "../services/data-sources/shopify-client.js";
import type { LaneAModelClient } from "../services/lane-a.js";

/**
 * DUR-3972 slice S4 acceptance tests: the query service, its limits (counted
 * from data_read_events), the quick-agent tool read_business_data, and the
 * number check -- against a real Postgres with every migration applied, a
 * fake model client (no Anthropic key anywhere) and two fake Shopify shops
 * whose every response is checked against the committed 2026-07 schema.
 *
 * "Now" is Monday 21 September 2026, 10:14 in Oslo, so last_month is August
 * and month_before_last is July.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3972 S4 business-data tests: ${support.reason ?? "unsupported environment"}`);
}

const NOW = new Date("2026-09-21T08:14:00.000Z");
// Not real credentials: fake shop keys in Shopify's token shape.
const KEY_A = "shp" + "at_n0rdstrandS4testk3y000000000000a";
const KEY_B = "shp" + "at_durk4nS4testk3y0000000000000000b";
const SHOP_A = "nordstrand-test.myshopify.com";
const SHOP_B = "durkan-test.myshopify.com";

const SOFA = product("Sofa");
const HJORNESOFA = product("Hjørnesofa");
const SOVESOFA = product("Sovesofa");
const SOFABORD = product("Sofabord");
const LENESTOL = product("Lenestol");
const PRODUCTS = [SOFA, HJORNESOFA, SOVESOFA, SOFABORD, LENESTOL];

function shopAOrders(): FakeOrder[] {
  const julySofa = placedOrder("2026-07-10T10:00:00Z", [[SOFA, 2], [HJORNESOFA, 1]]);
  return [
    order({ createdAt: "2024-11-02T10:00:00Z", agreements: [placedOrder("2024-11-02T10:00:00Z", [[LENESTOL, 1]]).agreement] }),
    order({
      createdAt: "2026-07-10T10:00:00Z",
      agreements: [
        julySofa.agreement,
        // One of July's sofas comes back in August: an August return from an earlier month.
        agreement("RefundAgreement", "2026-08-12T10:00:00Z", [productSale("RETURN", -1, SOFA, julySofa.sales[0]!.lineItemId)]),
      ],
      refunds: [refund("2026-08-12T10:00:00Z", [{ quantity: 1, lineItemId: julySofa.sales[0]!.lineItemId!, product: SOFA }])],
    }),
    order({ createdAt: "2026-07-20T10:00:00Z", agreements: [placedOrder("2026-07-20T10:00:00Z", [[SOFA, 1]]).agreement] }),
    order({ createdAt: "2026-08-05T10:00:00Z", agreements: [placedOrder("2026-08-05T10:00:00Z", [[SOFA, 3]]).agreement] }),
  ];
}
// Sofa: July sold 3, returns 0, net 3. August sold 3, returns 1 (1 earlier), net 2.

function shopBOrders(): FakeOrder[] {
  return [
    order({ createdAt: "2025-01-02T10:00:00Z", agreements: [placedOrder("2025-01-02T10:00:00Z", [[LENESTOL, 7]]).agreement] }),
    order({ createdAt: "2026-08-15T10:00:00Z", agreements: [placedOrder("2026-08-15T10:00:00Z", [[LENESTOL, 4]]).agreement] }),
  ];
}

type ModelStep = (params: { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }>; system?: string }) => unknown;

function scriptedModel(steps: ModelStep[]) {
  const calls: Array<{ tools: string[]; system: string }> = [];
  const create = vi.fn(async (params: Parameters<ModelStep>[0]) => {
    calls.push({ tools: (params.tools ?? []).map((tool) => tool.name), system: String(params.system ?? "") });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`model called ${calls.length} times, only ${steps.length} steps scripted`);
    return step(params);
  });
  return { create, calls, client: () => ({ messages: { create } }) as unknown as LaneAModelClient };
}

let callSeq = 0;
function callTool(input: Record<string, unknown>, name = "read_business_data"): ModelStep {
  return () => ({
    content: [{ type: "tool_use", id: `call_${(callSeq += 1)}`, name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "tool_use",
  });
}

function lastToolOutput(params: Parameters<ModelStep>[0]): string {
  const last = params.messages[params.messages.length - 1]!;
  const blocks = last.content as Array<{ type: string; content?: string }>;
  return blocks.find((block) => block.type === "tool_result")?.content ?? "";
}

function reply(text: string | ((toolOutput: string) => string)): ModelStep {
  return (params) => ({
    content: [{ type: "text", text: typeof text === "function" ? text(lastToolOutput(params)) : text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  });
}

d("DUR-3972 S4: business data for quick agents", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur3972-s4-${randomUUID()}`);
  let shopA!: ReturnType<typeof createFakeShopify>;
  let shopB!: ReturnType<typeof createFakeShopify>;
  let clock = NOW.getTime();

  const routedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    if (host === SHOP_A) return shopA.fetchImpl(input, init);
    if (host === SHOP_B) return shopB.fetchImpl(input, init);
    throw new Error(`unexpected host ${host}`);
  }) as typeof fetch;

  const deps = () => ({ fetchImpl: routedFetch, now: () => clock, sleep: async () => undefined });

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    // The quick-agent path must never need a real (or any) Anthropic key here.
    delete process.env.ANTHROPIC_API_KEY;
    const started = await startEmbeddedPostgresTestDatabase("dur3972-s4-business-data");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    clock = NOW.getTime();
    resetShopifyTokenCache();
    shopA = createFakeShopify({ domain: SHOP_A, name: "Nordstrand Møbler", products: PRODUCTS, orders: shopAOrders() });
    shopB = createFakeShopify({ domain: SHOP_B, name: "Durkan Shop", products: [LENESTOL], orders: shopBOrders() });
    await setFlag(true);
  });

  afterEach(() => {
    const violations = fakeShopifySchemaViolations.splice(0);
    expect(violations).toEqual([]);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
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

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedQuickAgent(companyId: string, name = "Salgsanalytikeren") {
    const created = await agentService(db).create(companyId, {
      name,
      role: "analyst",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    return created;
  }

  async function connectShop(companyId: string, shopDomain: string, key: string) {
    const svc = dataConnectionService(db, deps());
    const created = await svc.create(
      companyId,
      { kind: "shopify", name: "Nettbutikken", shopDomain, credential: { kind: "admin_access_token", accessToken: key } },
      { userId: "board-user" },
    );
    // Stands in for a passed "Test" (covered by S1's tests) -- this slice reads.
    await db.update(dataConnections).set({ status: "active" }).where(eq(dataConnections.id, created.id));
    await svc.setDatasetSource(companyId, "sales", created.id, { userId: "board-user" });
    return created.id;
  }

  function boardActor(companyIds: string[], userId = "filip") {
    return {
      type: "board",
      source: "session",
      userId,
      isInstanceAdmin: false,
      companyIds,
      memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole: "owner" })),
    };
  }

  function chatApp(actor: Record<string, unknown>, model: ReturnType<typeof scriptedModel>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", chatRouterRoutes(db, { laneA: { createModelClient: model.client, businessData: deps() } }));
    app.use(errorHandler);
    return app;
  }

  function caller(companyId: string, agentId: string | null, extra: Partial<BusinessDataCaller> = {}): BusinessDataCaller {
    return { companyId, channel: "quick_chat", agentId, userId: null, runId: null, laneAConversationId: null, ...extra };
  }

  async function auditRows(companyId: string) {
    return db.select().from(dataReadEvents).where(eq(dataReadEvents.companyId, companyId));
  }

  async function dumpDatabase(): Promise<string> {
    const names = Object.values(dbExports)
      .filter((value) => value instanceof PgTable)
      .map((table) => getTableConfig(table as Parameters<typeof getTableConfig>[0]).name);
    const parts: string[] = [];
    for (const name of [...new Set(names)]) {
      const rows = (await db.execute(sql.raw(`SELECT row_to_json(t)::text AS j FROM "${name}" t`))) as unknown as Array<{ j: string }>;
      for (const row of rows) parts.push(`${name}: ${row.j}`);
    }
    return parts.join("\n");
  }

  const SALES_JULY_AUGUST = { action: "sales", periods: ["month_before_last", "last_month"], product_types: ["Sofa"] };

  // ─── End to end ──────────────────────────────────────────────────────────

  it("answers end to end from POST /chat/:agentId/messages: two months, three lines each, dates and source", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const companyB = await seedCompany("Durkan Agency");
    await connectShop(companyB, SHOP_B, KEY_B);

    const model = scriptedModel([callTool(SALES_JULY_AUGUST), reply((card) => card)]);
    const res = await request(chatApp(boardActor([companyA, companyB]), model))
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Hvor mange sofaer solgte vi forrige måned mot måneden før?", laneHint: "a" });

    expect(res.status).toBe(200);
    expect(res.body.lane).toBe("a");
    const answer: string = res.body.result.response;
    expect(answer).toContain("Sales in units for product type: Sofa");
    expect(answer).toContain("July 2026 (1–31 July 2026, closed)");
    expect(answer).toContain("August 2026 (1–31 August 2026, closed)");
    expect(answer.match(/^Sold: /gm)).toHaveLength(2);
    expect(answer.match(/^Returns in the month: /gm)).toHaveLength(2);
    expect(answer.match(/^Net: /gm)).toHaveLength(2);
    expect(answer).toContain("Returns in the month: 1 unit (of which 1 from earlier months)");
    expect(answer).toContain(`Source: Shopify (online store ${SHOP_A}), not the accounts · Europe/Oslo`);
    expect(answer).not.toContain(NUMBER_CHECK_REPLACEMENT_NOTE);

    // The tool was offered, and the prompt carries the data rules.
    expect(model.calls[0]!.tools).toContain("read_business_data");
    expect(model.calls[0]!.system).toContain("Sales data (read_business_data)");

    // One audit row, under A, naming the quick agent and the conversation.
    const rows = await auditRows(companyA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "ok",
      channel: "quick_chat",
      dataset: "sales",
      agentId: analyst.id,
      userId: "filip",
      runId: null,
      laneAConversationId: res.body.result.conversationId,
    });
    expect(answer).toContain(`lookup ${rows[0]!.id}`);
    expect((rows[0]!.facts as { answer: string }).answer).toBe(answer);

    // Isolation: B's shop was never called; A's key went in the header only.
    expect(shopB.requests).toHaveLength(0);
    expect(shopA.requests.length).toBeGreaterThan(0);
    for (const sent of shopA.requests) {
      expect(sent.headers["x-shopify-access-token"]).toBe(KEY_A);
      expect(sent.body.includes(KEY_A)).toBe(false);
      expect(sent.url.startsWith(`https://${SHOP_A}/`)).toBe(true);
    }

    // The key is nowhere in the response or the database (it is stored encrypted).
    const everything = `${JSON.stringify(res.body)}\n${await dumpDatabase()}`;
    for (const key of [KEY_A, KEY_B]) {
      expect(everything.includes(key)).toBe(false);
      expect(everything.includes(key.slice(6, 26))).toBe(false);
    }
  });

  it("answers a follow-up in the same conversation with a fresh lookup", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const model = scriptedModel([
      callTool({ action: "sales", periods: ["last_month"], product_types: ["Sofa"] }),
      reply((card) => card),
      callTool({ action: "sales", periods: ["month_before_last"], product_types: ["Sofa"] }),
      reply((card) => card),
    ]);
    const app = chatApp(boardActor([companyA]), model);
    const first = await request(app)
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Hvor mange sofaer solgte vi forrige måned?", laneHint: "a" });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "og måneden før det?", laneHint: "a", conversationId: first.body.result.conversationId });
    expect(second.status).toBe(200);
    expect(second.body.result.conversationId).toBe(first.body.result.conversationId);
    expect(second.body.result.response).toContain("July 2026 (1–31 July 2026, closed)");
    expect(await auditRows(companyA)).toHaveLength(2);
  });

  // ─── The number check ────────────────────────────────────────────────────

  it("replaces a reply with a number the tool did not return, and logs the guard", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    let card = "";
    const model = scriptedModel([
      callTool(SALES_JULY_AUGUST),
      reply((output) => {
        card = output;
        return "Vi solgte 999 sofaer i august.";
      }),
    ]);
    const res = await request(chatApp(boardActor([companyA]), model))
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Sofaer i juli og august?", laneHint: "a" });
    expect(res.status).toBe(200);
    expect(res.body.result.response).toBe(`${card}\n\n${NUMBER_CHECK_REPLACEMENT_NOTE}`);
    expect(res.body.result.response).not.toContain("999");

    const guard = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyA), eq(activityLog.action, "lane_a.provenance_guard")));
    expect(guard).toHaveLength(1);
    expect((guard[0]!.details as { ungroundedNumbers: string[] }).ungroundedNumbers).toEqual(["999"]);

    // What is remembered for the next turn is the safe text, not the invented number.
    const stored = await db.select().from(laneAMessages).where(eq(laneAMessages.role, "assistant"));
    expect(stored.find((row) => row.companyId === companyA)!.content).toBe(res.body.result.response);
  });

  it("checks a follow-up answered from memory without a new lookup, and logs the guard", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const model = scriptedModel([
      callTool(SALES_JULY_AUGUST),
      reply((card) => card),
      // No tool call: a sum made up from the history.
      reply("Totalt solgte vi 27 stk de to månedene."),
      // A plain follow-up with no figures passes untouched.
      reply("Vil du at jeg slår opp september også?"),
    ]);
    const app = chatApp(boardActor([companyA]), model);
    const first = await request(app)
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Sofaer i juli og august?", laneHint: "a" });
    expect(first.status).toBe(200);
    const conversationId = first.body.result.conversationId;
    const second = await request(app)
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "hvor mange solgte vi totalt de to månedene?", laneHint: "a", conversationId });
    expect(second.status).toBe(200);
    expect(second.body.result.response).toBe(NO_LOOKUP_SENTENCE);
    expect(second.body.result.response).not.toContain("27");
    const third = await request(app)
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "takk", laneHint: "a", conversationId });
    expect(third.body.result.response).toBe("Vil du at jeg slår opp september også?");

    const guard = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyA), eq(activityLog.action, "lane_a.provenance_guard")));
    expect(guard).toHaveLength(1);
    expect((guard[0]!.details as { ungroundedNumbers: string[] }).ungroundedNumbers).toEqual(["27"]);
    // Only the first turn looked anything up.
    expect(await auditRows(companyA)).toHaveLength(1);
  });

  it("checks a first answer given without calling the offered tool", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const model = scriptedModel([reply("Dere solgte 40 sofaer forrige måned.")]);
    const res = await request(chatApp(boardActor([companyA]), model))
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Sofaer forrige måned?", laneHint: "a" });
    expect(res.status).toBe(200);
    expect(model.calls[0]!.tools).toContain("read_business_data");
    expect(res.body.result.response).toBe(NO_LOOKUP_SENTENCE);
  });

  it("replaces a reply with a wrong single digit ('5 returer')", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const model = scriptedModel([callTool(SALES_JULY_AUGUST), reply("I august var det 5 returer.")]);
    const res = await request(chatApp(boardActor([companyA]), model))
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Hvor mange returer i august?", laneHint: "a" });
    expect(res.status).toBe(200);
    expect(res.body.result.response).toContain(NUMBER_CHECK_REPLACEMENT_NOTE);
    expect(res.body.result.response).toContain("Returns in the month: 1 unit (of which 1 from earlier months)");
    expect(res.body.result.response).not.toContain("5 returer");
  });

  it("lets a correct paraphrase through and adds units, periods and source itself", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const text = "Netto 3 sofaer i juli og 2 i august; 1 retur i august var fra juli.";
    const model = scriptedModel([callTool(SALES_JULY_AUGUST), reply(text)]);
    const res = await request(chatApp(boardActor([companyA]), model))
      .post(`/api/chat/${analyst.id}/messages`)
      .send({ companyId: companyA, message: "Sofaer?", laneHint: "a" });
    const answer: string = res.body.result.response;
    expect(answer.startsWith(text)).toBe(true);
    expect(answer).not.toContain(NUMBER_CHECK_REPLACEMENT_NOTE);
    // The sentence before the periods belongs to business-data.ts; the periods are the card's.
    expect(answer).toContain(": July 2026 (1–31 July 2026, closed); August 2026 (1–31 August 2026, closed).");
    const [row] = await auditRows(companyA);
    expect(answer).toContain(`Source: Shopify (online store ${SHOP_A}), not the accounts · Europe/Oslo · fetched 21.09.2026 at 10:14 · lookup ${row!.id}`);
  });

  // ─── Isolation ───────────────────────────────────────────────────────────

  it("the Durkan quick agent is told 'ikke koblet til', is not offered the tool, and the refusal is audited under Durkan", async () => {
    const nordstrand = await seedCompany("Nordstrand Konsernet");
    await connectShop(nordstrand, SHOP_A, KEY_A);
    const durkan = await seedCompany("Durkan Agency");
    const durkanAgent = await seedQuickAgent(durkan, "Durkan Assistent");

    // A model that calls the tool even though it was not offered.
    const model = scriptedModel([callTool({ action: "sales", periods: ["last_month"] }), reply((output) => output)]);
    const res = await request(chatApp(boardActor([nordstrand, durkan]), model))
      .post(`/api/chat/${durkanAgent.id}/messages`)
      .send({ companyId: durkan, message: "Hvor mye solgte vi forrige måned?", laneHint: "a" });
    expect(res.status).toBe(200);
    const sentence = "Durkan Agency har ikke koblet til salgsdata. En styrebruker kan gjøre det under Innstillinger → Datakilder.";
    expect(res.body.result.response).toBe(sentence);
    expect(model.calls[0]!.tools).not.toContain("read_business_data");
    expect(model.calls[0]!.system).toContain(sentence);

    const rows = await auditRows(durkan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "refused", refusalCode: "not_connected", connectionId: null, agentId: durkanAgent.id });
    expect(await auditRows(nordstrand)).toHaveLength(0);
    expect(shopA.requests).toHaveLength(0);
    expect(shopB.requests).toHaveLength(0);
  });

  it("company B's lookups and refusals reach only B's shop and B's audit trail", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const companyB = await seedCompany("Durkan Agency");
    const agentB = await seedQuickAgent(companyB, "Durkan Assistent");
    await connectShop(companyB, SHOP_B, KEY_B);
    const svc = businessDataService(db, deps());

    const a = await svc.read(caller(companyA, agentA.id), SALES_JULY_AUGUST);
    expect(a.ok).toBe(true);
    const aRequests = shopA.requests.length;
    expect(shopB.requests).toHaveLength(0);

    const b = await svc.read(caller(companyB, agentB.id), { action: "sales", periods: ["last_month"] });
    expect(b.ok).toBe(true);
    expect(b.text).toContain(`online store ${SHOP_B}`);
    expect(b.text).toContain("Sold: 4 units");
    const bKroner = await svc.read(caller(companyB, agentB.id), { action: "sales", periods: ["last_month"], measure: ["kroner"] });
    expect(bKroner.ok).toBe(false);

    expect(shopA.requests).toHaveLength(aRequests); // B never touched A's shop
    for (const sent of shopB.requests) expect(sent.headers["x-shopify-access-token"]).toBe(KEY_B);
    const rowsB = await auditRows(companyB);
    expect(rowsB.map((row) => row.outcome).sort()).toEqual(["ok", "refused"]);
    expect(rowsB.every((row) => row.agentId === agentB.id)).toBe(true);
    expect((await auditRows(companyA)).every((row) => row.agentId === agentA.id)).toBe(true);
  });

  it("returns 404 when the chat names an agent from another company", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    await connectShop(companyA, SHOP_A, KEY_A);
    const companyB = await seedCompany("Durkan Agency");
    const agentB = await seedQuickAgent(companyB, "Durkan Assistent");
    const model = scriptedModel([]);
    const res = await request(chatApp(boardActor([companyA, companyB]), model))
      .post(`/api/chat/${agentB.id}/messages`)
      .send({ companyId: companyA, message: "Salg forrige måned?", laneHint: "a" });
    expect(res.status).toBe(404);
    expect(model.create).not.toHaveBeenCalled();
    expect(shopA.requests).toHaveLength(0);
  });

  it("refuses extra input fields (a shop address, a connection id, a company) before any request", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const companyB = await seedCompany("Durkan Agency");
    const connectionB = await connectShop(companyB, SHOP_B, KEY_B);
    const svc = businessDataService(db, deps());
    for (const extra of [{ shop_domain: SHOP_B }, { connection_id: connectionB }, { company_id: companyB }]) {
      const answer = await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"], ...extra });
      expect(answer).toMatchObject({ ok: false, outcome: "refused", refusalCode: "invalid_request" });
      expect(answer.text).toContain("felter verktøyet ikke tar imot");
    }
    expect(shopA.requests).toHaveLength(0);
    expect(shopB.requests).toHaveLength(0);
    const rows = await auditRows(companyA);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => (row.params as { rejectedFields: string[] }).rejectedFields).sort()).toEqual([
      ["company_id"],
      ["connection_id"],
      ["shop_domain"],
    ]);
    // The rejected values themselves are not stored.
    expect(JSON.stringify(rows)).not.toContain(connectionB);
  });

  // ─── Limits (counted from data_read_events) ──────────────────────────────

  it("refuses the 7th lookup in a minute for one agent, with a plain sentence", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const svc = businessDataService(db, deps());
    for (let i = 0; i < BUSINESS_DATA_LIMITS.perAgentPerMinute; i += 1) {
      clock += 1_000;
      expect((await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] })).ok).toBe(true);
    }
    clock += 1_000;
    const requestsBefore = shopA.requests.length;
    const seventh = await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] });
    expect(seventh).toMatchObject({ ok: false, outcome: "rate_limited", refusalCode: "agent_minute_limit" });
    expect(seventh.text).toBe(
      "Jeg har gjort 6 oppslag i salgsdata det siste minuttet, som er grensen per agent. Vent et minutt og spør igjen. " +
        "Grensen er fast i Paperclip og kan bare endres av den som drifter Paperclip.",
    );
    expect(shopA.requests).toHaveLength(requestsBefore);

    // A new service instance (a restart) sees the same count: it lives in the database.
    const afterRestart = await businessDataService(db, deps()).read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] });
    expect(afterRestart.refusalCode).toBe("agent_minute_limit");

    // A minute later the agent may look again.
    clock += 61_000;
    expect((await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] })).ok).toBe(true);
  });

  it("refuses the 21st lookup in a minute for the company, across agents", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const connectionId = await connectShop(companyA, SHOP_A, KEY_A);
    const others = await Promise.all([1, 2, 3, 4].map((n) => seedQuickAgent(companyA, `Agent ${n}`)));
    for (let i = 0; i < BUSINESS_DATA_LIMITS.perCompanyPerMinute; i += 1) {
      await recordDataReadEvent(db, {
        companyId: companyA, connectionId, dataset: "sales", channel: "quick_chat",
        agentId: others[i % 4]!.id, outcome: "ok", createdAt: new Date(clock - 30_000),
      });
    }
    const fresh = await seedQuickAgent(companyA, "Ny agent");
    const answer = await businessDataService(db, deps()).read(caller(companyA, fresh.id), { action: "sales", periods: ["last_month"] });
    expect(answer).toMatchObject({ ok: false, outcome: "rate_limited", refusalCode: "company_minute_limit" });
    expect(answer.text).toContain("Nordstrand Konsernet har gjort 20 oppslag i salgsdata det siste minuttet");
    expect(shopA.requests).toHaveLength(0);
  });

  it("refuses the 301st lookup in an Oslo day, and yesterday's lookups do not count", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    const connectionId = await connectShop(companyA, SHOP_A, KEY_A);
    const insertMany = async (count: number, createdAt: Date) => {
      for (let i = 0; i < count; i += 1) {
        await recordDataReadEvent(db, { companyId: companyA, connectionId, dataset: "sales", channel: "quick_chat", outcome: "ok", createdAt });
      }
    };
    // 21:59 UTC on 20 Sep is 23:59 in Oslo: yesterday.
    await insertMany(300, new Date("2026-09-20T21:59:00Z"));
    const svc = businessDataService(db, deps());
    expect((await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] })).ok).toBe(true);

    // 22:30 UTC on 20 Sep is 00:30 in Oslo on the 21st: today.
    await insertMany(299, new Date("2026-09-20T22:30:00Z"));
    const answer = await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] });
    expect(answer).toMatchObject({ ok: false, outcome: "rate_limited", refusalCode: "daily_cap" });
    expect(answer.text).toBe(
      "Nordstrand Konsernet har brukt alle 300 oppslag i salgsdata for i dag, som er den daglige grensen. " +
        "Grensen nullstilles ved midnatt (norsk tid). En styrebruker kan heve den under Innstillinger → Datakilder.",
    );

    // The cap is the company's own setting.
    await db.update(dataConnections).set({ dailyLookupCap: 400 }).where(eq(dataConnections.id, connectionId));
    expect((await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] })).ok).toBe(true);
  });

  it("stops a run at 15 lookups, keyed on the signed run id only", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const analyst = await seedQuickAgent(companyA);
    const requester = await seedQuickAgent(companyA, "Rapportskriver");
    const connectionId = await connectShop(companyA, SHOP_A, KEY_A);
    const runId = randomUUID();

    // Through the chat router: a signed agent token's run is recorded...
    const signed = scriptedModel([callTool({ action: "sales", periods: ["last_month"] }), reply((card) => card)]);
    const jwtActor = { type: "agent", agentId: requester.id, companyId: companyA, source: "agent_jwt", runId };
    expect(
      (await request(chatApp(jwtActor, signed)).post(`/api/chat/${analyst.id}/messages`).send({ companyId: companyA, message: "Salg?", laneHint: "a" })).status,
    ).toBe(200);
    // ...a run id that came from a plain header (board key / agent API key) is not.
    const headerRun = randomUUID();
    const unsigned = scriptedModel([callTool({ action: "sales", periods: ["last_month"] }), reply((card) => card)]);
    const keyActor = { type: "agent", agentId: requester.id, companyId: companyA, source: "agent_key", runId: headerRun };
    expect(
      (await request(chatApp(keyActor, unsigned)).post(`/api/chat/${analyst.id}/messages`).send({ companyId: companyA, message: "Salg?", laneHint: "a" })).status,
    ).toBe(200);
    const rows = await auditRows(companyA);
    expect(rows.map((row) => row.runId).sort()).toEqual([runId, null].sort());

    // 14 more lookups in the same run fill it; the 16th is refused. Spread over
    // time so the per-minute limits are not what stops it.
    for (let i = 0; i < BUSINESS_DATA_LIMITS.perRun - 1; i += 1) {
      await recordDataReadEvent(db, {
        companyId: companyA, connectionId, dataset: "sales", channel: "quick_chat", runId, outcome: "ok",
        createdAt: new Date(clock - 3_600_000),
      });
    }
    const svc = businessDataService(db, deps());
    const refused = await svc.read(caller(companyA, analyst.id, { runId }), { action: "sales", periods: ["last_month"] });
    expect(refused).toMatchObject({ ok: false, outcome: "rate_limited", refusalCode: "run_limit" });
    expect(refused.text).toContain("Denne kjøringen har allerede gjort 15 oppslag i salgsdata");
    // Another run is not affected.
    expect((await svc.read(caller(companyA, analyst.id, { runId: randomUUID() }), { action: "sales", periods: ["last_month"] })).ok).toBe(true);
  });

  // ─── What the answer may say ─────────────────────────────────────────────

  it("comes back ambiguous for 'sofa' even though 'Sofa' is an exact product type, without scanning orders", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const svc = businessDataService(db, deps());
    const answer = await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"], product_type_query: "sofa" });
    expect(answer).toMatchObject({ ok: false, outcome: "ambiguous", refusalCode: "ambiguous_product_type" });
    expect(answer.text).toContain("Hjørnesofa, Sofa, Sofabord, Sovesofa");
    expect(answer.text).toContain("Spør personen");
    expect(shopA.requests.map((entry) => entry.operation)).toEqual(["PaperclipProductTypes"]);

    const one = await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["month_before_last"], product_type_query: "hjornesofa" });
    expect(one.ok).toBe(true);
    expect(one.text).toContain("Sales in units for product type: Hjørnesofa");
    expect(one.text).toContain("Sold: 1 unit");
  });

  it("adds up an explicit list of product types on the server", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const answer = await businessDataService(db, deps()).read(caller(companyA, agentA.id), {
      action: "sales", periods: ["month_before_last"], product_types: ["Sofa", "Hjørnesofa"],
    });
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain("Sold: 4 units");
    expect(answer.text).toContain("  Sofa: sold 3, returns 0, net 3");
    expect(answer.text).toContain("  Hjørnesofa: sold 1, returns 0, net 1");
  });

  it("refuses kroner with a plain sentence, before any request", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const answer = await businessDataService(db, deps()).read(caller(companyA, agentA.id), {
      action: "sales", periods: ["last_month"], measure: ["kroner"],
    });
    expect(answer).toMatchObject({ ok: false, outcome: "refused", refusalCode: "kroner_not_enabled", text: KRONER_NOT_ENABLED_MESSAGE });
    expect(shopA.requests).toHaveLength(0);
  });

  it("says 'no data' for a month that has not started, which is not zero", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const answer = await businessDataService(db, deps()).read(caller(companyA, agentA.id), { action: "sales", periods: ["2026-12"] });
    expect(answer).toMatchObject({ ok: true, outcome: "no_data" });
    expect(answer.text).toContain("No data: The period has not started yet. (not the same as nothing sold)");
    expect(answer.text).not.toContain("Sold:");
    const [row] = await auditRows(companyA);
    expect(row!.outcome).toBe("no_data");
  });

  it("refuses rather than guesses when Shopify fails", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    const failing = (async () => new Response("oops", { status: 500 })) as typeof fetch;
    const answer = await businessDataService(db, { ...deps(), fetchImpl: failing }).read(caller(companyA, agentA.id), {
      action: "sales", periods: ["last_month"],
    });
    expect(answer.ok).toBe(false);
    expect(answer.outcome).toBe("upstream_error");
    expect(answer.text).not.toMatch(/Sold:|Net:/);
    const [row] = await auditRows(companyA);
    expect(row!.outcome).toBe("upstream_error");
  });

  it("offers nothing, and leaves the quick-agent prompt as it was, while the instance switch is off", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const agentA = await seedQuickAgent(companyA);
    await connectShop(companyA, SHOP_A, KEY_A);
    await setFlag(false);
    const svc = businessDataService(db, deps());
    expect(await svc.isAvailable(companyA)).toBe(false);
    const answer = await svc.read(caller(companyA, agentA.id), { action: "sales", periods: ["last_month"] });
    expect(answer).toMatchObject({ ok: false, refusalCode: "business_data_disabled" });
    expect(shopA.requests).toHaveLength(0);

    const model = scriptedModel([reply("Hei!")]);
    const res = await request(chatApp(boardActor([companyA]), model))
      .post(`/api/chat/${agentA.id}/messages`)
      .send({ companyId: companyA, message: "Hei", laneHint: "a" });
    expect(res.status).toBe(200);
    expect(res.body.result.response).toBe("Hei!");
    expect(model.calls[0]!.tools).not.toContain("read_business_data");
    expect(model.calls[0]!.system).not.toContain("salgsdata");
    expect(model.calls[0]!.system).not.toContain("read_business_data");
  });

  // ─── The board's trial calculation ───────────────────────────────────────

  it("runs the trial calculation for the board, and refuses an agent", async () => {
    const companyA = await seedCompany("Nordstrand Konsernet");
    const connectionId = await connectShop(companyA, SHOP_A, KEY_A);
    const agentA = await seedQuickAgent(companyA);
    const app = (actor: Record<string, unknown>) => {
      const instance = express();
      instance.use(express.json());
      instance.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      instance.use("/api", dataConnectionRoutes(db, deps()));
      instance.use(errorHandler);
      return instance;
    };

    // The trial is served by slice S2's route (services/data-trial.ts): the
    // operator chooses the months. It runs the same S3 sales engine as the
    // agent's read_business_data, so the numbers here are the numbers an agent
    // would give for the same months.
    const trialBody = { periods: ["2026-07", "2026-08"], groupBy: "product_type" };
    const res = await request(app(boardActor([companyA])))
      .post(`/api/companies/${companyA}/data-connections/${connectionId}/trial`)
      .send(trialBody);
    expect(res.status).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.card).toContain("Sofa: sold 3, returns 1, net 2");
    expect(JSON.stringify(res.body)).not.toContain(KEY_A);
    const [row] = await auditRows(companyA);
    expect(row).toMatchObject({ channel: "settings_test", outcome: "ok", userId: "filip", agentId: null, id: res.body.lookupId });

    const agentRes = await request(app({ type: "agent", agentId: agentA.id, companyId: companyA, source: "agent_jwt", runId: randomUUID() }))
      .post(`/api/companies/${companyA}/data-connections/${connectionId}/trial`)
      .send(trialBody);
    expect(agentRes.status).toBe(403);

    const otherCompany = await seedCompany("Durkan Agency");
    const crossRes = await request(app(boardActor([otherCompany])))
      .post(`/api/companies/${companyA}/data-connections/${connectionId}/trial`)
      .send(trialBody);
    expect(crossRes.status).toBe(403);
    expect(await auditRows(companyA)).toHaveLength(1);
  });
});
