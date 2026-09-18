import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
  classifyCommitAgainstCheckout,
  evaluateOriginCommitDoneGate,
  extractNamedCommits,
} from "./origin-commit-gate.js";

const execFileAsync = promisify(execFile);

describe("extractNamedCommits", () => {
  it("picks up a sha introduced with commit-ish wording", () => {
    expect(extractNamedCommits("Done — deployed in commit 0409513.")).toEqual(["0409513"]);
    expect(extractNamedCommits("pushed a1b2c3d4e5f6 to main")).toEqual(["a1b2c3d4e5f6"]);
  });

  it("picks up a bare full-length sha, which is unambiguous on its own", () => {
    expect(extractNamedCommits("See 153a43e03e570da323b74067a1a4066545772ece for the change.")).toEqual([
      "153a43e03e570da323b74067a1a4066545772ece",
    ]);
  });

  it("ignores hex-looking values that are not introduced as commits, so ids and checksums don't gate work", () => {
    expect(extractNamedCommits("Fixed the 1234567 lookup and the deadbeef colour token.")).toEqual([]);
    expect(extractNamedCommits("Order number 8675309 is now correct.")).toEqual([]);
  });

  it("treats a short sha and the full sha of the same commit as one commit", () => {
    const body = "commit 153a43e03e570da323b74067a1a4066545772ece (short: 153a43e0) is the fix";
    expect(extractNamedCommits(body)).toEqual(["153a43e03e570da323b74067a1a4066545772ece"]);
  });

  it("caps how many shas one note can turn into git calls", () => {
    const body = Array.from({ length: 12 }, (_, i) => `commit ${String(i).repeat(7)}`).join("\n");
    expect(extractNamedCommits(body).length).toBeLessThanOrEqual(5);
  });

  it("returns nothing for an empty or missing note", () => {
    expect(extractNamedCommits(null)).toEqual([]);
    expect(extractNamedCommits("")).toEqual([]);
    expect(extractNamedCommits("Done, no code changes needed.")).toEqual([]);
  });

  it("is not left stateful between calls by the global regexes", () => {
    const body = "commit abc1234 shipped";
    expect(extractNamedCommits(body)).toEqual(["abc1234"]);
    expect(extractNamedCommits(body)).toEqual(["abc1234"]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres origin-commit-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("origin-commit-gate against a real checkout", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-origin-commit-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  const tempDirs = new Set<string>();

  afterEach(async () => {
    await db.delete(issueComments);
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
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
    return stdout.trim();
  }

  /**
   * A real clone with a real origin: `origin` is a bare repo the clone can actually push to,
   * so "on a remote ref" and "only here" are produced by git itself rather than asserted.
   */
  async function createCloneWithOrigin() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-origin-commit-gate-"));
    tempDirs.add(root);
    const originPath = path.join(root, "origin.git");
    const clonePath = path.join(root, "clone");

    await fs.mkdir(originPath, { recursive: true });
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", originPath]);

    const seed = path.join(root, "seed");
    await fs.mkdir(seed, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await runGit(seed, ["config", "user.name", "Paperclip Test"]);
    await runGit(seed, ["config", "user.email", "test@paperclip.local"]);
    await fs.writeFile(path.join(seed, "README.md"), "# Test repo\n", "utf8");
    await runGit(seed, ["add", "README.md"]);
    await runGit(seed, ["commit", "-m", "Initial commit"]);
    await runGit(seed, ["remote", "add", "origin", originPath]);
    await runGit(seed, ["push", "origin", "main"]);

    await execFileAsync("git", ["clone", originPath, clonePath]);
    await runGit(clonePath, ["config", "user.name", "Paperclip Test"]);
    await runGit(clonePath, ["config", "user.email", "test@paperclip.local"]);
    return { clonePath, originPath };
  }

  async function commitInClone(clonePath: string, message: string) {
    const file = path.join(clonePath, `work-${randomUUID().slice(0, 8)}.ts`);
    await fs.writeFile(file, `// ${message}\n`, "utf8");
    await runGit(clonePath, ["add", "."]);
    await runGit(clonePath, ["commit", "-m", message]);
    return runGit(clonePath, ["rev-parse", "HEAD"]);
  }

  async function seedIssue(input: { workspacePath: string | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
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
      name: "TechBoss",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Dashboard" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Ship the migration fix",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    if (input.workspacePath) {
      await db.insert(executionWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "test workspace",
        status: "active",
        providerType: "local_fs",
        cwd: input.workspacePath,
        // Deliberately no baseRef: this gate must still run for a workspace realized
        // without one (the self-review gate's resolver requires it, this one must not).
        sourceIssueId: issueId,
      });
    }

    return { companyId, agentId, projectId, issueId };
  }

  function agentDone(seeded: { companyId: string; agentId: string; issueId: string }, note: string | null) {
    return {
      db,
      issue: { id: seeded.issueId, identifier: "T-1", companyId: seeded.companyId },
      actor: { actorType: "agent", agentId: seeded.agentId, runId: randomUUID() },
      requestedStatus: "done",
      currentStatus: "in_progress",
      patchComment: note,
    };
  }

  describe("classifyCommitAgainstCheckout", () => {
    it("calls a pushed commit on_remote and an unpushed one local_only", async () => {
      const { clonePath } = await createCloneWithOrigin();
      const pushed = await commitInClone(clonePath, "pushed work");
      await runGit(clonePath, ["push", "origin", "main"]);
      const unpushed = await commitInClone(clonePath, "unpushed work");

      expect(await classifyCommitAgainstCheckout(clonePath, pushed)).toBe("on_remote");
      expect(await classifyCommitAgainstCheckout(clonePath, unpushed)).toBe("local_only");
    });

    it("calls a sha this repository has never seen unknown_to_repo", async () => {
      const { clonePath } = await createCloneWithOrigin();
      expect(await classifyCommitAgainstCheckout(clonePath, "0123456789abcdef0123456789abcdef01234567")).toBe(
        "unknown_to_repo",
      );
    });

    it("still calls an orphaned commit local_only after a reset made it unreachable — the 15 Sep failure", async () => {
      const { clonePath } = await createCloneWithOrigin();
      const orphaned = await commitInClone(clonePath, "work that is about to be wiped");
      await runGit(clonePath, ["reset", "--hard", "origin/main"]);

      expect(await runGit(clonePath, ["rev-parse", "HEAD"])).not.toBe(orphaned);
      expect(await classifyCommitAgainstCheckout(clonePath, orphaned)).toBe("local_only");
    });
  });

  it("refuses done when the only named commit never left this working copy", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const unpushed = await commitInClone(clonePath, "unpushed work");
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate(
      agentDone(seeded, `Deployed and verified in commit ${unpushed.slice(0, 7)}.`),
    );

    expect(result).not.toBeNull();
    expect(result?.warningOnly).toBe(false);
    expect(result?.reason).toBe("local_only");
    expect(result?.message).toContain("cannot be marked done yet");
    // Plain language for the operator, and a way out that isn't a dead end.
    expect(result?.message).toContain("shared repository");
    expect(result?.message).toContain("squashed merge");
  });

  it("lets done through when the named commit is on the remote", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const pushed = await commitInClone(clonePath, "pushed work");
    await runGit(clonePath, ["push", "origin", "main"]);
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate(agentDone(seeded, `Shipped in commit ${pushed}.`));
    expect(result).toBeNull();
  });

  it("lets done through when the note names a pushed commit alongside a local-only one", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const pushed = await commitInClone(clonePath, "pushed work");
    await runGit(clonePath, ["push", "origin", "main"]);
    const unpushed = await commitInClone(clonePath, "local scratch commit");
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate(
      agentDone(seeded, `Work started in commit ${unpushed} and shipped as commit ${pushed}.`),
    );
    expect(result).toBeNull();
  });

  it("warns but does not refuse when the named commit belongs to some other repository", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate(
      agentDone(seeded, "Done — the dashboard side shipped in commit 0123456789abcdef0123456789abcdef01234567."),
    );

    expect(result?.warningOnly).toBe(true);
    expect(result?.reason).toBe("unknown_to_repo");
  });

  it("reads the agent's own last comment when the status change carries no note", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const unpushed = await commitInClone(clonePath, "unpushed work");
    const seeded = await seedIssue({ workspacePath: clonePath });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.agentId,
      authorType: "agent",
      body: `All done, deployed in commit ${unpushed}.`,
    });

    const result = await evaluateOriginCommitDoneGate(agentDone(seeded, null));
    expect(result?.warningOnly).toBe(false);
    expect(result?.reason).toBe("local_only");
  });

  it("ignores a deleted comment rather than gating on a note the agent has retracted", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const unpushed = await commitInClone(clonePath, "unpushed work");
    const seeded = await seedIssue({ workspacePath: clonePath });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.agentId,
      authorType: "agent",
      body: `Deployed in commit ${unpushed}.`,
      deletedAt: new Date(),
    });

    expect(await evaluateOriginCommitDoneGate(agentDone(seeded, null))).toBeNull();
  });

  it("never gates a board actor, however bad the note looks", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const unpushed = await commitInClone(clonePath, "unpushed work");
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate({
      ...agentDone(seeded, `Closing this, commit ${unpushed} is good enough.`),
      actor: { actorType: "user", agentId: null, runId: null },
    });
    expect(result).toBeNull();
  });

  it("does not fire on a transition to anything other than done", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const unpushed = await commitInClone(clonePath, "unpushed work");
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate({
      ...agentDone(seeded, `Ready for review, commit ${unpushed}.`),
      requestedStatus: "in_review",
    });
    expect(result).toBeNull();
  });

  it("does not fire when the done note names no commit at all", async () => {
    const { clonePath } = await createCloneWithOrigin();
    await commitInClone(clonePath, "unpushed work");
    const seeded = await seedIssue({ workspacePath: clonePath });

    expect(await evaluateOriginCommitDoneGate(agentDone(seeded, "Done — this was a config change."))).toBeNull();
  });

  it("lets done through when there is no local checkout to check against", async () => {
    const seeded = await seedIssue({ workspacePath: null });

    const result = await evaluateOriginCommitDoneGate(
      agentDone(seeded, "Deployed in commit 0123456789abcdef0123456789abcdef01234567."),
    );
    expect(result).toBeNull();
  });

  it("lets done through when the recorded checkout path no longer exists on disk", async () => {
    const seeded = await seedIssue({ workspacePath: path.join(os.tmpdir(), `paperclip-gone-${randomUUID()}`) });

    const result = await evaluateOriginCommitDoneGate(
      agentDone(seeded, "Deployed in commit 0123456789abcdef0123456789abcdef01234567."),
    );
    expect(result).toBeNull();
  });

  it("refuses the exact 15 Sep shape: agent commits, another run resets the shared checkout, agent closes as deployed", async () => {
    const { clonePath } = await createCloneWithOrigin();
    const committed = await commitInClone(clonePath, "NOR-1429 work");
    // A second agent's run in the same shared checkout moves it back to origin/main.
    await runGit(clonePath, ["reset", "--hard", "origin/main"]);
    const seeded = await seedIssue({ workspacePath: clonePath });

    const result = await evaluateOriginCommitDoneGate(
      agentDone(seeded, `Deployed and verified — commit ${committed.slice(0, 7)}.`),
    );

    expect(result?.warningOnly).toBe(false);
    expect(result?.reason).toBe("local_only");
    // The issue stays open, so the work is still recoverable from the reflog.
    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]!);
    expect(issue.status).toBe("in_progress");
  });
});
