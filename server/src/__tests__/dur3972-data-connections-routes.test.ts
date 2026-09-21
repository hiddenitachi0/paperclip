import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@paperclipai/db";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  dataConnections,
  dataDatasetSources,
  dataReadEvents,
  instanceSettings,
  projects,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { defaultFixture, startFakeShopify, type FakeShopify } from "./helpers/fake-shopify-guarded.js";
import { errorHandler } from "../middleware/error-handler.js";
import { dataConnectionRoutes } from "../routes/data-connections.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { resetShopifyTokenCache } from "../services/data-sources/shopify-client.js";
import { recordDataReadEvent } from "../services/data-read-audit.js";
import { dataConnectionService } from "../services/data-connections.js";
import { SHOP_AND_SCOPES_QUERY } from "../services/data-sources/shopify-connection-check.js";

/**
 * DUR-3972 slice S1 acceptance tests, against a real Postgres with every
 * migration applied (including 0168), and a fake Shopify that validates and
 * executes every query against the committed Shopify Admin 2026-07 schema.
 *
 *  (a) a data-connection key cannot be bound to an agent's env or MCP servers,
 *      by an agent or by a board user, and no binding row is written
 *  (b) the key never appears in any route response, activity row, audit row,
 *      error, or anywhere else in the database
 *  (d) Test reports the scopes; write_products or a missing read_all_orders
 *      blocks activation
 *  (e) client-credentials tokens refresh before expiry and are never stored
 *  (f) one source per dataset per company, and no grant to another company's
 *      connection, enforced by the database
 *  (g) an agent gets 403 on every route, and so does a board user of another
 *      company
 * ((c) is in dur3972-safe-outbound-fetch.test.ts, (h) in
 *  dur3972-migration-graph.test.ts.)
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3972 data connection tests: ${support.reason ?? "unsupported environment"}`);
}

const KEY = "shp" + "at_s3cr3tk3yN0rdstrand0123456789ab";
const ROTATED_KEY = "shp" + "at_r0tat3dk3yN0rdstrand987654321zz";
const CLIENT_ID = "nordstrand-client-id-0001";
const CLIENT_SECRET = "shp" + "ss_cl13ntS3cr3tN0rdstrand55555555";
const SHOP = "nordstrand-test.myshopify.com";

const secretRef = (secretId: string) => ({ type: "secret_ref" as const, secretId, version: "latest" as const });

d("DUR-3972 data connections", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur3972-${randomUUID()}`);
  let fake: FakeShopify | null = null;
  let clock = Date.now();

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur3972-data-connections");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    clock = Date.now();
    resetShopifyTokenCache();
    await setFlag(true);
  });

  afterEach(async () => {
    await fake?.close();
    fake = null;
    await db.delete(dataReadEvents);
    await db.delete(dataDatasetSources);
    await db.delete(dataConnections);
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(agents);
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
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, adapterType = "process") {
    return agentService(db).create(companyId, {
      name: `A-${randomUUID().slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: adapterType === "process" ? { command: "echo" } : {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  const memberActor = (companyIds: string[], userId = "member") => ({
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole: "admin" })),
  });

  const agentActor = (companyId: string, agentId: string) => ({
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: null,
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use(
      "/api",
      dataConnectionRoutes(db, {
        fetchImpl: fake?.guardedFetch(),
        now: () => clock,
        sleep: async () => undefined,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function startShop(options: Parameters<typeof startFakeShopify>[0] = {}) {
    fake = await startFakeShopify({ acceptedTokens: [KEY], ...options });
    return fake;
  }

  async function connect(app: express.Express, companyId: string, credential: Record<string, unknown> = { kind: "admin_access_token", accessToken: KEY }) {
    return request(app)
      .post(`/api/companies/${companyId}/data-connections`)
      .send({ kind: "shopify", name: "Nettbutikken", shopDomain: `https://${SHOP}/admin`, credential });
  }

  /**
   * Every row of every table the Drizzle schema defines, as text. Tables are
   * taken from the schema in this repo (never discovered from the live
   * database), which is also every table the migrations create.
   */
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

  function expectNoSecret(haystack: string, secrets: string[]) {
    for (const secret of secrets) {
      expect(haystack.includes(secret), `found ${secret.slice(0, 10)}… in:\n${haystack.slice(0, 400)}`).toBe(false);
      // Also no long fragment of it (someone slicing the key into a hint).
      expect(haystack.includes(secret.slice(6, 26))).toBe(false);
    }
  }

  async function connectionRow(connectionId: string) {
    const [row] = await db.select().from(dataConnections).where(eq(dataConnections.id, connectionId));
    return row!;
  }

  // ── Off by default ─────────────────────────────────────────────────────────

  it("is switched off by default: every route answers 404 with a plain sentence", async () => {
    await setFlag(false);
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));
    const listed = await request(app).get(`/api/companies/${companyId}/data-connections`);
    expect(listed.status).toBe(404);
    expect(listed.body.code).toBe("business_data_disabled");
    const created = await connect(app, companyId);
    expect(created.status).toBe(404);
    expect(await db.select().from(dataConnections)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  // ── (d) Test, scopes and activation ────────────────────────────────────────

  it("connects as a draft, Test reads the shop and switches it on, and Salg can then be granted", async () => {
    await startShop();
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));

    const created = await connect(app, companyId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      kind: "shopify",
      shopDomain: SHOP,
      apiVersion: "2026-07",
      access: "read",
      status: "draft",
      credentialKind: "admin_access_token",
      credentialHint: "••••89ab",
      dailyLookupCap: 300,
      datasets: [],
    });

    // Not tested yet: cannot be switched on, cannot answer Salg.
    const early = await request(app)
      .put(`/api/companies/${companyId}/dataset-sources/sales`)
      .send({ connectionId: created.body.id });
    expect(early.status).toBe(422);

    const tested = await request(app).post(`/api/companies/${companyId}/data-connections/${created.body.id}/test`);
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(fake!.schemaErrors).toEqual([]);
    expect(tested.body).toMatchObject({
      ok: true,
      canActivate: true,
      problems: [],
      status: "active",
      observed: {
        shopName: "Nordstrand Møbler",
        ianaTimezone: "Europe/Oslo",
        currencyCode: "NOK",
        grantedScopes: ["read_all_orders", "read_orders", "read_products"],
        earliestVisibleOrderAt: "2024-03-02T09:15:00Z",
      },
    });

    const granted = await request(app)
      .put(`/api/companies/${companyId}/dataset-sources/sales`)
      .send({ connectionId: created.body.id });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.source).toMatchObject({ dataset: "sales", connectionId: created.body.id });

    const listed = await request(app).get(`/api/companies/${companyId}/data-connections`);
    expect(listed.body[0].datasets).toEqual(["sales"]);

    const reads = await request(app).get(`/api/companies/${companyId}/data-reads`);
    expect(reads.status).toBe(200);
    expect(reads.body[0]).toMatchObject({ channel: "settings_test", outcome: "ok", dataset: "connection_check" });

    // Switching off is always allowed; the grant then answers nothing.
    const off = await request(app)
      .patch(`/api/companies/${companyId}/data-connections/${created.body.id}`)
      .send({ status: "disabled" });
    expect(off.body.status).toBe("disabled");
  });

  for (const [label, scopes, expected] of [
    ["a write_products scope", ["read_orders", "read_all_orders", "read_products", "write_products"], "write_products"],
    ["a missing read_all_orders", ["read_orders", "read_products"], "read_all_orders"],
  ] as const) {
    it(`blocks activation for ${label}`, async () => {
      await startShop({ fixture: defaultFixture({ scopes: [...scopes] }) });
      const companyId = await seedCompany();
      const app = createApp(memberActor([companyId]));
      const created = await connect(app, companyId);

      const tested = await request(app).post(`/api/companies/${companyId}/data-connections/${created.body.id}/test`);
      expect(tested.status).toBe(200);
      expect(tested.body.ok).toBe(true);
      expect(tested.body.canActivate).toBe(false);
      expect(tested.body.status).toBe("error");
      expect(tested.body.observed.grantedScopes).toEqual([...scopes].sort());
      expect(tested.body.problems.join(" ")).toContain(expected);

      const on = await request(app)
        .patch(`/api/companies/${companyId}/data-connections/${created.body.id}`)
        .send({ status: "active" });
      expect(on.status).toBe(422);
      expect(on.body.code).toBe("data_connection_not_verified");

      const grant = await request(app)
        .put(`/api/companies/${companyId}/dataset-sources/sales`)
        .send({ connectionId: created.body.id });
      expect(grant.status).toBe(422);
      expect(await db.select().from(dataDatasetSources)).toHaveLength(0);
      expect((await connectionRow(created.body.id)).status).toBe("error");
    });
  }

  it("refuses to store anything but a *.myshopify.com address, in the route and in the database", async () => {
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));
    const bad = await request(app)
      .post(`/api/companies/${companyId}/data-connections`)
      .send({ kind: "shopify", shopDomain: "nordstrand.no", credential: { kind: "admin_access_token", accessToken: KEY } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("myshopify");
    expect(JSON.stringify(bad.body)).not.toContain(KEY);

    const secret = await secretService(db).create(companyId, { name: "x", provider: "local_encrypted", value: "v-123456" });
    await expect(
      db.insert(dataConnections).values({
        companyId,
        kind: "shopify",
        name: "x",
        shopDomain: "internal.example.com",
        apiVersion: "2026-07",
        credentialKind: "admin_access_token",
        credentialSecretId: secret.id,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(dataConnections).values({
        companyId,
        kind: "shopify",
        name: "x",
        shopDomain: SHOP,
        apiVersion: "2026-07",
        credentialKind: "admin_access_token",
        credentialSecretId: secret.id,
        access: "write",
      }),
    ).rejects.toThrow();
  });

  // ── (b) the key never comes back out ───────────────────────────────────────

  it("never puts the key in a response, activity row, audit row, error, or anywhere in the database", async () => {
    await startShop({ acceptedTokens: [KEY, ROTATED_KEY] });
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));
    const responses: string[] = [];
    const keep = (res: request.Response) => {
      responses.push(JSON.stringify(res.body), JSON.stringify(res.headers));
      return res;
    };

    const created = keep(await connect(app, companyId));
    const id = created.body.id as string;
    keep(await request(app).get(`/api/companies/${companyId}/data-connections`));
    keep(await request(app).get(`/api/companies/${companyId}/data-connections/${id}`));
    keep(await request(app).post(`/api/companies/${companyId}/data-connections/${id}/test`));
    keep(await request(app).put(`/api/companies/${companyId}/dataset-sources/sales`).send({ connectionId: id }));
    keep(await request(app).get(`/api/companies/${companyId}/dataset-sources`));
    keep(await request(app).patch(`/api/companies/${companyId}/data-connections/${id}`).send({ name: "Butikken", dailyLookupCap: 250 }));

    // Shopify echoes the key back in an error: it must not survive.
    fake!.echoTokenInErrorNext(1);
    const echoed = keep(await request(app).post(`/api/companies/${companyId}/data-connections/${id}/test`));
    expect(echoed.body.ok).toBe(false);
    expect(echoed.body.problems.join(" ")).toContain("ACCESS_DENIED");

    // A wrong key: the error says so plainly and does not quote it.
    const rotated = keep(
      await request(app)
        .patch(`/api/companies/${companyId}/data-connections/${id}`)
        .send({ credential: { kind: "admin_access_token", accessToken: "shp" + "at_wrongwrongwrongwrongwrong12" } }),
    );
    expect(rotated.body.status).toBe("draft");
    expect(rotated.body.credentialHint).toBe("••••ng12");
    const wrong = keep(await request(app).post(`/api/companies/${companyId}/data-connections/${id}/test`));
    expect(wrong.body.problems.join(" ")).toContain("godtok ikke nøkkelen");

    keep(
      await request(app)
        .patch(`/api/companies/${companyId}/data-connections/${id}`)
        .send({ credential: { kind: "admin_access_token", accessToken: ROTATED_KEY } }),
    );
    const retested = keep(await request(app).post(`/api/companies/${companyId}/data-connections/${id}/test`));
    expect(retested.body.status).toBe("active");
    keep(await request(app).get(`/api/companies/${companyId}/data-reads`));

    // A validation error must not echo a key either.
    keep(
      await request(app)
        .post(`/api/companies/${companyId}/data-connections`)
        .send({ kind: "shopify", shopDomain: SHOP, credential: { kind: "admin_access_token", accessToken: `${KEY} with spaces` } }),
    );

    const allResponses = responses.join("\n");
    expectNoSecret(allResponses, [KEY, ROTATED_KEY, "shp" + "at_wrongwrongwrongwrongwrong12"]);

    const activity = JSON.stringify(await db.select().from(activityLog));
    expect(activity).toContain("data_connection.connected");
    expectNoSecret(activity, [KEY, ROTATED_KEY]);
    expect(activity).not.toContain("••••");

    const audit = JSON.stringify(await db.select().from(dataReadEvents));
    expect(audit).toContain("settings_test");
    expectNoSecret(audit, [KEY, ROTATED_KEY]);

    const dump = await dumpDatabase();
    expect(dump).toContain("data_connections:");
    expectNoSecret(dump, [KEY, ROTATED_KEY, "shp" + "at_wrongwrongwrongwrongwrong12"]);

    // Every key read went through the binding and is in the credential audit.
    const reads = await db
      .select()
      .from(secretAccessEvents)
      .where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.consumerType, "data_connection")));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads.every((row) => row.consumerId === id && row.configPath === "credential")).toBe(true);

    // And the key only ever travelled to Shopify in the header.
    for (const req of fake!.requests) {
      expect(req.path).not.toContain("shp" + "at_");
      expect(req.body).not.toContain("shp" + "at_");
    }
  });

  it("removing a connection deletes the key and the grant but keeps the audit trail", async () => {
    await startShop();
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));
    const created = await connect(app, companyId);
    await request(app).post(`/api/companies/${companyId}/data-connections/${created.body.id}/test`);
    await request(app).put(`/api/companies/${companyId}/dataset-sources/sales`).send({ connectionId: created.body.id });
    const secretId = (await connectionRow(created.body.id)).credentialSecretId;

    const removed = await request(app).delete(`/api/companies/${companyId}/data-connections/${created.body.id}`);
    expect(removed.status).toBe(200);
    expect(await db.select().from(dataConnections)).toHaveLength(0);
    expect(await db.select().from(dataDatasetSources)).toHaveLength(0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secretId))).toHaveLength(0);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetType, "data_connection"))).toHaveLength(0);
    const audit = await db.select().from(dataReadEvents);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.connectionId).toBeNull();
  });

  it("hands S4 a keyless read context for an active connection of the caller's company only", async () => {
    await startShop();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentA = await seedAgent(companyA);
    const app = createApp(memberActor([companyA]));
    const created = await connect(app, companyA);
    const svc = dataConnectionService(db, { fetchImpl: fake!.guardedFetch(), now: () => clock });

    await expect(
      svc.openReadContext(companyA, created.body.id, { actorType: "agent", actorId: agentA.id }),
    ).rejects.toMatchObject({ status: 422, details: { code: "data_connection_not_active" } });
    expect(await svc.getActiveDatasetSource(companyA, "sales")).toBeNull();

    await request(app).post(`/api/companies/${companyA}/data-connections/${created.body.id}/test`);
    await request(app).put(`/api/companies/${companyA}/dataset-sources/sales`).send({ connectionId: created.body.id });
    const source = await svc.getActiveDatasetSource(companyA, "sales");
    expect(source?.id).toBe(created.body.id);
    expect(await svc.getActiveDatasetSource(companyB, "sales")).toBeNull();

    const { read, knownSecrets } = await svc.openReadContext(companyA, created.body.id, {
      actorType: "agent",
      actorId: agentA.id,
    });
    expect(read.connection).toMatchObject({ companyId: companyA, shopDomain: SHOP, ianaTimezone: "Europe/Oslo" });
    expect(JSON.stringify(read.connection)).not.toContain(KEY);
    const body = await read.shopifyTransport.request(SHOP_AND_SCOPES_QUERY, {});
    expect((body.data as { shop: { currencyCode: string } }).shop.currencyCode).toBe("NOK");
    expect(knownSecrets()).toContain(KEY);

    // Company B cannot open A's connection, whatever id it passes.
    await expect(
      svc.openReadContext(companyB, created.body.id, { actorType: "agent", actorId: agentA.id }),
    ).rejects.toMatchObject({ status: 404 });

    const agentReads = await db
      .select()
      .from(secretAccessEvents)
      .where(and(eq(secretAccessEvents.consumerType, "data_connection"), eq(secretAccessEvents.actorType, "agent")));
    expect(agentReads).toHaveLength(1);
    expect(agentReads[0]!.actorId).toBe(agentA.id);
  });

  // ── (e) client-credentials tokens ──────────────────────────────────────────

  it("client-credentials: refreshes the short-lived token before it expires and never stores it", async () => {
    await startShop({ clientCredentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, expiresInSeconds: 3600 } });
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));
    const created = await connect(app, companyId, { kind: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.credentialKind).toBe("client_credentials");
    expect(created.body.credentialHint).toBe("••••5555");

    const first = await request(app).post(`/api/companies/${companyId}/data-connections/${created.body.id}/test`);
    expect(first.body.status, JSON.stringify(first.body)).toBe("active");
    expect(fake!.issuedTokens).toHaveLength(1);

    clock += 20 * 60_000; // 20 of 60 minutes: still fresh, reused
    await request(app).post(`/api/companies/${companyId}/data-connections/${created.body.id}/test`);
    expect(fake!.issuedTokens).toHaveLength(1);

    clock += 36 * 60_000; // 56 of 60 minutes: inside the 5-minute margin, refreshed early
    const third = await request(app).post(`/api/companies/${companyId}/data-connections/${created.body.id}/test`);
    expect(third.body.status).toBe("active");
    expect(fake!.issuedTokens).toHaveLength(2);

    const dump = await dumpDatabase();
    expectNoSecret(dump, [...fake!.issuedTokens, CLIENT_SECRET]);
  });

  // ── (a) the key is locked to its connection ────────────────────────────────

  it("refuses binding a data-connection key to an agent's env or MCP servers, for a board user and for an agent", async () => {
    await startShop();
    const companyId = await seedCompany();
    const app = createApp(memberActor([companyId]));
    const created = await connect(app, companyId);
    const secretId = (await connectionRow(created.body.id)).credentialSecretId;
    const processAgent = await seedAgent(companyId);
    const claudeAgent = await seedAgent(companyId, "claude_local");

    const agentBindings = async () =>
      db.select().from(companySecretBindings).where(eq(companySecretBindings.targetType, "agent"));

    // Board user, env.
    await expect(
      agentService(db).update(
        processAgent.id,
        { adapterConfig: { command: "echo", env: { SHOP_KEY: secretRef(secretId) } } },
        { actor: { actorType: "user", agentId: null } },
      ),
    ).rejects.toMatchObject({ status: 422, details: { code: "secret_dedicated_to_other_target" } });

    // Board user, MCP server headers.
    await expect(
      agentService(db).update(
        claudeAgent.id,
        { adapterConfig: { mcpServers: [{ name: "shop", command: "npx", headers: { X_KEY: secretRef(secretId) } }] } },
        { actor: { actorType: "user", agentId: null } },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // Board user, hiring a new agent that carries it.
    await expect(
      agentService(db).create(companyId, {
        name: "Ny",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "echo", env: { SHOP_KEY: secretRef(secretId) } },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }, { actor: { actorType: "user", agentId: null } }),
    ).rejects.toMatchObject({ status: 422 });

    // An agent, on itself (DUR-3980 already refuses; still no binding).
    await expect(
      agentService(db).update(
        processAgent.id,
        { adapterConfig: { command: "echo", env: { SHOP_KEY: secretRef(secretId) } } },
        { actor: { actorType: "agent", agentId: processAgent.id } },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Any other binding path.
    await expect(
      secretService(db).createBinding({ companyId, secretId, targetType: "project", targetId: randomUUID(), configPath: "env.X" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      secretService(db).syncSecretRefsForTarget(companyId, { targetType: "data_connection", targetId: randomUUID() }, [
        { secretId, configPath: "credential" },
      ]),
    ).rejects.toMatchObject({ status: 422 });

    expect(await agentBindings()).toHaveLength(0);
    const all = await db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, secretId));
    expect(all.map((row) => row.targetType)).toEqual(["data_connection"]);
    // The agents' saved configuration did not change either (rolled back).
    const [reloaded] = await db.select().from(agents).where(eq(agents.id, processAgent.id));
    expect(JSON.stringify(reloaded!.adapterConfig)).not.toContain(secretId);
  });

  it("applies the same lock to Telegram-bot tokens, keeps what a target already holds, and leaves ordinary passwords alone", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const botSecret = await secrets.create(companyId, { name: "bot", provider: "local_encrypted", value: "123:bot-token-abcdef" });
    await secrets.syncSecretRefsForTarget(companyId, { targetType: "telegram_bot", targetId: randomUUID() }, [
      { secretId: botSecret.id, configPath: "bot_token" },
    ]);
    const agentA = await seedAgent(companyId);
    await expect(
      agentService(db).update(
        agentA.id,
        { adapterConfig: { command: "echo", env: { BOT: secretRef(botSecret.id) } } },
        { actor: { actorType: "user", agentId: null } },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // Legacy state: an agent that already held a secret before it also became
    // a bot's token keeps working when it is saved again.
    const legacy = await secrets.create(companyId, { name: "legacy", provider: "local_encrypted", value: "legacy-value-123" });
    const agentB = await seedAgent(companyId);
    await agentService(db).update(
      agentB.id,
      { adapterConfig: { command: "echo", env: { OLD: secretRef(legacy.id) } } },
      { actor: { actorType: "user", agentId: null } },
    );
    await db.insert(companySecretBindings).values({
      companyId,
      secretId: legacy.id,
      targetType: "telegram_bot",
      targetId: randomUUID(),
      configPath: "bot_token",
    });
    const resaved = await agentService(db).update(
      agentB.id,
      { adapterConfig: { command: "echo", env: { OLD: secretRef(legacy.id) }, extra: "x" } },
      { actor: { actorType: "user", agentId: null } },
    );
    expect(resaved).toBeTruthy();
    // ...but it cannot spread to another agent.
    await expect(
      agentService(db).update(
        agentA.id,
        { adapterConfig: { command: "echo", env: { OLD: secretRef(legacy.id) } } },
        { actor: { actorType: "user", agentId: null } },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // An ordinary saved password is unaffected.
    const plain = await secrets.create(companyId, { name: "plain", provider: "local_encrypted", value: "plain-value-123" });
    await agentService(db).update(
      agentA.id,
      { adapterConfig: { command: "echo", env: { PLAIN: secretRef(plain.id) } } },
      { actor: { actorType: "user", agentId: null } },
    );
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(eq(companySecretBindings.targetType, "agent"), eq(companySecretBindings.targetId, agentA.id)));
    expect(bindings.map((row) => row.secretId)).toEqual([plain.id]);
  });

  // ── (f) database-enforced source rules ─────────────────────────────────────

  it("the database refuses a second Salg source in one company, and a grant to another company's connection", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const secrets = secretService(db);
    const makeConnection = async (companyId: string) => {
      const secret = await secrets.create(companyId, { name: `k-${randomUUID()}`, provider: "local_encrypted", value: "value-123456" });
      const [row] = await db
        .insert(dataConnections)
        .values({
          companyId,
          kind: "shopify",
          name: "Shop",
          shopDomain: SHOP,
          apiVersion: "2026-07",
          credentialKind: "admin_access_token",
          credentialSecretId: secret.id,
          status: "active",
        })
        .returning();
      return row!;
    };
    const a1 = await makeConnection(companyA);
    const a2 = await makeConnection(companyA);
    const b1 = await makeConnection(companyB);

    await db.insert(dataDatasetSources).values({ companyId: companyA, dataset: "sales", connectionId: a1.id });
    await expect(
      db.insert(dataDatasetSources).values({ companyId: companyA, dataset: "sales", connectionId: a2.id }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(
      db.insert(dataDatasetSources).values({ companyId: companyB, dataset: "sales", connectionId: a1.id }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(dataDatasetSources).values({ companyId: companyA, dataset: "stock", connectionId: a1.id }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    // And through the route: company A cannot point at company B's connection.
    const app = createApp(memberActor([companyA]));
    const cross = await request(app).put(`/api/companies/${companyA}/dataset-sources/sales`).send({ connectionId: b1.id });
    expect(cross.status).toBe(404);
    const [grant] = await db.select().from(dataDatasetSources).where(eq(dataDatasetSources.companyId, companyA));
    expect(grant!.connectionId).toBe(a1.id);
  });

  it("the audit writer caps facts at 8 KB and scrubs known key shapes and exact values", async () => {
    const companyId = await seedCompany();
    const id = await recordDataReadEvent(db, {
      companyId,
      dataset: "sales",
      channel: "quick_chat",
      outcome: "ok",
      params: { note: `leaked ${KEY}` },
      facts: { big: "x".repeat(9000) },
      scrubValues: ["exact-value-999"],
    });
    const second = await recordDataReadEvent(db, {
      companyId,
      dataset: "sales",
      channel: "telegram",
      outcome: "refused",
      params: { q: "exact-value-999" },
      facts: { n: 5 },
      scrubValues: ["exact-value-999"],
    });
    const rows = await db.select().from(dataReadEvents);
    const first = rows.find((row) => row.id === id)!;
    expect(first.facts).toMatchObject({ truncated: true });
    expect(JSON.stringify(first.params)).not.toContain(KEY);
    expect(JSON.stringify(rows.find((row) => row.id === second)!.params)).not.toContain("exact-value-999");
  });

  // ── (g) who may call ───────────────────────────────────────────────────────

  it("an agent gets 403 on every route, and so does a board user of another company", async () => {
    await startShop();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentA = await seedAgent(companyA);
    const created = await connect(createApp(memberActor([companyA])), companyA);
    const id = created.body.id as string;

    const routes: Array<[string, string, Record<string, unknown>?]> = [
      ["get", `/api/companies/${companyA}/data-connections`],
      ["post", `/api/companies/${companyA}/data-connections`, { kind: "shopify", shopDomain: SHOP, credential: { kind: "admin_access_token", accessToken: KEY } }],
      ["get", `/api/companies/${companyA}/data-connections/${id}`],
      ["patch", `/api/companies/${companyA}/data-connections/${id}`, { name: "x" }],
      ["delete", `/api/companies/${companyA}/data-connections/${id}`],
      ["post", `/api/companies/${companyA}/data-connections/${id}/test`],
      ["get", `/api/companies/${companyA}/dataset-sources`],
      ["put", `/api/companies/${companyA}/dataset-sources/sales`, { connectionId: id }],
      ["get", `/api/companies/${companyA}/data-reads`],
    ];
    for (const [flag] of [[true], [false]] as const) {
      await setFlag(flag);
      for (const actor of [agentActor(companyA, agentA.id), memberActor([companyB], "other-board-user")]) {
        const app = createApp(actor);
        for (const [method, url, body] of routes) {
          const call = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url);
          const res = body ? await call.send(body) : await call;
          expect(res.status, `${actor.type} ${method.toUpperCase()} ${url} (flag ${flag})`).toBe(403);
          expect(JSON.stringify(res.body)).not.toContain(KEY);
        }
      }
    }
    await setFlag(true);
    // Nothing changed, nothing was tested.
    expect(await db.select().from(dataConnections)).toHaveLength(1);
    expect(fake!.requests).toHaveLength(0);

    // A board user of B asking for A's connection under B's own URL: not found.
    const bApp = createApp(memberActor([companyB]));
    expect((await request(bApp).get(`/api/companies/${companyB}/data-connections/${id}`)).status).toBe(404);
    expect((await request(bApp).post(`/api/companies/${companyB}/data-connections/${id}/test`)).status).toBe(404);
    expect((await request(bApp).delete(`/api/companies/${companyB}/data-connections/${id}`)).status).toBe(404);
    expect((await request(bApp).get(`/api/companies/${companyB}/data-connections`)).body).toEqual([]);
    expect(fake!.requests).toHaveLength(0);
  });
});
