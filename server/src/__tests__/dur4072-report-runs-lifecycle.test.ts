import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
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
import { reportScriptsService } from "../services/report-scripts.js";
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
    ensureRuntime: async () => ({ runtimeDir: "/tmp/x", fingerprint: "fp", hasVenv: false }),
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
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function setUpApprovedTemplate() {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", slug: `test-co-${companyId.slice(0, 8)}` });

    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner });
    const script = await scriptsSvc.createScript(companyId, { key: "sales-sum", name: "Sales sum" }, {});
    const version = await scriptsSvc.createVersion(
      companyId,
      script.id,
      { files: { "main.py": "x" }, entrypoint: "main.py", lockfile: null },
      {},
    );
    // A version can only be approved once it is 'tested' -- pass a fixture
    // first, the same prerequisite PR1's approval gate enforces.
    const fixture = await scriptsSvc.createFixture(companyId, version.id, {
      name: "basic",
      input: { rows: [{ amount: 1 }] },
      expectedOutput: { total: 1, count: 1 },
      tolerance: 0,
    });
    await scriptsSvc.runFixture(companyId, version.id, fixture.id, {});
    // Approval is the ticket's "never live without Filip's approval" gate --
    // bypass the route's board-owner check here since this test is about the
    // run lifecycle, not that gate (PR1's tests cover the gate itself).
    await scriptsSvc.approveVersion(companyId, version.id, { userId: "filip" });

    const templatesSvc = reportTemplatesService(db);
    const template = await templatesSvc.createTemplate(
      companyId,
      { key: "weekly-sales", name: "Weekly sales", instructions: "Summarise sales.", layout: {}, scriptVersionId: version.id },
      {},
    );
    return { templatesSvc, scriptsSvc, template };
  }

  it("refuses to attach a template to a script version that is not approved", async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", slug: `test-co-${companyId.slice(0, 8)}` });
    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner });
    const script = await scriptsSvc.createScript(companyId, { key: "draft-script", name: "Draft" }, {});
    const version = await scriptsSvc.createVersion(companyId, script.id, { files: { "main.py": "x" }, entrypoint: "main.py", lockfile: null }, {});
    const templatesSvc = reportTemplatesService(db);
    await expect(
      templatesSvc.createTemplate(companyId, { key: "t", name: "T", instructions: "i", layout: {}, scriptVersionId: version.id }, {}),
    ).rejects.toThrow(/approved/i);
  });

  it("fetches data, runs the pinned script, and stores the numbers verbatim", async () => {
    const { template } = await setUpApprovedTemplate();
    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner });
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
    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner });
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
    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner });
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
    const scriptsSvc = reportScriptsService(db, { runner: fakeRunner });
    const runsSvc = reportRunsService(db, { reportScripts: scriptsSvc });
    const run = await runsSvc.startRun(companyId, template.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/data source/i);
  });
});
