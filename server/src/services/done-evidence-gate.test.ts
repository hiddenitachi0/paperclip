import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  companies,
  companyQualityLoopSettings,
  createDb,
  issueApprovals,
  issueComments,
  issues,
  issueWorkProducts,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { evaluateDoneEvidenceGate, extractAcceptanceCriteriaPaths } from "./done-evidence-gate.js";

const SHA = "1".repeat(40);
const SHA_B = "2".repeat(40);

describe("extractAcceptanceCriteriaPaths", () => {
  const paths = (description: string) => extractAcceptanceCriteriaPaths(description).map((p) => p.path);

  it("reads backticked paths and bare tokens with a known file extension from the Acceptance Criteria section only", () => {
    const description = [
      "## Objective",
      "Touch `server/src/other.ts` for context.",
      "## Acceptance Criteria",
      "- `docs/x.md` explains the setting",
      "- server/src/services/commit-ci-status.ts exists, with a test in services/commit-ci-status.test.ts.",
      "- the folder `ui/src/components` is updated",
      "## Notes",
      "Not this: `packages/shared/src/nope.ts`",
    ].join("\n");
    // Backticked names are read first, then the bare ones.
    expect(paths(description)).toEqual([
      "docs/x.md",
      "ui/src/components",
      "server/src/services/commit-ci-status.ts",
      "services/commit-ci-status.test.ts",
    ]);
  });

  it("marks a backticked folder as a directory, so any file under it counts", () => {
    const found = extractAcceptanceCriteriaPaths("## Acceptance Criteria\n- `ui/src/components` changes\n");
    expect(found).toEqual([{ path: "ui/src/components", dir: true }]);
  });

  it("ignores prose, URLs, globs, versions and placeholders that only look like paths", () => {
    const description = [
      "## Acceptance Criteria",
      "- works for client/server and/or Node.js, e.g. v1.2 or i.e. 3.5 hours",
      "- see https://github.com/acme/widgets/blob/main/README.md for background",
      "- covers `src/**/*.ts` and `<file>.ts` and `fooBar()`",
    ].join("\n");
    expect(paths(description)).toEqual([]);
  });

  it("strips line numbers, a leading ./ and trailing punctuation", () => {
    expect(paths("## Acceptance Criteria\nSee `./server/src/a.ts:42`, and (docs/b.md).")).toEqual(["server/src/a.ts", "docs/b.md"]);
  });

  it("returns nothing when there is no Acceptance Criteria section", () => {
    expect(paths("Fix `server/src/a.ts` please.")).toEqual([]);
    expect(paths("")).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-evidence-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type CommitFixture = { files: string[]; ci?: { runs?: Array<{ name: string; status: string; conclusion: string | null }>; status?: unknown } };

/** GitHub stub: /commits/{sha} (200 only for known shas), /commits/{sha}/status, /commits/{sha}/check-runs. */
function githubStub(commits: Record<string, CommitFixture>) {
  return vi.fn(async (url: string) => {
    const match = new URL(url).pathname.match(/\/commits\/([0-9a-f]+)(\/status|\/check-runs)?$/);
    const sha = match?.[1];
    const fixture = sha ? commits[sha] : undefined;
    if (!sha || !fixture) return new Response("not found", { status: 404 });
    if (match![2] === "/status") {
      return new Response(JSON.stringify(fixture.ci?.status ?? { state: "pending", total_count: 0, statuses: [] }), { status: 200 });
    }
    if (match![2] === "/check-runs") {
      const runs = fixture.ci?.runs ?? [];
      return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), { status: 200 });
    }
    return new Response(JSON.stringify({ sha, files: fixture.files.map((filename) => ({ filename })) }), { status: 200 });
  });
}

const GREEN = { runs: [{ name: "verify", status: "completed", conclusion: "success" }] };

describeEmbeddedPostgres("done-evidence-gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-done-evidence-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyQualityLoopSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    mode?: "off" | "report" | "enforce" | null;
    repoUrl?: string | null;
    description?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Dashboard" });
    if (input.repoUrl !== null) {
      await db.insert(projectWorkspaces).values({
        companyId,
        projectId,
        name: "main",
        sourceType: "git_repo",
        repoUrl: input.repoUrl ?? "https://github.com/acme/widgets",
        isPrimary: true,
      });
    }
    const description = input.description ?? "Do the thing.\n\n## Acceptance Criteria\n- `docs/x.md` is updated\n";
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Ship it",
      description,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    if (input.mode !== null) {
      await db.insert(companyQualityLoopSettings).values({ companyId, doneEvidenceMode: input.mode ?? "enforce" });
    }
    return { companyId, agentId, projectId, issueId, description };
  }

  function agentDone(
    seeded: Awaited<ReturnType<typeof seed>>,
    fetchImpl: ReturnType<typeof githubStub>,
    overrides: { note?: string | null; actorType?: string; requestedStatus?: string } = {},
  ) {
    return evaluateDoneEvidenceGate({
      db,
      issue: { id: seeded.issueId, identifier: "T-1", companyId: seeded.companyId, projectId: seeded.projectId, description: seeded.description },
      actor: { actorType: overrides.actorType ?? "agent", agentId: overrides.actorType === "user" ? null : seeded.agentId, runId: randomUUID() },
      requestedStatus: overrides.requestedStatus ?? "done",
      currentStatus: "in_progress",
      patchComment: overrides.note === undefined ? `Done in commit ${SHA}.` : overrides.note,
      deps: { fetchImpl, getGitHubToken: async () => "ghp_test" },
    });
  }

  it("passes when the commit is on origin, changes the named file and its checks are green", async () => {
    const seeded = await seed({});
    const fetchImpl = githubStub({ [SHA]: { files: ["docs/x.md", "server/src/a.ts"], ci: GREEN } });
    expect(await agentDone(seeded, fetchImpl)).toBeNull();
    // The company's GitHub token is sent along.
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer ghp_test" });
  });

  it("refuses a commit that is not on origin, in plain words", async () => {
    const seeded = await seed({});
    const result = await agentDone(seeded, githubStub({}));
    expect(result).toMatchObject({ refuse: true, reason: "not_on_origin", mode: "enforce" });
    expect(result!.message).toBe("Not done yet: commit 1111111 is not on GitHub. Push the work and name the commit that is there.");
  });

  it("refuses when GitHub cannot be asked, instead of guessing", async () => {
    const seeded = await seed({});
    const down = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const result = await agentDone(seeded, down as unknown as ReturnType<typeof githubStub>);
    expect(result).toMatchObject({ refuse: true, reason: "github_unreachable" });
  });

  it("refuses when the commit does not change a file the task names", async () => {
    const seeded = await seed({});
    const result = await agentDone(seeded, githubStub({ [SHA]: { files: ["server/src/a.ts"], ci: GREEN } }));
    expect(result).toMatchObject({ refuse: true, reason: "files_not_touched" });
    expect(result!.message).toBe("Not done yet: commit 1111111 does not change docs/x.md, which the task names.");
  });

  it("needs EVERY named file, across the evidence commits together", async () => {
    const seeded = await seed({
      description: "## Acceptance Criteria\n- `docs/x.md` and `server/src/a.ts`\n",
    });
    const fetchImpl = githubStub({
      [SHA]: { files: ["docs/x.md"], ci: GREEN },
      [SHA_B]: { files: ["server/src/a.ts"], ci: GREEN },
    });
    expect(await agentDone(seeded, fetchImpl, { note: `Docs in commit ${SHA}.` })).toMatchObject({ reason: "files_not_touched" });
    expect(await agentDone(seeded, fetchImpl, { note: `Docs in commit ${SHA} and code in commit ${SHA_B}.` })).toBeNull();
  });

  it("refuses failed checks and names them", async () => {
    const seeded = await seed({});
    const result = await agentDone(
      seeded,
      githubStub({
        [SHA]: {
          files: ["docs/x.md"],
          ci: { runs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "General tests (server 2/3)", status: "completed", conclusion: "failure" }] },
        },
      }),
    );
    expect(result).toMatchObject({ refuse: true, reason: "checks_failed" });
    expect(result!.message).toBe("Not done yet: the checks for 1111111 failed: General tests (server 2/3).");
  });

  it("refuses while checks are still running", async () => {
    const seeded = await seed({});
    const result = await agentDone(
      seeded,
      githubStub({ [SHA]: { files: ["docs/x.md"], ci: { runs: [{ name: "e2e", status: "in_progress", conclusion: null }] } } }),
    );
    expect(result).toMatchObject({ refuse: true, reason: "checks_pending" });
    expect(result!.message).toContain("still running");
  });

  it("refuses a commit with no check result at all in enforce mode", async () => {
    const seeded = await seed({});
    const result = await agentDone(seeded, githubStub({ [SHA]: { files: ["docs/x.md"] } }));
    expect(result).toMatchObject({ refuse: true, reason: "no_check_result" });
    expect(result!.message).toContain("no check result");
  });

  it("passes the file check and says so when the task names no files", async () => {
    const seeded = await seed({ description: "## Acceptance Criteria\n- it works\n" });
    expect(await agentDone(seeded, githubStub({ [SHA]: { files: ["whatever.ts"], ci: GREEN } }))).toBeNull();
    const failing = await agentDone(
      seeded,
      githubStub({ [SHA]: { files: ["whatever.ts"], ci: { runs: [{ name: "build", status: "completed", conclusion: "failure" }] } } }),
    );
    expect(failing!.message).toContain("The task names no files, so this did not check which files the commit changes.");
  });

  it("refuses when no commit is named anywhere", async () => {
    const seeded = await seed({});
    const result = await agentDone(seeded, githubStub({}), { note: "All done, 29 tests pass." });
    expect(result).toMatchObject({ refuse: true, reason: "no_commit" });
  });

  it("takes evidence from a commit work product and from the merge commit of an approved merge_pr approval for this issue", async () => {
    const seeded = await seed({});
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      type: "commit",
      provider: "github",
      externalId: SHA,
      title: "The fix",
      status: "active",
    });
    expect(await agentDone(seeded, githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN } }), { note: "Finished." })).toBeNull();

    await db.delete(issueWorkProducts);
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId: seeded.companyId,
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", mergeCommitSha: SHA_B, originalIssueIds: [seeded.issueId] },
    });
    await db.insert(issueApprovals).values({ companyId: seeded.companyId, issueId: seeded.issueId, approvalId });
    expect(await agentDone(seeded, githubStub({ [SHA_B]: { files: ["docs/x.md"], ci: GREEN } }), { note: "Finished." })).toBeNull();
  });

  it("does not take a merge_pr approval that was filed for a different issue as evidence", async () => {
    const seeded = await seed({});
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId: seeded.companyId,
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", mergeCommitSha: SHA_B, originalIssueIds: [randomUUID()] },
    });
    await db.insert(issueApprovals).values({ companyId: seeded.companyId, issueId: seeded.issueId, approvalId });
    const result = await agentDone(seeded, githubStub({ [SHA_B]: { files: ["docs/x.md"], ci: GREEN } }), { note: "Finished." });
    expect(result).toMatchObject({ reason: "no_commit" });
  });

  it("lets a board user through untouched: the human override", async () => {
    const seeded = await seed({});
    const fetchImpl = githubStub({});
    expect(await agentDone(seeded, fetchImpl, { actorType: "user" })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("only looks at a move into done", async () => {
    const seeded = await seed({});
    const fetchImpl = githubStub({});
    expect(await agentDone(seeded, fetchImpl, { requestedStatus: "in_review" })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("report mode posts the same note but does not refuse", async () => {
    const seeded = await seed({ mode: "report" });
    const result = await agentDone(seeded, githubStub({}));
    expect(result).toMatchObject({ refuse: false, mode: "report", reason: "not_on_origin" });
    expect(result!.message).toContain("1111111");
    expect(result!.message).not.toMatch(/^Not done yet/);
  });

  it("is invisible when the company mode is off, or the company never chose (no settings row)", async () => {
    const fetchImpl = githubStub({});
    expect(await agentDone(await seed({ mode: "off" }), fetchImpl)).toBeNull();
    expect(await agentDone(await seed({ mode: null }), fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a non-code ticket alone: no git workspace, or a workspace that is not on GitHub", async () => {
    const fetchImpl = githubStub({});
    expect(await agentDone(await seed({ repoUrl: null }), fetchImpl)).toBeNull();
    expect(await agentDone(await seed({ repoUrl: "https://gitlab.com/acme/widgets" }), fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
