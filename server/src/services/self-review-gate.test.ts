import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  RISKY_SURFACE_CATEGORY_LABELS,
  SELF_REVIEW_PASS_CONTEXT_KEY,
  SELF_REVIEW_PASS_NOTICE_COMMENT,
  SELF_REVIEW_PASS_REASON,
  buildSelfReviewPassIdempotencyKey,
  buildSelfReviewPassInstruction,
  detectRiskySurfaceFromDiff,
  detectRiskySurfaceFromDiffContent,
  evaluateSelfReviewDoneGate,
  findExistingSelfReviewPassNoticeCommentForRun,
  getChangedDiffContentForIssueWorkspace,
  getChangedFilePathsForIssueWorkspace,
  isSelfReviewPassContext,
  isSelfReviewPassRun,
  issueExecutionPolicyOptsOutOfSelfReview,
  postSelfReviewPassNoticeComment,
  type SelfReviewGateWakeup,
} from "./self-review-gate.js";

const execFileAsync = promisify(execFile);

describe("isSelfReviewPassContext", () => {
  it("recognizes the explicit marker", () => {
    expect(isSelfReviewPassContext({ [SELF_REVIEW_PASS_CONTEXT_KEY]: true })).toBe(true);
  });

  it("recognizes a matching wakeReason", () => {
    expect(isSelfReviewPassContext({ wakeReason: SELF_REVIEW_PASS_REASON })).toBe(true);
  });

  it("returns false for unrelated context", () => {
    expect(isSelfReviewPassContext({ wakeReason: "something_else" })).toBe(false);
    expect(isSelfReviewPassContext(null)).toBe(false);
    expect(isSelfReviewPassContext(undefined)).toBe(false);
    expect(isSelfReviewPassContext("not an object")).toBe(false);
    expect(isSelfReviewPassContext([])).toBe(false);
  });
});

describe("isSelfReviewPassRun", () => {
  it("recognizes a run scheduled with the self-review retry reason", () => {
    expect(isSelfReviewPassRun({ scheduledRetryReason: SELF_REVIEW_PASS_REASON, contextSnapshot: null })).toBe(true);
  });

  it("recognizes a run via its contextSnapshot even without the retry reason column set", () => {
    expect(
      isSelfReviewPassRun({
        scheduledRetryReason: null,
        contextSnapshot: { [SELF_REVIEW_PASS_CONTEXT_KEY]: true },
      }),
    ).toBe(true);
  });

  it("returns false for an unrelated run", () => {
    expect(
      isSelfReviewPassRun({ scheduledRetryReason: "max_turn_continuation", contextSnapshot: { issueId: "issue-1" } }),
    ).toBe(false);
  });
});

describe("issueExecutionPolicyOptsOutOfSelfReview", () => {
  it("opts out only when selfReview is explicitly false", () => {
    expect(issueExecutionPolicyOptsOutOfSelfReview({ selfReview: false })).toBe(true);
  });

  it("defaults to on (no opt-out) when unset or missing", () => {
    expect(issueExecutionPolicyOptsOutOfSelfReview({ selfReview: true })).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview({})).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview(null)).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview(undefined)).toBe(false);
  });
});

describe("buildSelfReviewPassIdempotencyKey", () => {
  it("is stable for the same issue/run pair and distinct across runs", () => {
    const key = buildSelfReviewPassIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" });
    expect(key).toBe(`${SELF_REVIEW_PASS_REASON}:issue-1:run-1`);
    expect(buildSelfReviewPassIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-2" })).not.toBe(key);
  });
});

describe("buildSelfReviewPassInstruction", () => {
  it("tells the agent to continue the normal handoff when not already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    expect(instruction).toContain("PAP-1");
    expect(instruction).toContain("continue the normal handoff");
  });

  it("tells the agent nothing further is required if the review finds nothing when already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: true });
    expect(instruction).toContain("no further action is required");
  });

  it("falls back to a generic label when no issue identifier is available", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: null, alreadyHandedOff: false });
    expect(instruction).toContain("this issue");
  });

  it("names the concrete PATCH call and forbids deferring to a future pass when not already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      requestedStatus: "done",
    });
    expect(instruction).toContain("PATCH .../done");
    expect(instruction).toContain('Do not defer this to "the next self-review-pass run"');
  });

  it("omits the concrete-PATCH line when no requestedStatus is given, but still forbids deferring", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    expect(instruction).not.toContain("PATCH .../");
    expect(instruction).toContain('Do not defer this to "the next self-review-pass run"');
  });

  it("DUR-167: explicitly tells a same-run reader (the just-declined run) to stop and not retry", () => {
    const instruction = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      requestedStatus: "done",
    });
    expect(instruction).toContain("If you are the run whose PATCH was just declined: stop");
    expect(instruction).toContain("Do not retry that PATCH in this run");
    expect(instruction).toContain("even if you post a self-review comment first");
    expect(instruction).toContain("If you are that freshly-started run");
  });

  it("is byte-for-byte unchanged for an ordinary change with no risky surface", () => {
    const withoutCategories = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    const withEmptyCategories = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      riskySurfaceCategories: [],
    });
    expect(withEmptyCategories).toBe(withoutCategories);
    // The three confirmatory bullets from self-review-gate.ts must survive untouched.
    expect(withoutCategories).toContain(
      "- Check that every requirement in the description is actually met, not just partially addressed.",
    );
    expect(withoutCategories).toContain("- Look for bugs, mistakes, or loose ends you may have missed the first time.");
    expect(withoutCategories).toContain("- Fix anything real that you find. Do not invent extra scope beyond the task.");
    expect(withoutCategories).not.toContain("risky surface");
    expect(withoutCategories).not.toContain("dishonest agent");
  });

  it("appends adversarial questions on top of (not instead of) the ordinary bullets for a risky change", () => {
    const instruction = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      riskySurfaceCategories: ["authorization_or_permissions", "agent_configuration"],
    });
    // Ordinary bullets still present, unmodified.
    expect(instruction).toContain(
      "- Check that every requirement in the description is actually met, not just partially addressed.",
    );
    expect(instruction).toContain("- Fix anything real that you find. Do not invent extra scope beyond the task.");
    // Adversarial block present, naming the detected categories.
    expect(instruction).toContain(RISKY_SURFACE_CATEGORY_LABELS.authorization_or_permissions);
    expect(instruction).toContain(RISKY_SURFACE_CATEGORY_LABELS.agent_configuration);
    expect(instruction).toContain("If a dishonest agent wanted to abuse this change");
    expect(instruction).toContain("Does this add a field, route, or setting that an agent could set on itself");
    expect(instruction).toContain("Does this only work because something elsewhere is configured");
    expect(instruction).toContain("What did the ticket NOT ask for");
    // A risky-change finding outside the ticket's scope must be reported, not suppressed by
    // the "do not invent extra scope" line above.
    expect(instruction).toContain("don't suppress it");
  });
});

describe("detectRiskySurfaceFromDiff", () => {
  it("returns no categories for an ordinary change", () => {
    expect(detectRiskySurfaceFromDiff(["ui/src/components/WidgetCard.tsx", "README.md"])).toEqual([]);
  });

  it("returns an empty array (not risky) for an empty diff", () => {
    expect(detectRiskySurfaceFromDiff([])).toEqual([]);
  });

  it("flags authorization/permissions surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/services/authorization.ts"])).toEqual([
      "authorization_or_permissions",
    ]);
  });

  it("flags agent-configuration surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/routes/agents.ts"])).toEqual(["agent_configuration"]);
  });

  it("flags secrets/credentials surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/services/secrets.ts"])).toEqual(["secrets_or_credentials"]);
  });

  it("flags migrations", () => {
    expect(detectRiskySurfaceFromDiff(["packages/db/src/migrations/0099_add_widget.sql"])).toEqual(["migrations"]);
  });

  it("flags outbound/spend surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/services/deploy-runner-status.ts"])).toEqual(["outbound_or_spend"]);
  });

  it("dedupes categories across multiple matching files and can flag more than one category", () => {
    const categories = detectRiskySurfaceFromDiff([
      "server/src/services/authorization.ts",
      "server/src/routes/authorization-admin.ts",
      "server/src/services/secrets.ts",
      "ui/src/components/Unrelated.tsx",
    ]);
    expect(categories).toEqual(
      expect.arrayContaining(["authorization_or_permissions", "secrets_or_credentials"]),
    );
    expect(categories).toHaveLength(2);
  });
});

describe("detectRiskySurfaceFromDiffContent", () => {
  it("returns no categories for an ordinary diff", () => {
    const diff = ["diff --git a/foo.ts b/foo.ts", "+++ b/foo.ts", "+export const widgetCount = 3;"].join("\n");
    expect(detectRiskySurfaceFromDiffContent(diff)).toEqual([]);
  });

  it("returns an empty array for empty diff content", () => {
    expect(detectRiskySurfaceFromDiffContent("")).toEqual([]);
  });

  // DUR-91: this is exactly the DUR-67 blind spot -- codex-home.ts/runtime-config.ts match no
  // filename pattern, but the added lines strip an mcp_servers block whose env can carry secrets.
  it("flags secrets/mcp content in an added line even when the file path is generic", () => {
    const diff = [
      "diff --git a/packages/adapters/codex-local/src/server/codex-home.ts b/packages/adapters/codex-local/src/server/codex-home.ts",
      "+++ b/packages/adapters/codex-local/src/server/codex-home.ts",
      "-const config = readToml(source);",
      "+const config = stripMcpServersBlocks(readToml(source)); // mcp_servers env may carry secrets",
    ].join("\n");
    const categories = detectRiskySurfaceFromDiffContent(diff);
    expect(categories).toEqual(
      expect.arrayContaining(["agent_configuration", "secrets_or_credentials"]),
    );
  });

  it("ignores the '+++ b/path' file header line so a risky filename alone doesn't trigger a content match", () => {
    const diff = ["diff --git a/server/src/services/secrets.ts b/server/src/services/secrets.ts", "+++ b/server/src/services/secrets.ts", "+export const NOTHING_RISKY = 1;"].join(
      "\n",
    );
    expect(detectRiskySurfaceFromDiffContent(diff)).toEqual([]);
  });

  it("ignores removed and context lines, only scanning added lines", () => {
    const diff = ["diff --git a/foo.ts b/foo.ts", "+++ b/foo.ts", "-const secretToken = getSecret();", " const unrelated = 1;", "+const ok = 2;"].join(
      "\n",
    );
    expect(detectRiskySurfaceFromDiffContent(diff)).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self-review-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("self-review-gate DB-backed behavior", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-review-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  const tempDirs = new Set<string>();

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runGit(cwd: string, args: string[]) {
    await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  }

  /**
   * A real temp git checkout with a base ref ("base") and a HEAD commit that changed
   * `changedFilePath` -- so getChangedFilePathsForIssueWorkspace/detectRiskySurfaceFromDiff
   * run against an actual diff, not a stubbed file list. `content` defaults to an innocuous
   * line; pass a risky one to exercise the DUR-91 content-based signal for a generically
   * named file.
   */
  async function createTempRepoWithChange(changedFilePath: string, content = "// change under test\n") {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-self-review-gate-"));
    tempDirs.add(repoRoot);
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);
    await runGit(repoRoot, ["branch", "base"]);

    const targetPath = path.join(repoRoot, changedFilePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    await runGit(repoRoot, ["add", changedFilePath]);
    await runGit(repoRoot, ["commit", "-m", "Work for this issue"]);

    return repoRoot;
  }

  async function seedCodeIssueFixture(input?: { status?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Widgets",
      status: "active",
    });

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      name: "main",
      sourceType: "git",
      repoUrl: "https://example.com/widgets.git",
      isPrimary: true,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Fix the widget",
      status: input?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, projectId, issueId, runId };
  }

  function makeRecordingWakeup(db: ReturnType<typeof createDb>, companyId: string) {
    const calls: Array<{ agentId: string; opts: Parameters<SelfReviewGateWakeup>[1] }> = [];
    const wakeup: SelfReviewGateWakeup = async (agentId, opts) => {
      calls.push({ agentId, opts });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: opts.source ?? "automation",
        triggerDetail: opts.triggerDetail ?? "system",
        reason: opts.reason ?? null,
        payload: opts.payload ?? {},
        status: "queued",
        idempotencyKey: opts.idempotencyKey ?? null,
        requestedByActorType: opts.requestedByActorType ?? "system",
        requestedByActorId: opts.requestedByActorId ?? null,
      });
      return { ok: true };
    };
    return { wakeup, calls };
  }

  it("posts the plain-language instruction as a system comment when scheduling a new self-review pass", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.createdByRunId).toBe(runId);
    // Plain-language, non-technical instruction (matches buildSelfReviewPassInstruction).
    expect(comments[0]?.body).toContain("Review your diff/changes against the task description");
    expect(comments[0]?.body).not.toContain("self_review_pass");
    // DUR-125: names the concrete PATCH call so the exempt run acts on its own exemption
    // instead of deferring to "the next self-review-pass run" (which never comes).
    expect(comments[0]?.body).toContain("PATCH .../done");
    expect(comments[0]?.body).toContain('Do not defer this to "the next self-review-pass run"');

    // DUR-125: the scheduled wake must ask heartbeat.ts's coalescing logic for a genuinely
    // new run rather than letting it merge onto the source run's own (still-running, already
    // gated) row -- see shouldDeferFollowupWakeForSameIssue's requiresDistinctRunBoundary.
    expect(calls[0]?.opts.contextSnapshot?.requiresDistinctRunBoundary).toBe(true);
  });

  it("does not double-post the comment when a self-review wake already exists for this run chain", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup } = makeRecordingWakeup(db, companyId);

    const gateInput = {
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent" as const, agentId, runId },
      requestedStatus: "done" as const,
      currentStatus: "in_progress" as const,
    };

    await evaluateSelfReviewDoneGate(gateInput);
    await evaluateSelfReviewDoneGate(gateInput);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("lets the self-review pass run itself through without re-gating (no infinite loop)", async () => {
    const { companyId, agentId, projectId, issueId } = await seedCodeIssueFixture();
    const selfReviewRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: selfReviewRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      scheduledRetryReason: SELF_REVIEW_PASS_REASON,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId: selfReviewRunId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("skips the gate (and posts no comment) when the issue's project has no git workspace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId: null,
      title: "Write the launch memo",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: { id: issueId, identifier: `T-1`, companyId, projectId: null, executionPolicy: null },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  describe("risky-surface detection reads the real diff of the issue's workspace", () => {
    async function seedIssueWithWorkspace(input: { changedFilePath: string; content?: string }) {
      const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
      const repoRoot = await createTempRepoWithChange(input.changedFilePath, input.content);
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "test workspace",
        status: "active",
        providerType: "local_fs",
        cwd: repoRoot,
        baseRef: "base",
        sourceIssueId: issueId,
      });
      await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
      return { companyId, agentId, projectId, issueId, runId, executionWorkspaceId, repoRoot };
    }

    it("reads the changed file paths for a real diff via git", async () => {
      const { companyId, issueId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/services/authorization.ts",
      });
      const changedFiles = await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId });
      expect(changedFiles).toEqual(["server/src/services/authorization.ts"]);
    });

    it("returns null (not empty) when there's no execution workspace on the issue, so callers can't mistake 'couldn't check' for 'checked, found nothing'", async () => {
      const changedFiles = await getChangedFilePathsForIssueWorkspace(db, {
        companyId: randomUUID(),
        issueId: null,
      });
      expect(changedFiles).toBeNull();
    });

    it("gets ONLY the ordinary confirmatory prompt for a change that doesn't touch a risky surface, from a real diff read", async () => {
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).not.toContain("risky surface");
      expect(comments[0]?.body).not.toContain("dishonest agent");
    });

    it("adds the adversarial questions when the diff touches a risky surface -- driven by the diff, not the agent's own say-so", async () => {
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/services/authorization.ts",
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        // Note: the actor/caller never asserts riskiness themselves -- there is no "isRisky"
        // input anywhere here. The gate must derive it itself from the workspace's diff.
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result?.message).toContain("authorization or permissions");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("risky surface");
      expect(comments[0]?.body).toContain("authorization or permissions");
      expect(comments[0]?.body).toContain("If a dishonest agent wanted to abuse this change");
      // The ordinary bullets are still there too -- adversarial is additive, not a replacement.
      expect(comments[0]?.body).toContain(
        "- Check that every requirement in the description is actually met, not just partially addressed.",
      );
    });

    it("DUR-91: adds the adversarial questions for a risky change in a generically-named file, driven by diff content -- the DUR-67 blind spot", async () => {
      // Neither the file path nor anything about it matches RISKY_SURFACE_PATTERNS -- only
      // the added line's content (mcp_servers/secret literals) does. Reproduces the exact gap
      // DUR-67 slipped through: detectRiskySurfaceFromDiff(["server/src/adapter-home.ts"]) alone
      // would return [].
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/adapter-home.ts",
        content: "export function stripMcpServersBlocks(toml) {\n  // mcp_servers env can carry secrets\n  return toml;\n}\n",
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result?.message).toContain("agent configuration");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("risky surface");
      expect(comments[0]?.body).toContain("If a dishonest agent wanted to abuse this change");
    });

    it("reads the full added-line diff content for a real diff via git", async () => {
      const { companyId, issueId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/adapter-home.ts",
        content: "// mcp_servers secret handling\n",
      });
      const diffContent = await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId });
      expect(diffContent).toContain("+// mcp_servers secret handling");
    });

    it("DUR-83: still detects the risky surface after the assignee clears issue.executionWorkspaceId, because detection resolves the workspace by execution_workspaces.sourceIssueId, not the mutable issue column", async () => {
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/services/authorization.ts",
      });
      // Simulate exactly the bypass DUR-83 describes: a plain field-only PATCH that clears
      // the issue's own executionWorkspaceId pointer without touching status.
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, issueId));
      const { wakeup } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result?.message).toContain("authorization or permissions");
    });

    it("falls back to the ordinary-only prompt when the workspace path can't actually be read (never guesses risky)", async () => {
      const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "unreachable workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/nonexistent/paperclip-self-review-gate-test-path",
        baseRef: "base",
        sourceIssueId: issueId,
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).not.toContain("risky surface");
    });
  });

  describe("postSelfReviewPassNoticeComment / findExistingSelfReviewPassNoticeCommentForRun", () => {
    it("inserts a system comment and finds it again by company/issue/run/body", async () => {
      const { companyId, issueId, runId } = await seedCodeIssueFixture();

      const before = await findExistingSelfReviewPassNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });
      expect(before).toBeNull();

      await postSelfReviewPassNoticeComment(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });

      const after = await findExistingSelfReviewPassNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });
      expect(after).not.toBeNull();

      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe(SELF_REVIEW_PASS_NOTICE_COMMENT);
      expect(rows[0]?.authorType).toBe("system");
    });
  });
});
