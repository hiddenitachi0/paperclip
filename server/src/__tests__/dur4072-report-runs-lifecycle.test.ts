import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  companySecrets,
  createDb,
  dataConnections,
  documentRevisions,
  documents,
  reportFixtures,
  reportRuns,
  reportScriptRuns,
  reportScripts,
  reportScriptVersions,
  reportTemplates,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ReportScriptRunLimiter, reportScriptsService } from "../services/report-scripts.js";
import { reportTemplatesService } from "../services/report-templates.js";
import { reportRunsService } from "../services/report-runs.js";
import type { ReportScriptRunner } from "../services/report-script-runner.js";

/**
 * DUR-4072 PR2 acceptance: the full ordinary-task path -- fetch data, run the
 * template's pinned script, get numbers, draft commentary, and only a
 * commentary draft whose numbers all come from the script output ever
 * reaches a report document.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4072 report run lifecycle tests: ${support.reason ?? "unsupported environment"}`);
}

d("DUR-4072 report run lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  let companyId: string;

  const fakeRunner: ReportScriptRunner = {
    run: async (_script, input) => {
      const rows = (input as { rows: Array<{ amount: number }> }).rows;
      return {
        status: "succeeded",
        output: { total: rows.reduce((sum, r) => sum + r.amount, 0), count: rows.length },
        outputSha256: "fakehash",
        runtimeFingerprint: "fp",
        durationMs: 1,
        stderrTail: "",
      };
    },
  };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("dur4072-report-runs");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(reportRuns);
    await db.delete(reportTemplates);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(reportScriptRuns);
    await db.delete(reportFixtures);
    await db.delete(reportScriptVersions);
    await db.delete(reportScripts);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  const scriptsFor = () => reportScriptsService(db, { runner: fakeRunner, limiter: new ReportScriptRunLimiter() });

  async function insertCompany(id: string) {
    await db.insert(companies).values({
      id,
      name: `Test Co ${id.slice(0, 8)}`,
      issuePrefix: `Q${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function setUpApprovedTemplate() {
    companyId = randomUUID();
    await insertCompany(companyId);

    const scriptsSvc = scriptsFor();
    const script = await scriptsSvc.createScript(companyId, { key: "sales-sum", name: "Sales sum" }, {});
    const version = await scriptsSvc.createVersion(
      companyId,
      script.id,
      { files: { "main.py": "x" }, entrypoint: "main.py", inputSchema: {}, outputSchema: {} },
      {},
    );
    // Approval first: a saved example, the approval card, then the owner's
    // approve action (which runs the example). The route-level owner check
    // is covered in dur4072-report-script-approval-first.test.ts.
    await scriptsSvc.createFixture(companyId, version.id, {
      name: "basic",
      input: { rows: [{ amount: 1 }] },
      expectedOutput: { total: 1, count: 1 },
      tolerance: 0,
    });
    await scriptsSvc.requestApproval(companyId, version.id, {});
    const outcome = await scriptsSvc.approveVersion(companyId, version.id, { userId: "filip", sha256: version.sha256 });
    expect(outcome.approved).toBe(true);

    const templatesSvc = reportTemplatesService(db);
    const template = await templatesSvc.createTemplate(
      companyId,
      { key: "weekly-sales", name: "Weekly sales", instructions: "Summarise sales.", layout: {}, scriptVersionId: version.id },
      { userId: "filip", canEnable: true },
    );
    return { templatesSvc, scriptsSvc, template, version };
  }

  it("refuses to attach a template to a script version that is not approved", async () => {
    companyId = randomUUID();
    await insertCompany(companyId);
    const scriptsSvc = scriptsFor();
    const script = await scriptsSvc.createScript(companyId, { key: "draft-script", name: "Draft" }, {});
    const version = await scriptsSvc.createVersion(companyId, script.id, { files: { "main.py": "x" }, entrypoint: "main.py", inputSchema: {}, outputSchema: {} }, {});
    const templatesSvc = reportTemplatesService(db);
    await expect(
      templatesSvc.createTemplate(companyId, { key: "t", name: "T", instructions: "i", layout: {}, scriptVersionId: version.id }, {}),
    ).rejects.toThrow(/approved/i);
  });

  it("fetches data, runs the pinned script, and stores the numbers verbatim", async () => {
    const { template } = await setUpApprovedTemplate();
    const scriptsSvc = scriptsFor();
    const runsSvc = reportRunsService(db, {
      reportScripts: scriptsSvc,
      fetchData: async () => ({ rows: [{ amount: 100 }, { amount: 50 }] }),
    });
    const run = await runsSvc.startRun(companyId, template.id, {});
    expect(run.status).toBe("drafting_commentary");
    expect(run.numbers).toEqual({ total: 150, count: 2 });
  });

  it("rejects commentary with a number not in the script output, and never writes a document for it", async () => {
    const { template } = await setUpApprovedTemplate();
    const scriptsSvc = scriptsFor();
    const runsSvc = reportRunsService(db, {
      reportScripts: scriptsSvc,
      fetchData: async () => ({ rows: [{ amount: 100 }, { amount: 50 }] }),
    });
    const run = await runsSvc.startRun(companyId, template.id, {});
    const revised = await runsSvc.draftCommentary(companyId, run.id, "Sales totalled 999 this week.", {});
    expect(revised.status).toBe("needs_revision");
    expect(revised.ungroundedNumbers).toContain("999");
    expect(revised.documentId).toBeNull();
  });

  it("accepts grounded commentary and creates a report document with a revision", async () => {
    const { template } = await setUpApprovedTemplate();
    const scriptsSvc = scriptsFor();
    const runsSvc = reportRunsService(db, {
      reportScripts: scriptsSvc,
      fetchData: async () => ({ rows: [{ amount: 100 }, { amount: 50 }] }),
    });
    const run = await runsSvc.startRun(companyId, template.id, {});
    const ready = await runsSvc.draftCommentary(companyId, run.id, "Sales totalled 150 across 2 orders this week.", {});
    expect(ready.status).toBe("ready");
    expect(ready.documentId).not.toBeNull();

    const revisions = await db.select().from(documentRevisions);
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.body).toContain("150");

    // A second grounded draft on the same run revises the same document.
    const revisedReady = await runsSvc.draftCommentary(companyId, run.id, "Sales totalled 150 across 2 orders.", {});
    expect(revisedReady.documentId).toBe(ready.documentId);
  });

  it("fails the run cleanly when no data source is wired for the template", async () => {
    const { template } = await setUpApprovedTemplate();
    const scriptsSvc = scriptsFor();
    const runsSvc = reportRunsService(db, { reportScripts: scriptsSvc });
    const run = await runsSvc.startRun(companyId, template.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/data source/i);
  });

  it("never runs a version that is no longer approved: the run fails and the runner is not called", async () => {
    const { template, version } = await setUpApprovedTemplate();
    await db.update(reportScriptVersions).set({ status: "retired" }).where(eq(reportScriptVersions.id, version.id));
    let calls = 0;
    const scriptsSvc = reportScriptsService(db, {
      runner: { run: async (...args) => { calls += 1; return fakeRunner.run(...args); } },
      limiter: new ReportScriptRunLimiter(),
    });
    const runsSvc = reportRunsService(db, { reportScripts: scriptsSvc, fetchData: async () => ({ rows: [] }) });
    const run = await runsSvc.startRun(companyId, template.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not been approved/);
    expect(calls).toBe(0);
  });

  it("re-checks the approved code's digest from the database before a report run", async () => {
    const { template, version } = await setUpApprovedTemplate();
    await db.update(reportScriptVersions).set({ files: { "main.py": "print('tampered')" } }).where(eq(reportScriptVersions.id, version.id));
    let calls = 0;
    const scriptsSvc = reportScriptsService(db, {
      runner: { run: async (...args) => { calls += 1; return fakeRunner.run(...args); } },
      limiter: new ReportScriptRunLimiter(),
    });
    const runsSvc = reportRunsService(db, { reportScripts: scriptsSvc, fetchData: async () => ({ rows: [] }) });
    const run = await runsSvc.startRun(companyId, template.id, {});
    expect(run.status).toBe("failed");
    expect(calls).toBe(0);
    const [scriptRun] = await db.select().from(reportScriptRuns).where(eq(reportScriptRuns.trigger, "report_run"));
    expect(scriptRun!.status).toBe("fingerprint_mismatch");
  });

  it("report runs count against the company's hourly calculation budget", async () => {
    const { template } = await setUpApprovedTemplate();
    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner, limiter: new ReportScriptRunLimiter(), maxRunsPerHour: 2 });
    const runsSvc = reportRunsService(db, { reportScripts: scriptsSvc, fetchData: async () => ({ rows: [{ amount: 1 }] }) });
    // 1 run was the approval check; one more fits.
    expect((await runsSvc.startRun(companyId, template.id, {})).status).toBe("drafting_commentary");
    const over = await runsSvc.startRun(companyId, template.id, {});
    expect(over.status).toBe("failed");
    expect(over.error).toMatch(/calculation runs for the last hour/);
  });

  it("refuses a template that names another company's data connection", async () => {
    const { templatesSvc, version } = await setUpApprovedTemplate();
    const otherCompanyId = randomUUID();
    await insertCompany(otherCompanyId);
    const [secret] = await db.insert(companySecrets).values({ companyId: otherCompanyId, key: "shop-key", name: "Shop key" }).returning();
    const [conn] = await db
      .insert(dataConnections)
      .values({
        companyId: otherCompanyId,
        kind: "shopify",
        name: "Other shop",
        shopDomain: "other.myshopify.com",
        apiVersion: "2026-07",
        credentialKind: "admin_access_token",
        credentialSecretId: secret!.id,
      })
      .returning();
    await expect(
      templatesSvc.createTemplate(
        companyId,
        { key: "cross", name: "Cross", instructions: "i", layout: {}, scriptVersionId: version.id, dataConnectionId: conn!.id },
        {},
      ),
    ).rejects.toThrow(/Data connection not found/);
  });

  it("only an owner/admin can switch a template on: drafts by others start off, and re-pointing switches it off", async () => {
    const { templatesSvc, template, version } = await setUpApprovedTemplate();
    expect(template.isActive).toBe(true);

    const drafted = await templatesSvc.createTemplate(
      companyId,
      { key: "agent-draft", name: "Agent draft", instructions: "i", layout: {}, scriptVersionId: version.id },
      { agentId: undefined },
    );
    expect(drafted.isActive).toBe(false);
    await expect(templatesSvc.updateTemplate(companyId, drafted.id, { isActive: true }, {})).rejects.toThrow(/owner or an admin/);
    const runsSvc = reportRunsService(db, { reportScripts: scriptsFor(), fetchData: async () => ({ rows: [] }) });
    await expect(runsSvc.startRun(companyId, drafted.id, {})).rejects.toThrow(/switched off/);

    const enabled = await templatesSvc.updateTemplate(companyId, drafted.id, { isActive: true }, { canEnable: true });
    expect(enabled.isActive).toBe(true);

    // Harmless edits by a non-owner leave it on...
    const renamed = await templatesSvc.updateTemplate(companyId, template.id, { name: "Renamed" }, {});
    expect(renamed.isActive).toBe(true);
    // ...but re-pointing it at different data switches it off until an owner/admin re-enables it.
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "own-shop-key", name: "Own shop key" }).returning();
    const [conn] = await db
      .insert(dataConnections)
      .values({
        companyId,
        kind: "shopify",
        name: "Own shop",
        shopDomain: "own.myshopify.com",
        apiVersion: "2026-07",
        credentialKind: "admin_access_token",
        credentialSecretId: secret!.id,
      })
      .returning();
    const repointed = await templatesSvc.updateTemplate(companyId, template.id, { dataConnectionId: conn!.id }, {});
    expect(repointed.isActive).toBe(false);
  });
});
