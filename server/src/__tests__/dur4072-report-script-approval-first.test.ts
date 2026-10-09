import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  approvals,
  companies,
  createDb,
  instanceSettings,
  reportScriptRuns,
  reportScriptVersions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { reportScriptRoutes } from "../routes/report-scripts.js";
import { approvalRoutes } from "../routes/approvals.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import {
  REPORT_SCRIPT_APPROVAL_KIND,
  ReportScriptRunLimiter,
  reportScriptsService,
  type ReportScriptsServiceDeps,
} from "../services/report-scripts.js";
import type { ReportScriptRunner, ScriptFilesInput } from "../services/report-script-runner.js";

/**
 * DUR-4072 security fixes (Security Reviewer, PR #557):
 *   - APPROVAL FIRST: no agent-authored code runs -- not even a fixture --
 *     before a company owner/admin (a person) approves that exact digest;
 *   - the owner's approve action runs every fixture and refuses on failure;
 *   - stdlib only: pyproject/lockfile/requirements are refused;
 *   - the digest is re-verified from the DATABASE row before every run;
 *   - per-company concurrency and an hourly run budget.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4072 approval-first tests: ${support.reason ?? "unsupported environment"}`);
}

const SUM_SCRIPT = "import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({'total': sum(d['rows'])}))\n";

/** A runner that never executes anything; it records every call so tests can prove "nothing ran". */
function spyRunner(behaviour: (script: ScriptFilesInput, input: unknown) => unknown = (_s, input) => ({
  total: ((input as { rows: number[] }).rows ?? []).reduce((a, b) => a + b, 0),
})) {
  const calls: Array<{ script: ScriptFilesInput; input: unknown }> = [];
  let gate: Promise<void> | null = null;
  const runner: ReportScriptRunner = {
    run: async (script, input) => {
      calls.push({ script, input });
      if (gate) await gate;
      const output = behaviour(script, input);
      return { status: "succeeded", output, outputSha256: "x", runtimeFingerprint: "fp", durationMs: 1, stderrTail: "" };
    },
  };
  return {
    runner,
    calls,
    block() {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

d("DUR-4072 report scripts: approval first", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("dur4072-approval-first");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(async () => {
    await setFlag(true);
  });

  afterEach(async () => {
    // Approving a card wakes the agent that asked (heartbeat rows etc.);
    // truncating companies clears every company-owned row in one go.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function setFlag(enabled: boolean) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableReporting: enabled } });
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    return agentService(db).create(companyId, {
      name: `A-${randomUUID().slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  const boardActor = (companyId: string, role: "owner" | "admin" | "operator" | "viewer", userId = `user-${role}`) => ({
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: role }],
  });
  const agentActor = (companyId: string, agentId: string) => ({ type: "agent", agentId, companyId, source: "agent_key", runId: null });

  function createApp(actor: Record<string, unknown>, deps: ReportScriptsServiceDeps) {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", reportScriptRoutes(db, deps));
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** An agent drafts a script, one version and one fixture, then asks for approval. */
  async function agentDrafts(deps: ReportScriptsServiceDeps, expectedTotal = 6) {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(agentActor(companyId, agent.id), deps);
    const base = `/api/companies/${companyId}/report-scripts`;
    const script = await request(app).post(base).send({ key: "sum", name: "Sum" });
    expect(script.status).toBe(201);
    const version = await request(app).post(`${base}/${script.body.id}/versions`).send({ files: { "main.py": SUM_SCRIPT } });
    expect(version.status).toBe(201);
    expect(version.body.status).toBe("draft");
    const fixture = await request(app)
      .post(`${base}/versions/${version.body.id}/fixtures`)
      .send({ name: "q1", input: { rows: [1, 2, 3] }, expectedOutput: { total: expectedTotal } });
    expect(fixture.status).toBe(201);
    return { companyId, agent, app, base, scriptId: script.body.id as string, version: version.body, fixtureId: fixture.body.id as string };
  }

  it("an agent can draft but no code runs: run-fixture is refused before approval and the runner is never called", async () => {
    const spy = spyRunner();
    const { app, base, version, fixtureId } = await agentDrafts({ runner: spy.runner, limiter: new ReportScriptRunLimiter() });

    const run = await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId });
    expect(run.status).toBe(422);
    expect(run.body.details?.code ?? run.body.code).toBe("report_script_not_approved");

    // Asking for approval files a card with the full source; still nothing runs.
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    expect(asked.status).toBe(201);
    const run2 = await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId });
    expect(run2.status).toBe(422);

    expect(spy.calls).toHaveLength(0);
    expect(await db.select().from(reportScriptRuns)).toHaveLength(0);
  });

  it("the approval card shows the full source, the exact digest and a plain trust warning", async () => {
    const spy = spyRunner();
    const { app, base, version } = await agentDrafts({ runner: spy.runner, limiter: new ReportScriptRunLimiter() });
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({ note: "Q1 numbers" });
    expect(asked.status).toBe(201);
    const [card] = await db.select().from(approvals).where(eq(approvals.id, asked.body.approvalId));
    const payload = card!.payload as Record<string, unknown>;
    expect(card!.type).toBe("request_board_approval");
    expect(card!.status).toBe("pending");
    expect(payload.kind).toBe(REPORT_SCRIPT_APPROVAL_KIND);
    expect(payload.files).toEqual({ "main.py": SUM_SCRIPT });
    expect(payload.sha256).toBe(version.sha256);
    expect(String(payload.trustWarning)).toMatch(/server's own access/);
    expect(asked.body.version.status).toBe("awaiting_approval");
  });

  it("agents and non-owner members cannot approve; nothing runs", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version } = await agentDrafts(deps);
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});

    const byAgent = await request(app).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 });
    expect(byAgent.status).toBe(403);
    const byAgentCard = await request(app).post(`/api/approvals/${asked.body.approvalId}/approve`).send({});
    expect(byAgentCard.status).toBe(403);

    for (const role of ["operator", "viewer"] as const) {
      const memberApp = createApp(boardActor(companyId, role), deps);
      const res = await request(memberApp).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 });
      expect(res.status).toBe(403);
      const viaCard = await request(memberApp).post(`/api/approvals/${asked.body.approvalId}/approve`).send({});
      expect(viaCard.status).toBe(403);
    }
    expect(spy.calls).toHaveLength(0);
    const [v] = await db.select().from(reportScriptVersions).where(eq(reportScriptVersions.id, version.id));
    expect(v!.status).toBe("awaiting_approval");
  });

  it("the approvals service refuses to mark the card approved unless the version itself was approved (every approve path)", async () => {
    const spy = spyRunner();
    const { app, base, version } = await agentDrafts({ runner: spy.runner, limiter: new ReportScriptRunLimiter() });
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    await expect(approvalService(db).approve(asked.body.approvalId, "someone")).rejects.toThrow(/owner or admin/);
    const [card] = await db.select().from(approvals).where(eq(approvals.id, asked.body.approvalId));
    expect(card!.status).toBe("pending");
    expect(spy.calls).toHaveLength(0);
  });

  it("approving with a digest other than the version's refuses and runs nothing", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version } = await agentDrafts(deps);
    await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    const owner = createApp(boardActor(companyId, "owner"), deps);
    const res = await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: "f".repeat(64) });
    expect(res.status).toBe(409);
    expect(spy.calls).toHaveLength(0);
  });

  it("approval without a filed card is refused (the card must show the source first)", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, base, version } = await agentDrafts(deps);
    const owner = createApp(boardActor(companyId, "owner"), deps);
    const res = await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 });
    expect(res.status).toBe(422);
    expect(spy.calls).toHaveLength(0);
  });

  it("the owner's approve action runs every fixture; a failing fixture refuses activation and shows results on the card", async () => {
    const spy = spyRunner(() => ({ total: 999 }));
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version, fixtureId } = await agentDrafts(deps);
    await request(app)
      .post(`${base}/versions/${version.id}/fixtures`)
      .send({ name: "q2", input: { rows: [5] }, expectedOutput: { total: 999 } });
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    const owner = createApp(boardActor(companyId, "owner"), deps);

    const res = await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/1 of 2 saved examples did not match/);
    expect(spy.calls).toHaveLength(2);

    const [v] = await db.select().from(reportScriptVersions).where(eq(reportScriptVersions.id, version.id));
    expect(v!.status).toBe("awaiting_approval");
    expect(v!.approvedByUserId).toBeNull();
    const [card] = await db.select().from(approvals).where(eq(approvals.id, asked.body.approvalId));
    expect(card!.status).toBe("pending");
    const results = (card!.payload as { fixtureResults: Array<{ fixtureId: string; ok: boolean; summary: string; diffs: unknown[] }> }).fixtureResults;
    const failed = results.find((r) => r.fixtureId === fixtureId)!;
    expect(failed.ok).toBe(false);
    expect(failed.summary).toMatch(/did not match/);
    expect(failed.diffs).toEqual([{ path: "total", expected: 6, actual: 999 }]);
    const runs = await db.select().from(reportScriptRuns);
    expect(runs.every((r) => r.trigger === "approval_check")).toBe(true);
  });

  it("the owner's approve action switches the version on only when every fixture matches, and closes the card", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version, fixtureId } = await agentDrafts(deps);
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    const owner = createApp(boardActor(companyId, "admin"), deps);

    const res = await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 });
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);
    expect(res.body.version.status).toBe("approved");
    expect(res.body.fixtureResults).toHaveLength(1);
    expect(spy.calls).toHaveLength(1);
    const [card] = await db.select().from(approvals).where(eq(approvals.id, asked.body.approvalId));
    expect(card!.status).toBe("approved");

    // After approval an agent may re-run a fixture.
    const rerun = await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId });
    expect(rerun.status).toBe(200);
    expect(rerun.body.status).toBe("succeeded");
  });

  it("approving from the approval card (generic approvals route) runs the fixtures first", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version } = await agentDrafts(deps);
    const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    // The generic approvals route builds its own report-scripts service with
    // the real runner, so this test uses a fixture the real python3 passes.
    const owner = createApp(boardActor(companyId, "owner"), deps);
    const res = await request(owner).post(`/api/approvals/${asked.body.approvalId}/approve`).send({});
    expect(res.status).toBe(200);
    const [v] = await db.select().from(reportScriptVersions).where(eq(reportScriptVersions.id, version.id));
    expect(v!.status).toBe("approved");
    const runs = await db.select().from(reportScriptRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("approval_check");
    expect(runs[0]!.status).toBe("succeeded");
  });

  it("refuses pyproject.toml, lockfiles and requirements files -- at the route and in the service", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, scriptId } = await agentDrafts(deps);
    for (const body of [
      { files: { "main.py": "print(1)", "pyproject.toml": "[project]\nname='x'" } },
      { files: { "main.py": "print(1)", "uv.lock": "version = 1" } },
      { files: { "main.py": "print(1)", "requirements.txt": "requests" } },
      { files: { "main.py": "print(1)" }, lockfile: "version = 1" },
    ]) {
      const res = await request(app).post(`${base}/${scriptId}/versions`).send(body);
      expect(res.status).toBe(400);
    }
    const svc = reportScriptsService(db, deps);
    await expect(
      svc.createVersion(companyId, scriptId, { files: { "main.py": "x", "pyproject.toml": "" }, entrypoint: "main.py", inputSchema: {}, outputSchema: {} }, {}),
    ).rejects.toThrow(/standard library/);
    await expect(
      svc.createVersion(
        companyId,
        scriptId,
        { files: { "main.py": "x" }, entrypoint: "main.py", inputSchema: {}, outputSchema: {}, lockfile: "x" } as never,
        {},
      ),
    ).rejects.toThrow(/standard library/);
  });

  it("re-verifies the digest from the database before every run: a changed row never executes", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version, fixtureId } = await agentDrafts(deps);
    await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    const owner = createApp(boardActor(companyId, "owner"), deps);
    expect((await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 })).status).toBe(200);
    expect(spy.calls).toHaveLength(1);

    // Someone edits the stored code after approval (sha256 column untouched).
    await db
      .update(reportScriptVersions)
      .set({ files: { "main.py": "import os; print(os.environ)" } })
      .where(eq(reportScriptVersions.id, version.id));
    const rerun = await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId });
    expect(rerun.status).toBe(200);
    expect(rerun.body.status).toBe("fingerprint_mismatch");
    expect(spy.calls).toHaveLength(1);
  });

  it("a stored-code change before approval is caught too: approve refuses and runs nothing", async () => {
    const spy = spyRunner();
    const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
    const { companyId, app, base, version } = await agentDrafts(deps);
    await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    await db
      .update(reportScriptVersions)
      .set({ files: { "main.py": "print('{}')" } })
      .where(eq(reportScriptVersions.id, version.id));
    const owner = createApp(boardActor(companyId, "owner"), deps);
    const res = await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 });
    expect(res.status).toBe(409);
    expect(spy.calls).toHaveLength(0);
  });

  it("limits concurrent runs per company and the number of runs per hour", async () => {
    const spy = spyRunner();
    const limiter = new ReportScriptRunLimiter(1, 4);
    const deps = { runner: spy.runner, limiter, maxRunsPerHour: 3 };
    const { companyId, app, base, version, fixtureId } = await agentDrafts(deps);
    await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
    const owner = createApp(boardActor(companyId, "owner"), deps);
    expect((await request(owner).post(`${base}/versions/${version.id}/approve`).send({ sha256: version.sha256 })).status).toBe(200);

    const release = spy.block();
    const first = request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId }).then((r) => r);
    // Wait until the first run is inside the runner (holding the slot).
    for (let i = 0; i < 100 && spy.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(limiter.active(companyId)).toBe(1);
    const second = await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId });
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect(limiter.active(companyId)).toBe(0);

    // 2 runs used (approval + first); one more fits, the next is over the hourly budget.
    expect((await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId })).status).toBe(200);
    const over = await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/3 calculation runs/);
  });

  it("everything answers 404 while reporting is switched off", async () => {
    const spy = spyRunner();
    const { app, base, version, fixtureId } = await agentDrafts({ runner: spy.runner, limiter: new ReportScriptRunLimiter() });
    await setFlag(false);
    expect((await request(app).get(base)).status).toBe(404);
    expect((await request(app).post(`${base}/versions/${version.id}/run-fixture`).send({ fixtureId })).status).toBe(404);
    expect(spy.calls).toHaveLength(0);
  });

  describe("forged approval cards (DUR-4698 re-review)", () => {
    function forgedPayload(version: { id: string; sha256: string }) {
      return {
        kind: REPORT_SCRIPT_APPROVAL_KIND,
        title: "Approve calculation (looks harmless)",
        versionId: version.id,
        sha256: version.sha256,
        entrypoint: "main.py",
        files: { "main.py": "print('{\"total\": 6}')" },
      };
    }

    it("an agent cannot file a report_script_version card through the generic approvals route (422)", async () => {
      const spy = spyRunner();
      const { companyId, app, base, version } = await agentDrafts({ runner: spy.runner, limiter: new ReportScriptRunLimiter() });
      await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
      const forged = await request(app)
        .post(`/api/companies/${companyId}/approvals`)
        .send({ type: "request_board_approval", payload: forgedPayload(version) });
      expect(forged.status).toBe(422);
      const cards = await db.select().from(approvals);
      expect(cards).toHaveLength(1);
      // The service refuses it too, for any other caller.
      await expect(
        approvalService(db).create(companyId, { type: "request_board_approval", payload: forgedPayload(version) }),
      ).rejects.toThrow(/asking for approval on the calculation/);
      expect(spy.calls).toHaveLength(0);
    });

    it("resubmitting a report_script_version card is refused, so its code cannot be swapped (422)", async () => {
      const spy = spyRunner();
      const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
      const { companyId, app, base, version } = await agentDrafts(deps);
      const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
      const owner = createApp(boardActor(companyId, "owner"), deps);
      const sentBack = await request(owner).post(`/api/approvals/${asked.body.approvalId}/request-revision`).send({ decisionNote: "explain" });
      expect(sentBack.status).toBe(200);
      const resubmit = await request(app)
        .post(`/api/approvals/${asked.body.approvalId}/resubmit`)
        .send({ payload: forgedPayload(version) });
      expect(resubmit.status).toBe(422);
      await expect(approvalService(db).resubmit(asked.body.approvalId, forgedPayload(version))).rejects.toThrow(/asking for approval/);
      const [card] = await db.select().from(approvals).where(eq(approvals.id, asked.body.approvalId));
      expect((card!.payload as { files: unknown }).files).toEqual({ "main.py": SUM_SCRIPT });

      // The supported way back: ask for approval again -> same card reopened, rebuilt from the stored code.
      const again = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
      expect(again.status).toBe(201);
      expect(again.body.approvalId).toBe(asked.body.approvalId);
      const [reopened] = await db.select().from(approvals).where(eq(approvals.id, asked.body.approvalId));
      expect(reopened!.status).toBe("pending");
      expect((reopened!.payload as { files: unknown }).files).toEqual({ "main.py": SUM_SCRIPT });
      expect(spy.calls).toHaveLength(0);
    });

    it("approving a card that is not the version's own approval card is refused and runs nothing", async () => {
      const spy = spyRunner();
      const deps = { runner: spy.runner, limiter: new ReportScriptRunLimiter() };
      const { companyId, app, base, version } = await agentDrafts(deps);
      const asked = await request(app).post(`${base}/versions/${version.id}/request-approval`).send({});
      // A forged card that slipped in some other way (e.g. a direct row).
      const [forged] = await db
        .insert(approvals)
        .values({ companyId, type: "request_board_approval", status: "pending", payload: forgedPayload(version) })
        .returning();
      const owner = createApp(boardActor(companyId, "owner"), deps);
      const res = await request(owner).post(`/api/approvals/${forged!.id}/approve`).send({});
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not the approval card of any calculation version/);
      await expect(approvalService(db).approve(forged!.id, "owner")).rejects.toThrow(/owner or admin/);
      expect(spy.calls).toHaveLength(0);
      const [v] = await db.select().from(reportScriptVersions).where(eq(reportScriptVersions.id, version.id));
      expect(v!.status).toBe("awaiting_approval");

      // The card UI reads the code from the stored version: the forged card has none,
      // the genuine card returns the stored code.
      const forgedSource = await request(owner).get(`${base}/approval-cards/${forged!.id}`);
      expect(forgedSource.status).toBe(404);
      const realSource = await request(owner).get(`${base}/approval-cards/${asked.body.approvalId}`);
      expect(realSource.status).toBe(200);
      expect(realSource.body.files).toEqual({ "main.py": SUM_SCRIPT });
      expect(realSource.body.matchesCard).toBe(true);
      expect(realSource.body.storedCodeMatchesDigest).toBe(true);
    });
  });
});
