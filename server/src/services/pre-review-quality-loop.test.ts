import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyQualityLoopSettings,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { QUALITY_PRE_REVIEW_MAX_ROUNDS, updateCompanyQualityLoopSettingsSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { collectProjectWorkspaceCommandPaths } from "../routes/workspace-command-authz.js";
import {
  PRE_REVIEW_RUNNING_MESSAGE,
  PRE_REVIEW_TESTS_FAILED_REASON,
  PRE_REVIEW_TESTS_PASSED_REASON,
  buildPreReviewFailureComment,
  evaluatePreReviewQualityLoop,
  lastLines,
  waitForPreReviewCheck,
  type PreReviewTestRunner,
} from "./pre-review-quality-loop.js";
import { projectService } from "./projects.js";
import { resolveEffectiveQualityLoops, resolveProjectWorkspaceTestCommand } from "./quality-loops.js";
import { MISSING_RUN_ID_GATE_MESSAGE, type SelfReviewGateWakeup } from "./self-review-gate.js";

describe("pre-review loop: pure pieces", () => {
  it("is off by default and switched on by the company row only", () => {
    expect(resolveEffectiveQualityLoops(null, null).preReviewQualityLoop).toBe(false);
    expect(
      resolveEffectiveQualityLoops({ selfReviewPasses: 0, doneCheckEnabled: false, doneCheckMaxRounds: null, preReviewQualityLoop: true }, null)
        .preReviewQualityLoop,
    ).toBe(true);
    expect(updateCompanyQualityLoopSettingsSchema.parse({ preReviewQualityLoop: true })).toEqual({ preReviewQualityLoop: true });
  });

  it("keeps only the last 60 lines, drops colour codes, and masks secret-looking values", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n\u001b[31mred\u001b[0m\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const tail = lastLines(output);
    expect(tail.split("\n")).toHaveLength(60);
    expect(tail).toContain("line 150");
    expect(tail).not.toContain("line 100");
    expect(tail).toContain("red");
    expect(tail).not.toContain("\u001b");
    expect(tail).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("states the failures at the top once the last round has failed", () => {
    const result = { exitCode: 1, timedOut: false, output: "boom" };
    const first = buildPreReviewFailureComment({ round: 1, maxRounds: 2, command: "pnpm test", headSha: "abcdef1234567", result, timeoutMs: 900_000 });
    expect(first.split("\n")[0]).toBe("Quality loop: tests failed (round 1 of 2)");
    expect(first).not.toContain("STILL failing");
    const last = buildPreReviewFailureComment({ round: 2, maxRounds: 2, command: "pnpm test", headSha: "abcdef1234567", result, timeoutMs: 900_000 });
    expect(last.split("\n")[0]).toBe("Quality loop: tests failed (round 2 of 2)");
    expect(last.split("\n")[2]).toContain("STILL failing");
    expect(last).toContain("abcdef1");
  });

  it("treats a test command in a workspace write as a host command an agent key may not touch", () => {
    expect(collectProjectWorkspaceCommandPaths({ testCommand: "x" })).toEqual(["testCommand"]);
    expect(collectProjectWorkspaceCommandPaths({ metadata: { testCommand: "x" } })).toEqual(["metadata.testCommand"]);
    expect(collectProjectWorkspaceCommandPaths({ metadata: { note: "x" } }, "workspace")).toEqual([]);
    expect(collectProjectWorkspaceCommandPaths({ testCommand: null }, "workspace")).toEqual(["workspace.testCommand"]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pre-review quality loop (DB-backed, real temp repo)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pre-review-loop-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyQualityLoopSettings);
    await db.delete(agents);
    await db.delete(companies);
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pre-review-"));
    tempDirs.push(dir);
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  }

  function commitAgain(dir: string, content: string) {
    fs.writeFileSync(path.join(dir, "a.txt"), content);
    git(dir, "commit", "-q", "-am", content.trim());
    return git(dir, "rev-parse", "HEAD");
  }

  async function seed(input?: {
    settingOn?: boolean;
    testCommand?: string | null;
    withWorkspace?: boolean;
    executionPolicy?: unknown;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const prefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Module", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      name: "main",
      sourceType: "git_repo",
      repoUrl: "https://example.com/module.git",
      isPrimary: true,
      metadata: input?.testCommand === null ? null : { testCommand: input?.testCommand ?? "pnpm test" },
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", status: "running" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Build the module",
      description: "Acceptance: the module's tests pass.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    if (input?.settingOn !== false) await db.insert(companyQualityLoopSettings).values({ companyId, preReviewQualityLoop: true });
    let repo: string | null = null;
    if (input?.withWorkspace !== false) {
      repo = makeRepo();
      await db.insert(executionWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "ws",
        status: "active",
        providerType: "local_fs",
        cwd: repo,
        baseRef: "HEAD",
        sourceIssueId: issueId,
      });
    }
    return {
      companyId,
      agentId,
      projectId,
      issueId,
      runId,
      repo,
      issue: {
        id: issueId,
        identifier: `${prefix}-1`,
        companyId,
        projectId,
        executionPolicy: (input?.executionPolicy ?? null) as unknown,
      },
    };
  }

  function recordingWakeup() {
    const calls: Array<{ agentId: string; reason: string | null | undefined; payload: Record<string, unknown> | null | undefined }> = [];
    const wakeup: SelfReviewGateWakeup = async (agentId, o) => {
      calls.push({ agentId, reason: o.reason, payload: o.payload });
      return null;
    };
    return { wakeup, calls };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;
  function move(f: Fixture, wakeup: SelfReviewGateWakeup, extra?: Partial<Parameters<typeof evaluatePreReviewQualityLoop>[0]>) {
    return evaluatePreReviewQualityLoop({
      db,
      wakeup,
      issue: f.issue,
      actor: { actorType: "agent", agentId: f.agentId, runId: f.runId },
      requestedStatus: "in_review",
      currentStatus: "in_progress",
      ...extra,
    });
  }

  async function loopComments(issueId: string) {
    const rows = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
    return rows.map((row) => row.body).filter((body) => body.startsWith("Quality loop:"));
  }

  const failing: PreReviewTestRunner = async () => ({ exitCode: 1, timedOut: false, output: "FAIL src/thing.test.ts\nexpected 1 to be 2" });
  const passing: PreReviewTestRunner = async () => ({ exitCode: 0, timedOut: false, output: "all good" });

  it("a real failing test command in the task's temp folder produces round 1 and wakes the same agent", async () => {
    const f = await seed({ testCommand: "echo 'REAL-FAILURE-LINE' >&2; exit 3" });
    const w = recordingWakeup();

    const first = await move(f, w.wakeup);
    expect(first?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);

    const comments = await loopComments(f.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.split("\n")[0]).toBe("Quality loop: tests failed (round 1 of 2)");
    expect(comments[0]).toContain("REAL-FAILURE-LINE");
    expect(comments[0]).toContain("exited with code 3");
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ agentId: f.agentId, reason: PRE_REVIEW_TESTS_FAILED_REASON });
    expect(w.calls[0]!.payload).toMatchObject({ issueId: f.issueId, qualityLoop: true });
    const actions = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.entityId, f.issueId));
    expect(actions.map((a) => a.action)).toContain("issue.pre_review_tests_failed");
  });

  it("refuses while a check is still running, without starting a second one", async () => {
    const f = await seed();
    const w = recordingWakeup();
    let release!: () => void;
    let started = 0;
    const slow: PreReviewTestRunner = () => {
      started += 1;
      return new Promise((resolve) => {
        release = () => resolve({ exitCode: 0, timedOut: false, output: "" });
      });
    };
    expect((await move(f, w.wakeup, { runner: slow }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    expect((await move(f, w.wakeup, { runner: slow }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    expect(started).toBe(1);
    release();
    await waitForPreReviewCheck(f.issueId);
    expect(await loopComments(f.issueId)).toHaveLength(1);
  });

  it("two moves at the same moment start one test run, one round, one wake", async () => {
    const f = await seed();
    const w = recordingWakeup();
    let started = 0;
    const runner: PreReviewTestRunner = async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { exitCode: 1, timedOut: false, output: "FAIL" };
    };
    const [a, b] = await Promise.all([move(f, w.wakeup, { runner }), move(f, w.wakeup, { runner })]);
    expect(a?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    expect(b?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    expect(started).toBe(1);
    expect(await loopComments(f.issueId)).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
  });

  it("a slot reserved by a move that ends early is released (the next move can start)", async () => {
    const f = await seed({ withWorkspace: false });
    const w = recordingWakeup();
    expect(await move(f, w.wakeup, { runner: passing })).toBeNull(); // could not run: lets it through
    expect(await move(f, w.wakeup, { runner: passing })).toBeNull();
    const g = await seed();
    expect((await move(g, w.wakeup, { runner: passing }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(g.issueId);
  });

  it("a worker's done on a task with a review stage is a hand-off to review, so the tests run first", async () => {
    const other = randomUUID();
    const f = await seed({ executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: other }] }] } });
    const w = recordingWakeup();
    expect((await move(f, w.wakeup, { runner: failing, requestedStatus: "done" }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    expect(await loopComments(f.issueId)).toHaveLength(1);
    // The reviewer's own done (task already in review) is their verdict, not a hand-off.
    expect(await move(f, w.wakeup, { runner: failing, requestedStatus: "done", currentStatus: "in_review" })).toBeNull();
  });

  it("pass: posts the commit, wakes the agent to retry, and the next move for that commit goes through", async () => {
    const f = await seed();
    const w = recordingWakeup();
    expect((await move(f, w.wakeup, { runner: passing }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    const sha = git(f.repo!, "rev-parse", "HEAD");
    const comments = await loopComments(f.issueId);
    expect(comments[0]!.split("\n")[0]).toBe(`Quality loop: tests passed at ${sha.slice(0, 7)}`);
    expect(w.calls.map((c) => c.reason)).toEqual([PRE_REVIEW_TESTS_PASSED_REASON]);

    expect(await move(f, w.wakeup, { runner: failing })).toBeNull();
    expect(await loopComments(f.issueId)).toHaveLength(1);

    // New work = new commit = the tests run again.
    commitAgain(f.repo!, "two\n");
    expect((await move(f, w.wakeup, { runner: passing }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    expect(await loopComments(f.issueId)).toHaveLength(2);
  });

  it("after round 2 the move goes to review anyway, with the failures stated at the top of that comment", async () => {
    const f = await seed();
    const w = recordingWakeup();
    for (let round = 1; round <= QUALITY_PRE_REVIEW_MAX_ROUNDS; round++) {
      commitAgain(f.repo!, `attempt ${round}\n`);
      expect((await move(f, w.wakeup, { runner: failing }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
      await waitForPreReviewCheck(f.issueId);
    }
    const comments = await loopComments(f.issueId);
    expect(comments.map((c) => c.split("\n")[0])).toEqual([
      "Quality loop: tests failed (round 1 of 2)",
      "Quality loop: tests failed (round 2 of 2)",
    ]);
    expect(comments[1]!.split("\n")[2]).toContain("STILL failing");
    expect(w.calls.map((c) => c.reason)).toEqual([PRE_REVIEW_TESTS_FAILED_REASON, PRE_REVIEW_TESTS_FAILED_REASON]);
    // The agent's next move is let through, and no third run starts.
    commitAgain(f.repo!, "attempt 3\n");
    expect(await move(f, w.wakeup, { runner: failing })).toBeNull();
    expect(await loopComments(f.issueId)).toHaveLength(2);
  });

  it("runs even when the task has a review stage (that is the point)", async () => {
    const other = randomUUID();
    const f = await seed({ executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: other }] }] } });
    const w = recordingWakeup();
    expect((await move(f, w.wakeup, { runner: failing }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    expect(await loopComments(f.issueId)).toHaveLength(1);
  });

  it("a test command that runs too long is stopped and counted as a failed round", async () => {
    const f = await seed({ testCommand: "echo started; sleep 30" });
    const w = recordingWakeup();
    expect((await move(f, w.wakeup, { timeoutMs: 300 }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    const [comment] = await loopComments(f.issueId);
    expect(comment).toContain("Quality loop: tests failed (round 1 of 2)");
    expect(comment).toContain("did not finish within");
    expect(comment).toContain("started");
  }, 30_000);

  it("a descendant that leaves the process group cannot hold the check open forever", async () => {
    const f = await seed({ testCommand: "echo started; setsid sleep 60 & wait" });
    const w = recordingWakeup();
    expect((await move(f, w.wakeup, { timeoutMs: 300 }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    const [comment] = await loopComments(f.issueId);
    expect(comment).toContain("Quality loop: tests failed (round 1 of 2)");
    expect(comment).toContain("did not finish within");
  }, 30_000);

  it("a workspace with no git commit: one pass lets the next move through instead of looping", async () => {
    const f = await seed();
    fs.rmSync(path.join(f.repo!, ".git"), { recursive: true, force: true });
    const w = recordingWakeup();
    expect((await move(f, w.wakeup, { runner: passing }))?.message).toBe(PRE_REVIEW_RUNNING_MESSAGE);
    await waitForPreReviewCheck(f.issueId);
    expect(await move(f, w.wakeup, { runner: failing })).toBeNull();
    expect(w.calls).toHaveLength(1);
    expect(await loopComments(f.issueId)).toHaveLength(1);
  });

  it("the test command does not see the server's own secrets", async () => {
    process.env.DATABASE_URL = "postgres://secret-user:secret-pass@db/prod";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "jwt-secret-value";
    try {
      const f = await seed({ testCommand: 'echo "db=[$DATABASE_URL] jwt=[$PAPERCLIP_AGENT_JWT_SECRET]"; exit 1' });
      const w = recordingWakeup();
      await move(f, w.wakeup);
      await waitForPreReviewCheck(f.issueId);
      const [comment] = await loopComments(f.issueId);
      expect(comment).toContain("db=[] jwt=[]");
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    }
  });

  it("does not apply: loop off, no test command, a person moving it, or another status", async () => {
    const w = recordingWakeup();
    const off = await seed({ settingOn: false });
    expect(await move(off, w.wakeup, { runner: failing })).toBeNull();
    const noCommand = await seed({ testCommand: null });
    expect(await move(noCommand, w.wakeup, { runner: failing })).toBeNull();
    const on = await seed();
    expect(await move(on, w.wakeup, { runner: failing, actor: { actorType: "user", agentId: null, runId: null } })).toBeNull();
    expect(await move(on, w.wakeup, { runner: failing, requestedStatus: "done" })).toBeNull();
    expect(await move(on, w.wakeup, { runner: failing, currentStatus: "in_review" })).toBeNull();
    expect(w.calls).toHaveLength(0);
    for (const f of [off, noCommand, on]) expect(await loopComments(f.issueId)).toEqual([]);
  });

  it("an agent with no trusted run id cannot slip past a loop that applies", async () => {
    const f = await seed();
    const result = await move(f, recordingWakeup().wakeup, { actor: { actorType: "agent", agentId: f.agentId, runId: null } });
    expect(result?.message).toBe(MISSING_RUN_ID_GATE_MESSAGE);
  });

  it("with no workspace to run in, says so once and lets the move through", async () => {
    const f = await seed({ withWorkspace: false });
    const w = recordingWakeup();
    expect(await move(f, w.wakeup, { runner: failing })).toBeNull();
    expect(await move(f, w.wakeup, { runner: failing })).toBeNull();
    const comments = await loopComments(f.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("could not run the tests");
  });

  it("an agent cannot rewrite or clear the test command through the project workspace API (metadata is pinned)", async () => {
    const f = await seed({ testCommand: "pnpm test" });
    const svc = projectService(db);
    const [ws] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, f.projectId));
    expect(await resolveProjectWorkspaceTestCommand(db, f.companyId, f.projectId)).toBe("pnpm test");

    await svc.updateWorkspace(f.projectId, ws!.id, { metadata: null });
    expect(await resolveProjectWorkspaceTestCommand(db, f.companyId, f.projectId)).toBe("pnpm test");
    await svc.updateWorkspace(f.projectId, ws!.id, { metadata: { note: "hi" } });
    expect(await resolveProjectWorkspaceTestCommand(db, f.companyId, f.projectId)).toBe("pnpm test");
    await svc.updateWorkspace(f.projectId, ws!.id, { runtimeConfig: { desiredState: "manual" } });
    expect(await resolveProjectWorkspaceTestCommand(db, f.companyId, f.projectId)).toBe("pnpm test");

    // Only naming the command changes it (the route lets only board users do that).
    await svc.updateWorkspace(f.projectId, ws!.id, { testCommand: "pnpm test:unit" });
    expect(await resolveProjectWorkspaceTestCommand(db, f.companyId, f.projectId)).toBe("pnpm test:unit");
    const listed = await svc.listWorkspaces(f.projectId);
    expect(listed[0]!.testCommand).toBe("pnpm test:unit");
    await svc.updateWorkspace(f.projectId, ws!.id, { testCommand: null });
    expect(await resolveProjectWorkspaceTestCommand(db, f.companyId, f.projectId)).toBeNull();
  });
});
