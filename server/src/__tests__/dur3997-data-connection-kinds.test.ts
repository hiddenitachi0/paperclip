import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@paperclipai/db";
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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { dataConnectionRoutes } from "../routes/data-connections.js";
import { businessDataService } from "../services/business-data.js";
import { dataConnectionService } from "../services/data-connections.js";
import { secretService } from "../services/secrets.js";

/**
 * DUR-3997 slice 3, against a real Postgres with every migration applied
 * (0173 included):
 *
 *  - two Shopify connections with the same name in one company get two
 *    secrets with distinct names and keys, each bound to its own connection;
 *  - WooCommerce, Fiken and SFTP-file connections are accepted, stored with
 *    their non-secret settings in `config`, their credential locked to the
 *    connection and never returned; Test, switch-on, the dataset tick, the
 *    trial and the agent read path all answer with a plain "not yet" sentence
 *    instead of crashing;
 *  - a replacement key must match the connection's kind;
 *  - the database itself refuses an unknown kind, a Shopify row without a
 *    shop address, a credential kind that does not belong to the kind, and a
 *    dataset outside ('sales', 'finance', 'custom'); one source per dataset
 *    is still the rule.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3997 data connection kinds tests: ${support.reason ?? "unsupported environment"}`);
}

const KEY = "shp" + "at_s3cr3tk3yN0rdstrand0123456789ab";
const CK = "ck_" + "0123456789abcdef0123456789abcdef";
const CS = "cs_" + "fedcba9876543210fedcba9876543210";
const FIKEN_TOKEN = "fk" + "_0123456789abcdef0123456789abcdefFIKEN";
const SFTP_PASSWORD = "sftp-" + "hunter2-very-secret";
const SHOP = "nordstrand-test.myshopify.com";

d("DUR-3997 data connection kinds", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur3997-${randomUUID()}`);
  let clock = Date.now();

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur3997-data-connection-kinds");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    clock = Date.now();
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableBusinessData: true } });
  });

  afterEach(async () => {
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

  const ownerActor = (companyIds: string[], userId = "owner") => ({
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole: "owner" })),
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", dataConnectionRoutes(db, { now: () => clock, sleep: async () => undefined }));
    app.use(errorHandler);
    return app;
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

  const shopifyBody = (name: string) => ({
    kind: "shopify",
    name,
    shopDomain: SHOP,
    credential: { kind: "admin_access_token", accessToken: KEY },
  });
  const wooBody = {
    kind: "woocommerce",
    name: "Nettbutikken",
    storeUrl: "https://Butikken.no/wp-admin",
    credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS },
  };
  const fikenBody = {
    kind: "fiken",
    name: "Regnskapet",
    companySlug: "fiken-demo-firma-as",
    credential: { kind: "api_token", apiToken: FIKEN_TOKEN },
  };
  const sftpBody = {
    kind: "sftp_file",
    name: "Rapportfiler",
    host: "filer.butikken.no",
    username: "paperclip",
    remotePath: "/rapporter",
    credential: { kind: "password", password: SFTP_PASSWORD },
  };

  it("two Shopify connections with the same name get two secrets with distinct names and keys, each bound to its own connection", async () => {
    const companyId = await seedCompany();
    const app = createApp(ownerActor([companyId]));
    const first = await request(app).post(`/api/companies/${companyId}/data-connections`).send(shopifyBody("Nettbutikken"));
    const second = await request(app).post(`/api/companies/${companyId}/data-connections`).send(shopifyBody("Nettbutikken"));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);

    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secrets).toHaveLength(2);
    expect(new Set(secrets.map((secret) => secret.name)).size).toBe(2);
    expect(new Set(secrets.map((secret) => secret.key)).size).toBe(2);
    for (const secret of secrets) {
      expect(secret.name).toMatch(/^Shopify-nøkkel: Nettbutikken \([0-9a-f]{8}\)$/);
    }
    for (const created of [first.body, second.body]) {
      const [row] = await db.select().from(dataConnections).where(eq(dataConnections.id, created.id));
      const secret = secrets.find((entry) => entry.id === row!.credentialSecretId)!;
      expect(secret.name).toContain(created.id.replace(/-/g, "").slice(0, 8));
      const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, created.id));
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.secretId).toBe(secret.id);
    }
    // Each is a full Shopify summary, exactly as before plus the new descriptive fields.
    expect(first.body).toMatchObject({
      kind: "shopify",
      kindLabel: "Shopify",
      supported: true,
      target: SHOP,
      shopDomain: SHOP,
      apiVersion: "2026-07",
      config: { kind: "shopify" },
      datasetsOffered: ["sales"],
      status: "draft",
    });
    expect(JSON.stringify(first.body)).not.toContain(KEY);
  });

  it("stores WooCommerce, Fiken and SFTP connections with their settings in config and the key locked away, and says 'not yet' everywhere", async () => {
    const companyId = await seedCompany();
    const app = createApp(ownerActor([companyId]));
    const woo = await request(app).post(`/api/companies/${companyId}/data-connections`).send(wooBody);
    const fiken = await request(app).post(`/api/companies/${companyId}/data-connections`).send(fikenBody);
    const sftp = await request(app).post(`/api/companies/${companyId}/data-connections`).send(sftpBody);
    for (const response of [woo, fiken, sftp]) expect(response.status, JSON.stringify(response.body)).toBe(201);

    expect(woo.body).toMatchObject({
      kind: "woocommerce",
      kindLabel: "WooCommerce",
      supported: false,
      name: "Nettbutikken",
      target: "butikken.no",
      shopDomain: null,
      apiVersion: null,
      config: { kind: "woocommerce", storeUrl: "https://butikken.no" },
      credentialKind: "consumer_key_secret",
      credentialHint: `••••${CS.slice(-4)}`,
      status: "draft",
      datasets: [],
      datasetsOffered: ["sales"],
    });
    expect(fiken.body).toMatchObject({
      kind: "fiken",
      supported: false,
      target: "fiken-demo-firma-as",
      config: { kind: "fiken", companySlug: "fiken-demo-firma-as" },
      credentialKind: "api_token",
      datasetsOffered: ["finance"],
    });
    expect(sftp.body).toMatchObject({
      kind: "sftp_file",
      supported: false,
      target: "filer.butikken.no/rapporter",
      config: { kind: "sftp_file", host: "filer.butikken.no", port: 22, username: "paperclip", remotePath: "/rapporter" },
      credentialKind: "password",
      credentialHint: `••••${SFTP_PASSWORD.slice(-4)}`,
      datasetsOffered: ["custom"],
    });

    // The rows: Shopify columns null, config holds only non-secret settings.
    const rows = await db.select().from(dataConnections).where(eq(dataConnections.companyId, companyId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.shopDomain).toBeNull();
      expect(row.apiVersion).toBeNull();
      expect(JSON.stringify(row.config)).not.toMatch(/consumer|apiToken|password|credential/i);
    }
    // No secret value anywhere: not in a response, not in any row of any table (secrets are encrypted at rest).
    const everything = [woo, fiken, sftp].map((response) => JSON.stringify(response.body)).join("\n") + "\n" + (await dumpDatabase());
    for (const secret of [CK, CS, FIKEN_TOKEN, SFTP_PASSWORD]) {
      expect(everything.includes(secret), `found ${secret.slice(0, 6)}… somewhere`).toBe(false);
    }
    // Each credential is bound to its connection and locked (dedicated target type).
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    expect(bindings.map((binding) => binding.targetType)).toEqual(["data_connection", "data_connection", "data_connection"]);

    // The list shows them next to each other, each marked as not readable yet.
    const listed = await request(app).get(`/api/companies/${companyId}/data-connections`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((entry: { kind: string; supported: boolean }) => [entry.kind, entry.supported])).toEqual(
      expect.arrayContaining([["woocommerce", false], ["fiken", false], ["sftp_file", false]]),
    );

    // Test: a plain sentence, nothing contacted, nothing written, status untouched.
    const tested = await request(app).post(`/api/companies/${companyId}/data-connections/${woo.body.id}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: false, canActivate: false, status: "draft", observed: null, notes: [] });
    expect(tested.body.problems).toEqual([expect.stringContaining("WooCommerce-koblinger kan ikke leses ennå")]);
    expect(await db.select().from(dataReadEvents)).toHaveLength(0);
    const [afterTest] = await db.select().from(dataConnections).where(eq(dataConnections.id, woo.body.id));
    expect(afterTest!.status).toBe("draft");
    expect(afterTest!.lastCheckAt).toBeNull();

    // Switching on is refused with the same reason; the dataset tick is refused.
    const switchedOn = await request(app).patch(`/api/companies/${companyId}/data-connections/${woo.body.id}`).send({ status: "active" });
    expect(switchedOn.status).toBe(422);
    expect(switchedOn.body.details?.code ?? switchedOn.body.code).toBe("data_connection_not_verified");
    const granted = await request(app).put(`/api/companies/${companyId}/dataset-sources/sales`).send({ connectionId: woo.body.id });
    expect(granted.status).toBe(422);
    // Fiken cannot answer "sales" at all, whatever its status.
    const fikenSales = await request(app).put(`/api/companies/${companyId}/dataset-sources/sales`).send({ connectionId: fiken.body.id });
    expect(fikenSales.status).toBe(422);
    expect(JSON.stringify(fikenSales.body)).toContain("dataset_not_offered");
    // ...and "finance" is a real dataset now (refused only because the connection is not active).
    const fikenFinance = await request(app).put(`/api/companies/${companyId}/dataset-sources/finance`).send({ connectionId: fiken.body.id });
    expect(fikenFinance.status).toBe(422);
    expect(JSON.stringify(fikenFinance.body)).toContain("data_connection_not_active");
    expect((await request(app).put(`/api/companies/${companyId}/dataset-sources/stock`).send({ connectionId: fiken.body.id })).status).toBe(404);

    // The trial answers ok:false with a sentence, never a 500.
    const trial = await request(app).post(`/api/companies/${companyId}/data-connections/${woo.body.id}/trial`).send({ periods: ["2026-07"] });
    expect(trial.status).toBe(200);
    expect(trial.body.ok).toBe(false);

    // A replacement key must match the kind; a matching one is accepted and re-locks the connection as untested.
    const wrongKind = await request(app)
      .patch(`/api/companies/${companyId}/data-connections/${fiken.body.id}`)
      .send({ credential: { kind: "admin_access_token", accessToken: KEY } });
    expect(wrongKind.status).toBe(422);
    expect(JSON.stringify(wrongKind.body)).toContain("credential_kind_mismatch");
    const rotated = await request(app)
      .patch(`/api/companies/${companyId}/data-connections/${fiken.body.id}`)
      .send({ credential: { kind: "api_token", apiToken: `${FIKEN_TOKEN}-rotated` } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.credentialHint).toBe("••••ated");
    expect(rotated.body.status).toBe("draft");

    // Removing deletes the key too.
    const removed = await request(app).delete(`/api/companies/${companyId}/data-connections/${sftp.body.id}`);
    expect(removed.status).toBe(200);
    const remainingSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(remainingSecrets.filter((secret) => secret.status !== "deleted")).toHaveLength(2);
  });

  it("the agent read path refuses an unsupported kind with a sentence and an audit row, even if the row were forced active", async () => {
    const companyId = await seedCompany();
    const app = createApp(ownerActor([companyId]));
    const woo = await request(app).post(`/api/companies/${companyId}/data-connections`).send(wooBody);
    expect(woo.status).toBe(201);
    // Nothing in the code can do this; it stands in for "a later slice activated it without an adapter".
    await db.update(dataConnections).set({ status: "active", lastCheckOk: true }).where(eq(dataConnections.id, woo.body.id));
    await db.insert(dataDatasetSources).values({ companyId, dataset: "sales", connectionId: woo.body.id, grantedByUserId: "owner" });

    const svc = businessDataService(db, { now: () => clock });
    const answer = await svc.read(
      { companyId, channel: "quick_chat", agentId: null, userId: "owner", runId: null, laneAConversationId: null },
      { action: "sales", periods: ["last_month"] },
    );
    expect(answer.ok).toBe(false);
    expect(answer.refusalCode).toBe("data_source_kind_unsupported");
    expect(answer.text).toContain("WooCommerce-koblinger kan ikke leses ennå");
    const audit = await db.select().from(dataReadEvents);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.refusalCode).toBe("data_source_kind_unsupported");

    // The connection service refuses the same way, before any transport exists.
    await expect(
      dataConnectionService(db).openReadContext(companyId, woo.body.id, { actorType: "user", actorId: "owner" }),
    ).rejects.toMatchObject({ status: 422, details: { code: "data_source_kind_unsupported" } });
  });

  it("the database refuses an unknown kind, a Shopify row without a shop address, a credential kind of another kind, and a dataset outside the list", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const mk = async () => (await secrets.create(companyId, { name: `s-${randomUUID()}`, provider: "local_encrypted", value: "v-123456" })).id;
    const base = { companyId, name: "x", access: "read" as const };

    await expect(db.insert(dataConnections).values({ ...base, kind: "magento", credentialKind: "api_token", credentialSecretId: await mk() })).rejects.toThrow();
    await expect(db.insert(dataConnections).values({ ...base, kind: "shopify", credentialKind: "admin_access_token", credentialSecretId: await mk() })).rejects.toThrow();
    await expect(
      db.insert(dataConnections).values({ ...base, kind: "shopify", shopDomain: "internal.example.com", apiVersion: "2026-07", credentialKind: "admin_access_token", credentialSecretId: await mk() }),
    ).rejects.toThrow();
    await expect(
      db.insert(dataConnections).values({ ...base, kind: "woocommerce", credentialKind: "admin_access_token", credentialSecretId: await mk(), config: { storeUrl: "https://butikken.no" } }),
    ).rejects.toThrow();
    await expect(db.insert(dataConnections).values({ ...base, kind: "fiken", credentialKind: "password", credentialSecretId: await mk() })).rejects.toThrow();

    // Accepted: a WooCommerce row with no Shopify columns, and a Shopify row exactly as before.
    const [woo] = await db
      .insert(dataConnections)
      .values({ ...base, kind: "woocommerce", credentialKind: "consumer_key_secret", credentialSecretId: await mk(), config: { storeUrl: "https://butikken.no" }, status: "active" })
      .returning();
    const [shop] = await db
      .insert(dataConnections)
      .values({ ...base, kind: "shopify", shopDomain: SHOP, apiVersion: "2026-07", credentialKind: "client_credentials", credentialSecretId: await mk(), status: "active" })
      .returning();
    expect(woo!.config).toEqual({ storeUrl: "https://butikken.no" });
    expect(shop!.config).toEqual({});

    // Datasets: finance and custom are real; stock is not.
    await db.insert(dataDatasetSources).values({ companyId, dataset: "finance", connectionId: woo!.id });
    await db.insert(dataDatasetSources).values({ companyId, dataset: "custom", connectionId: woo!.id });
    await expect(db.insert(dataDatasetSources).values({ companyId, dataset: "stock", connectionId: woo!.id })).rejects.toThrow();
    // Still one source per dataset per company: the primary key was left alone.
    await db.insert(dataDatasetSources).values({ companyId, dataset: "sales", connectionId: shop!.id });
    await expect(db.insert(dataDatasetSources).values({ companyId, dataset: "sales", connectionId: woo!.id })).rejects.toThrow();
  });
});
