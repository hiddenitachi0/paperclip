import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  dataConnections,
  dataReadEvents,
  documentRevisions,
  documents,
  instanceSettings,
  reportFixtures,
  reportRuns,
  reportScriptRuns,
  reportScripts,
  reportScriptVersions,
  reportTemplates,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { reportTemplateRoutes } from "../routes/report-templates.js";
import { agentService } from "../services/agents.js";
import { dataConnectionService } from "../services/data-connections.js";
import { ReportScriptRunLimiter, reportScriptsService } from "../services/report-scripts.js";
import { reportTemplatesService } from "../services/report-templates.js";
import { reportRunsService } from "../services/report-runs.js";
import { canonicalizeJson, sha256OfJson } from "../services/report-data.js";
import type { ReportScriptRunner } from "../services/report-script-runner.js";

/**
 * DUR-4072 PR3 against a real Postgres with every migration applied (0248
 * included): a report run's data is fetched by the SERVER through the
 * template's own company connection.
 *
 *  - the credential is resolved server-side and appears nowhere the agent
 *    or the script can see (input snapshot, run row, audit rows);
 *  - every dataset read is one data_read_events row (channel report_run);
 *  - the snapshot is stored with the sha256 of exactly the JSON the script
 *    got (equal to the script run's input digest);
 *  - another company's connection is refused at RUN time too, even if the
 *    template row was tampered with after saving;
 *  - the daily cap and the instance switch are enforced; an unapproved
 *    calculation reads no data at all;
 *  - "Preview data" is for a company owner/admin only, audited as
 *    report_preview, and shows the first rows.
 *
 * Fiken is stubbed: no real HTTP call is made.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4072 report data fetch tests: ${support.reason ?? "unsupported environment"}`);
}

const TOKEN = "fk" + "_live_abcdef0123456789REPORTKEY";
const OTHER_TOKEN = "fk" + "_live_zyxwvu9876543210OTHERCOMPANY";

d("DUR-4072 report data fetch", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur4072-data-${randomUUID()}`);

  const fikenCalls: Array<{ url: URL; method: string; auth: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    fikenCalls.push({ url, method: (init?.method ?? "GET").toUpperCase(), auth: new Headers(init?.headers).get("authorization") });
    const route = url.pathname.replace(/^\/api\/v2\/companies\/[^/]+/, "");
    let body: unknown = [];
    if (route === "") body = { name: "Nordstrand Møbler AS" };
    if (route === "/accountBalances") {
      body = url.searchParams.get("date") === "2026-06-30" ? [{ code: "1920", name: "Bank", balance: 100 }] : [{ code: "1920", name: "Bank", balance: 350 }];
    }
    if (route === "/journalEntries") {
      body = [{ journalEntryId: 1, transactionId: 9, date: "2026-07-02", description: "Salg", lines: [{ account: "1920", amount: 250 }, { account: "3000", amount: -250 }] }];
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "Fiken-Api-Page-Count": "1" } });
  }) as typeof fetch;
  const dataDeps = { fetchImpl, sleep: async () => undefined, now: () => Date.parse("2026-10-10T10:00:00Z") };

  let runnerInputs: unknown[] = [];
  const fakeRunner: ReportScriptRunner = {
    run: async (_script, input) => {
      runnerInputs.push(input);
      const snapshot = input as { data?: { balances?: { accounts: Array<{ change: number }> } } };
      const change = snapshot.data?.balances?.accounts.reduce((sum, account) => sum + account.change, 0) ?? 0;
      return { status: "succeeded", output: { bankChange: change }, outputSha256: "x", runtimeFingerprint: "fp", durationMs: 1, stderrTail: "" };
    },
  };

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur4072-report-data-fetch");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    fikenCalls.length = 0;
    runnerInputs = [];
    await setSwitches({ enableBusinessData: true, enableReporting: true });
  });

  afterEach(async () => {
    await db.delete(reportRuns);
    await db.delete(reportTemplates);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(reportScriptRuns);
    await db.delete(reportFixtures);
    await db.delete(reportScriptVersions);
    await db.delete(reportScripts);
    await db.delete(dataReadEvents);
    await db.delete(dataConnections);
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setSwitches(experimental: Record<string, boolean>) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental });
  }

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Co ${id.slice(0, 8)}`,
      issuePrefix: `R${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedFiken(companyId: string, token: string, slug = "nordstrand-mobler-as") {
    const svc = dataConnectionService(db, dataDeps);
    const created = await svc.create(
      companyId,
      { kind: "fiken", name: "Regnskap", companySlug: slug, credential: { kind: "api_token", apiToken: token }, dailyLookupCap: 300 } as never,
      { userId: "owner" },
    );
    const tested = await svc.test(companyId, created.id, { userId: "owner" });
    expect(tested.status).toBe("active");
    fikenCalls.length = 0;
    return created.id;
  }

  const scriptsFor = () => reportScriptsService(db, { runner: fakeRunner, limiter: new ReportScriptRunLimiter() });

  async function approvedVersion(companyId: string) {
    const scriptsSvc = scriptsFor();
    const script = await scriptsSvc.createScript(companyId, { key: `s-${randomUUID().slice(0, 6)}`, name: "Bank" }, {});
    const version = await scriptsSvc.createVersion(companyId, script.id, { files: { "main.py": "x" }, entrypoint: "main.py", inputSchema: {}, outputSchema: {} }, {});
    await scriptsSvc.createFixture(companyId, version.id, { name: "basic", input: {}, expectedOutput: { bankChange: 0 }, tolerance: 0 });
    await scriptsSvc.requestApproval(companyId, version.id, {});
    const outcome = await scriptsSvc.approveVersion(companyId, version.id, { userId: "owner", sha256: version.sha256 });
    expect(outcome.approved).toBe(true);
    return version;
  }

  const QUERY = {
    period: "last_quarter" as const,
    items: [
      { key: "balances", dataset: "fiken_balances" as const },
      { key: "journal", dataset: "fiken_journal_entries" as const },
    ],
  };

  async function setUp() {
    const companyId = await seedCompany();
    const connectionId = await seedFiken(companyId, TOKEN);
    const version = await approvedVersion(companyId);
    const template = await reportTemplatesService(db).createTemplate(
      companyId,
      { key: "kvartal", name: "Kvartalsrapport", instructions: "i", layout: {}, scriptVersionId: version.id, dataConnectionId: connectionId, dataQuery: QUERY },
      { userId: "owner", canEnable: true },
    );
    runnerInputs = []; // the approval ran the saved example; only report runs count below
    return { companyId, connectionId, version, template };
  }

  it("fetches through the company's connection, audits every read, and stores a hashed snapshot the script gets verbatim", async () => {
    const { companyId, connectionId, template } = await setUp();
    expect(template.dataQuery).toEqual(QUERY);
    const runsSvc = reportRunsService(db, { reportScripts: scriptsFor(), dataDeps });
    const run = await runsSvc.startRun(companyId, template.id, { userId: "owner" });
    expect(run.status, run.error ?? "").toBe("drafting_commentary");
    expect(run.numbers).toEqual({ bankChange: 250 });

    // Last quarter on 10 Oct 2026 = Q3: opening balance 30 Jun, closing 30 Sep; entries 1 Jul - 30 Sep.
    expect(fikenCalls.map((call) => [call.method, call.url.pathname.split("/").pop(), call.url.searchParams.get("date") ?? call.url.searchParams.get("dateGe")])).toEqual([
      ["GET", "accountBalances", "2026-06-30"],
      ["GET", "accountBalances", "2026-09-30"],
      ["GET", "journalEntries", "2026-07-01"],
    ]);
    expect(fikenCalls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);

    const snapshot = run.fetchedData as { period: { label: string }; source: { kind: string }; data: Record<string, unknown>; lookups: Record<string, string> };
    expect(snapshot.period.label).toBe("Q3 2026");
    expect(snapshot.source.kind).toBe("fiken");
    expect(Object.keys(snapshot.data).sort()).toEqual(["balances", "journal"]);
    // The script got exactly the snapshot; its digest is stored and equals the script run's input digest.
    expect(runnerInputs).toHaveLength(1);
    const sha = createHash("sha256").update(JSON.stringify(runnerInputs[0]), "utf8").digest("hex");
    expect(run.fetchedDataSha256).toBe(sha);
    const [scriptRun] = await db.select().from(reportScriptRuns).where(eq(reportScriptRuns.trigger, "report_run"));
    expect(scriptRun!.inputSha256).toBe(sha);

    const events = await db.select().from(dataReadEvents).where(eq(dataReadEvents.channel, "report_run"));
    expect(events.map((event) => [event.dataset, event.outcome, event.connectionId, event.companyId]).sort()).toEqual([
      ["report:fiken_balances", "ok", connectionId, companyId],
      ["report:fiken_journal_entries", "ok", connectionId, companyId],
    ]);
    expect(events.find((event) => event.dataset === "report:fiken_journal_entries")!.facts).toMatchObject({ rows: 1 });
    expect(events.every((event) => (event.params as { reportRunId?: string }).reportRunId === run.id)).toBe(true);
    expect(Object.values(snapshot.lookups).sort()).toEqual(events.map((event) => event.id).sort());

    // The key appears nowhere an agent or the script could see it.
    const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, run.id));
    // The stored snapshot re-serialised with sorted keys gives the stored digest (jsonb does not keep key order).
    expect(sha256OfJson(canonicalizeJson(row!.fetchedData))).toBe(row!.fetchedDataSha256);
    const visible = JSON.stringify([row, events, runnerInputs, scriptRun]);
    expect(visible).not.toContain(TOKEN);
  });

  it("a run can name another period (a redo), resolved on the server", async () => {
    const { companyId, template } = await setUp();
    const runsSvc = reportRunsService(db, { reportScripts: scriptsFor(), dataDeps });
    const run = await runsSvc.startRun(companyId, template.id, { userId: "owner" }, { period: "2026-Q2" });
    expect(run.status).toBe("drafting_commentary");
    expect((run.fetchedData as { period: { from: string; to: string } }).period).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    expect(fikenCalls[0]!.url.searchParams.get("date")).toBe("2026-03-31");
  });

  it("refuses another company's connection at run time even if the template row was changed behind the service's back", async () => {
    const { companyId, template } = await setUp();
    const otherCompany = await seedCompany();
    const otherConnection = await seedFiken(otherCompany, OTHER_TOKEN, "other-company-as");
    await db.update(reportTemplates).set({ dataConnectionId: otherConnection }).where(eq(reportTemplates.id, template.id));
    const runsSvc = reportRunsService(db, { reportScripts: scriptsFor(), dataDeps });
    const run = await runsSvc.startRun(companyId, template.id, { userId: "owner" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not found in this company/);
    expect(fikenCalls).toHaveLength(0);
    expect(runnerInputs).toHaveLength(0);
    // Saving it through the service is refused as well.
    await expect(reportTemplatesService(db).updateTemplate(companyId, template.id, { dataConnectionId: otherConnection }, { canEnable: true })).rejects.toThrow(
      /Data connection not found/,
    );
  });

  it("refuses at save a dataset the connection cannot give", async () => {
    const { companyId, template } = await setUp();
    await expect(
      reportTemplatesService(db).updateTemplate(companyId, template.id, { dataQuery: { period: "last_month", items: [{ key: "sales", dataset: "shopify_sales", groupBy: "none" }] } }, { canEnable: true }),
    ).rejects.toThrow(/cannot give/);
  });

  it("an unapproved calculation reads no data at all", async () => {
    const { companyId, template, version } = await setUp();
    await db.update(reportScriptVersions).set({ status: "retired" }).where(eq(reportScriptVersions.id, version.id));
    const run = await reportRunsService(db, { reportScripts: scriptsFor(), dataDeps }).startRun(companyId, template.id, { userId: "owner" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not been approved/);
    expect(fikenCalls).toHaveLength(0);
    expect(await db.select().from(dataReadEvents).where(eq(dataReadEvents.channel, "report_run"))).toHaveLength(0);
  });

  it("enforces the connection's daily cap (audited) and the instance switch", async () => {
    const { companyId, connectionId, template } = await setUp();
    await db.update(dataConnections).set({ dailyLookupCap: 1 }).where(eq(dataConnections.id, connectionId));
    // Two datasets do not fit a cap of one read a day.
    const runsSvc = reportRunsService(db, { reportScripts: scriptsFor(), dataDeps });
    const capped = await runsSvc.startRun(companyId, template.id, { userId: "owner" });
    expect(capped.status).toBe("failed");
    expect(capped.error).toMatch(/reads for today/);
    expect(fikenCalls).toHaveLength(0);
    const [refusal] = await db.select().from(dataReadEvents).where(eq(dataReadEvents.channel, "report_run"));
    expect(refusal).toMatchObject({ outcome: "rate_limited", refusalCode: "daily_cap" });

    await db.update(dataConnections).set({ dailyLookupCap: 300 }).where(eq(dataConnections.id, connectionId));
    await setSwitches({ enableBusinessData: false, enableReporting: true });
    const off = await runsSvc.startRun(companyId, template.id, { userId: "owner" });
    expect(off.status).toBe("failed");
    expect(off.error).toMatch(/switched off/);
    expect(fikenCalls).toHaveLength(0);
  });

  it("refuses a list over the row cap and records why", async () => {
    const { companyId, template } = await setUp();
    const bigFetch = (async (input: RequestInfo | URL) => {
      fikenCalls.push({ url: new URL(String(input)), method: "GET", auth: null });
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ code: String(i), balance: 1 }))), {
        status: 200,
        headers: { "content-type": "application/json", "Fiken-Api-Page-Count": "600" },
      });
    }) as typeof fetch;
    const run = await reportRunsService(db, { reportScripts: scriptsFor(), dataDeps: { ...dataDeps, fetchImpl: bigFetch } }).startRun(companyId, template.id, { userId: "owner" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/more than|requests/);
    const events = await db.select().from(dataReadEvents).where(eq(dataReadEvents.channel, "report_run"));
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).not.toBe("ok");
    expect(runnerInputs).toHaveLength(0);
  });

  it("allows one data fetch per company at a time, so parallel starts cannot overshoot the daily cap or hit Fiken in parallel", async () => {
    const { companyId, template } = await setUp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstCallMade = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gatedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      entered();
      await gate;
      return fetchImpl(input, init);
    }) as typeof fetch;
    const runsSvc = reportRunsService(db, { reportScripts: scriptsFor(), dataDeps: { ...dataDeps, fetchImpl: gatedFetch } });
    const first = runsSvc.startRun(companyId, template.id, { userId: "owner" });
    await firstCallMade;
    const second = await runsSvc.startRun(companyId, template.id, { userId: "owner" });
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/Another report is reading this company's data right now/);
    release();
    const done = await first;
    expect(done.status, done.error ?? "").toBe("drafting_commentary");
    // Only the first run's three Fiken requests were made.
    expect(fikenCalls).toHaveLength(3);
    const busy = await db.select().from(dataReadEvents).where(eq(dataReadEvents.refusalCode, "fetch_in_progress"));
    expect(busy).toHaveLength(1);
    expect(busy[0]!.outcome).toBe("rate_limited");
    // Once it is done, the next run may fetch again.
    expect((await runsSvc.startRun(companyId, template.id, { userId: "owner" })).status).toBe("drafting_commentary");
  });

  describe("Report run routes", () => {
    const boardActor = (companyId: string, role: "owner" | "admin" | "operator" | "viewer") => ({
      type: "board",
      source: "session",
      userId: `user-${role}`,
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: role }],
    });
    const agentActor = (companyId: string, agentId: string) => ({ type: "agent", agentId, companyId, source: "agent_key", runId: null });

    function createApp(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as express.Request & { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", reportTemplateRoutes(db, { reportScripts: scriptsFor(), dataDeps }));
      app.use(errorHandler);
      return app;
    }

    it("only an owner/admin sees a run's fetched data; agents and viewers get status, numbers and the digest", async () => {
      const { companyId, template } = await setUp();
      const agent = await agentService(db).create(companyId, {
        name: `A-${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "echo" },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      const started = await request(createApp(agentActor(companyId, agent.id))).post(`/api/companies/${companyId}/report-runs`).send({ templateId: template.id });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      expect(started.body.status).toBe("drafting_commentary");
      expect(started.body.fetchedData).toBeNull();
      const runId = started.body.id as string;

      for (const actor of [agentActor(companyId, agent.id), boardActor(companyId, "viewer"), boardActor(companyId, "operator")]) {
        const app = createApp(actor);
        const one = await request(app).get(`/api/companies/${companyId}/report-runs/${runId}`);
        expect(one.status).toBe(200);
        expect(one.body.fetchedData).toBeNull();
        expect(one.body.numbers).toEqual({ bankChange: 250 });
        expect(one.body.fetchedDataSha256).toMatch(/^[0-9a-f]{64}$/);
        const list = await request(app).get(`/api/companies/${companyId}/report-runs`);
        expect(list.status).toBe(200);
        expect(list.body.map((run: { fetchedData: unknown }) => run.fetchedData)).toEqual([null]);
        expect(JSON.stringify([one.body, list.body])).not.toContain("journalEntryId");
      }

      for (const role of ["owner", "admin"] as const) {
        const app = createApp(boardActor(companyId, role));
        const one = await request(app).get(`/api/companies/${companyId}/report-runs/${runId}`);
        expect(one.body.fetchedData).toMatchObject({ data: { journal: { entries: [expect.objectContaining({ journalEntryId: 1 })] } } });
        const list = await request(app).get(`/api/companies/${companyId}/report-runs`);
        expect(list.body[0].fetchedData).not.toBeNull();
      }
    });
  });

  describe("Preview data route", () => {
    const boardActor = (companyId: string, role: "owner" | "admin" | "operator" | "viewer") => ({
      type: "board",
      source: "session",
      userId: `user-${role}`,
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: role }],
    });
    const agentActor = (companyId: string) => ({ type: "agent", agentId: randomUUID(), companyId, source: "agent_key", runId: null });

    function createApp(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as express.Request & { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", reportTemplateRoutes(db, { reportScripts: scriptsFor(), dataDeps }));
      app.use(errorHandler);
      return app;
    }

    it("an owner sees counts and the first rows; the read is audited as a preview", async () => {
      const { companyId, connectionId } = await setUp();
      const response = await request(createApp(boardActor(companyId, "owner")))
        .post(`/api/companies/${companyId}/report-data/preview`)
        .send({ dataConnectionId: connectionId, dataQuery: QUERY, period: "2026-Q3" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ connectionName: "Regnskap", kindLabel: "Fiken", period: { label: "Q3 2026" } });
      expect(response.body.items).toEqual([
        expect.objectContaining({ key: "balances", ok: true, rowCount: 1, sampleRows: [expect.objectContaining({ code: "1920", opening: 100, closing: 350 })] }),
        expect.objectContaining({ key: "journal", ok: true, rowCount: 1 }),
      ]);
      expect(response.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
      const events = await db.select().from(dataReadEvents).where(eq(dataReadEvents.channel, "report_preview"));
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.userId === "user-owner")).toBe(true);
    });

    it("is refused for a member who is not owner/admin, for an agent, and while reporting is off", async () => {
      const { companyId, connectionId } = await setUp();
      const body = { dataConnectionId: connectionId, dataQuery: QUERY };
      const operator = await request(createApp(boardActor(companyId, "operator"))).post(`/api/companies/${companyId}/report-data/preview`).send(body);
      expect(operator.status).toBe(403);
      const agent = await request(createApp(agentActor(companyId))).post(`/api/companies/${companyId}/report-data/preview`).send(body);
      expect(agent.status).toBe(403);
      await setSwitches({ enableBusinessData: true, enableReporting: false });
      const off = await request(createApp(boardActor(companyId, "owner"))).post(`/api/companies/${companyId}/report-data/preview`).send(body);
      expect(off.status).toBe(404);
      expect(fikenCalls).toHaveLength(0);
      expect(await db.select().from(dataReadEvents).where(eq(dataReadEvents.channel, "report_preview"))).toHaveLength(0);
    });

    it("cannot preview another company's connection", async () => {
      const { companyId } = await setUp();
      const otherCompany = await seedCompany();
      const otherConnection = await seedFiken(otherCompany, OTHER_TOKEN, "other-company-as");
      const response = await request(createApp(boardActor(companyId, "owner")))
        .post(`/api/companies/${companyId}/report-data/preview`)
        .send({ dataConnectionId: otherConnection, dataQuery: QUERY });
      expect(response.status).toBe(404);
      expect(fikenCalls).toHaveLength(0);
    });
  });
});
