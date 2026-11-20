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
import { evaluateDoneEvidenceGate, extractAcceptanceCriteriaPaths, hasRecentIdenticalNote } from "./done-evidence-gate.js";

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

  it("does not turn routes, branch-like names, content types or packages into required files beyond what the repo check can drop", () => {
    const description = [
      "## Acceptance Criteria",
      "- `GET /issues/:id` answers and `/DUR/dashboard/now` renders",
      "- sends `application/json` from `@paperclipai/shared` (see `paperclipai/paperclip`)",
      "- merged to `origin/custom` and `feat/x`",
    ].join("\n");
    const found = extractAcceptanceCriteriaPaths(description);
    // Routes, scoped packages and the content-type-with-colon style tokens never become paths ...
    expect(found.map((p) => p.path)).not.toContain("issues/:id");
    expect(found.map((p) => p.path)).not.toContain("DUR/dashboard/now");
    expect(found.map((p) => p.path)).not.toContain("@paperclipai/shared");
    // ... and the folder-like leftovers are flagged as folders, which the gate drops when they do not exist.
    expect(found.every((p) => p.dir)).toBe(true);
  });

  it("strips a trailing slash, reads markdown link targets, and skips lines that say what must not change", () => {
    const description = [
      "## Acceptance Criteria",
      "- the folder `ui/src/` is updated",
      "- documented in [the guide](docs/a.md)",
      "- Do not change `package.json` and leave `server/src/keep.ts` unchanged",
    ].join("\n");
    expect(extractAcceptanceCriteriaPaths(description)).toEqual([
      { path: "docs/a.md", dir: false },
      { path: "ui/src", dir: true },
    ]);
  });

  it("never requires a file the task says must not change (DUR-5209 review)", () => {
    const description = [
      "## Acceptance Criteria",
      "- `pnpm-lock.yaml` must not change",
      "- `package.json` should not be modified",
      "- `README.md` is not changed",
      "- works for `server/x.ts` but not `server/y.ts`",
      "- the lockfile `CHANGELOG.md` don't touch",
      "- `server/z.ts` returns 409 when the token is not set",
      "- `server/w.ts` does not crash on an empty body",
    ].join("\n");
    const found = paths(description);
    expect(found).toEqual(expect.arrayContaining(["server/x.ts", "server/z.ts", "server/w.ts"]));
    for (const dropped of ["pnpm-lock.yaml", "package.json", "README.md", "server/y.ts", "CHANGELOG.md"]) {
      expect(found).not.toContain(dropped);
    }
  });

  it("only skips a path when the negation is about that path (DUR-5209)", () => {
    const description = [
      "## Acceptance Criteria",
      "- `server/x.ts` returns 409 when the token is not set",
      "- Do not change `package.json`",
      "- `pnpm-lock.yaml` must stay unchanged",
      "- Update `docs/a.md`, but never touch `docs/b.md`",
      "- `ui/c.tsx` must not be imported by `server/d.ts`; change `server/e.ts`",
      "- Everything except `README.md` is covered",
      "- No changes to `LICENSE.md` and `server/f.ts` is edited",
    ].join("\n");
    const found = paths(description);
    expect(found).toEqual(expect.arrayContaining(["server/x.ts", "docs/a.md", "server/e.ts", "ui/c.tsx"]));
    expect(found).not.toContain("package.json");
    expect(found).not.toContain("pnpm-lock.yaml");
    expect(found).not.toContain("docs/b.md");
    expect(found).not.toContain("README.md");
    expect(found).not.toContain("LICENSE.md");
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

type CiFixture = { runs?: Array<{ name: string; status: string; conclusion: string | null }>; status?: unknown };
type CommitFixture = {
  files: string[];
  ci?: CiFixture;
  /** parent shas; two parents = a merge commit (the second is the pull request head) */
  parents?: string[];
  committedAt?: string;
  message?: string;
  /** false = on GitHub but not on the project's branch (a fork-only or stray-branch commit) */
  onBranch?: boolean;
  /** paths that exist in the repo at this commit besides its files */
  contents?: string[];
};

/**
 * GitHub stub: /commits/{sha} (200 only for known shas), /commits/{sha}/status and /check-runs,
 * /compare/{branch}...{sha} and /contents/{path}. `extraCi` serves checks for shas that are not
 * commits of their own (a pull request head).
 */
type StubOptions = {
  /** GET /repos/{o}/{r}: status and default branch (default 200 / "main") */
  repo?: { status: number; defaultBranch?: string };
  /** branches that exist; compare against any other branch is a 404 (default: every branch exists) */
  branches?: string[];
  /** status to answer for every /status and /check-runs request (a token that cannot read checks, a rate limit) */
  checksStatus?: number;
};

function githubStub(commits: Record<string, CommitFixture>, extraCi: Record<string, CiFixture> = {}, options: StubOptions = {}) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const parsed = new URL(url);
    if (/^\/repos\/[^/]+\/[^/]+$/.test(parsed.pathname)) {
      const repo = options.repo ?? { status: 200 };
      return new Response(repo.status === 200 ? JSON.stringify({ default_branch: repo.defaultBranch ?? "main" }) : "no", { status: repo.status });
    }
    const compare = parsed.pathname.match(/\/compare\/(.+)\.\.\.([0-9a-f]+)$/);
    if (compare) {
      if (options.branches && !options.branches.includes(decodeURIComponent(compare[1]!))) return new Response("not found", { status: 404 });
      const fixture = commits[compare[2]!];
      if (!fixture) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ status: fixture.onBranch === false ? "ahead" : "behind" }), { status: 200 });
    }
    const contents = parsed.pathname.match(/\/contents\/(.+)$/);
    if (contents) {
      const wanted = decodeURIComponent(contents[1]!);
      const ref = parsed.searchParams.get("ref") ?? "";
      const fixture = commits[ref];
      const exists = Boolean(fixture && (fixture.contents ?? []).some((path) => path === wanted || path.startsWith(`${wanted}/`)));
      return new Response(exists ? "{}" : "not found", { status: exists ? 200 : 404 });
    }
    const match = parsed.pathname.match(/\/commits\/([0-9a-f]+)(\/status|\/check-runs)?$/);
    const sha = match?.[1];
    const fixture = sha ? commits[sha] : undefined;
    const ci = sha ? (fixture?.ci ?? extraCi[sha]) : undefined;
    if (!sha || (!fixture && !extraCi[sha])) return new Response("not found", { status: 404 });
    if (options.checksStatus && match![2]) return new Response("no", { status: options.checksStatus });
    if (match![2] === "/status") {
      return new Response(JSON.stringify(ci?.status ?? { state: "pending", total_count: 0, statuses: [] }), { status: 200 });
    }
    if (match![2] === "/check-runs") {
      const runs = ci?.runs ?? [];
      return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        sha,
        parents: (fixture!.parents ?? []).map((parent) => ({ sha: parent })),
        commit: { message: fixture!.message ?? "A change", committer: { date: fixture!.committedAt ?? new Date().toISOString() } },
        files: fixture!.files.map((filename) => ({ filename })),
      }),
      { status: 200 },
    );
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
    createdAt?: Date;
    /** the project's branch; null = the project names none */
    repoRef?: string | null;
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
        repoRef: input.repoRef === undefined ? "custom" : input.repoRef,
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
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    if (input.mode !== null) {
      await db.insert(companyQualityLoopSettings).values({ companyId, doneEvidenceMode: input.mode ?? "enforce" });
    }
    return { companyId, agentId, projectId, issueId, description, identifier: `${issuePrefix}-1`, createdAt: input.createdAt ?? new Date() };
  }

  function agentDone(
    seeded: Awaited<ReturnType<typeof seed>>,
    fetchImpl: ReturnType<typeof githubStub>,
    overrides: {
      note?: string | null;
      actorType?: string;
      requestedStatus?: string;
      token?: string | null;
      otherNoteAgentIds?: string[];
      actorAgentId?: string;
    } = {},
  ) {
    return evaluateDoneEvidenceGate({
      db,
      issue: {
        id: seeded.issueId,
        identifier: seeded.identifier,
        companyId: seeded.companyId,
        projectId: seeded.projectId,
        description: seeded.description,
        createdAt: seeded.createdAt,
      },
      otherNoteAgentIds: overrides.otherNoteAgentIds,
      actor: { actorType: overrides.actorType ?? "agent", agentId: overrides.actorType === "user" ? null : (overrides.actorAgentId ?? seeded.agentId), runId: randomUUID() },
      requestedStatus: overrides.requestedStatus ?? "done",
      currentStatus: "in_progress",
      patchComment: overrides.note === undefined ? `Done in commit ${SHA}.` : overrides.note,
      deps: { fetchImpl, getGitHubToken: async () => (overrides.token === undefined ? "ghp_test" : overrides.token) },
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

  it("treats a folder-like name that does not exist in the repository as not a file (a branch, a content type)", async () => {
    const seeded = await seed({
      description: "## Acceptance Criteria\n- `docs/x.md` is updated and merged to `origin/custom` as `application/json`\n",
    });
    const fetchImpl = githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN } });
    expect(await agentDone(seeded, fetchImpl)).toBeNull();
  });

  it("still requires a folder that does exist in the repository to be touched", async () => {
    const seeded = await seed({ description: "## Acceptance Criteria\n- `ui/src/components` is updated\n" });
    const untouched = githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN, contents: ["ui/src/components/A.tsx"] } });
    expect(await agentDone(seeded, untouched)).toMatchObject({ reason: "files_not_touched" });
    const touched = githubStub({ [SHA]: { files: ["ui/src/components/A.tsx"], ci: GREEN, contents: ["ui/src/components/A.tsx"] } });
    expect(await agentDone(seeded, touched)).toBeNull();
  });

  it("refuses a commit that is on GitHub but not on the project's branch (fork-only or stray branch)", async () => {
    const seeded = await seed({});
    const result = await agentDone(seeded, githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN, onBranch: false } }));
    expect(result).toMatchObject({ refuse: true, reason: "not_on_branch" });
    expect(result!.message).toBe(
      "Not done yet: commit 1111111 is on GitHub but not on custom yet. Merge it, then name the commit that is on custom.",
    );
  });

  it("for a merge commit also needs the pull request head (second parent) green", async () => {
    const seeded = await seed({});
    const HEAD = "3".repeat(40);
    const lockfileOnly = { runs: [{ name: "refresh", status: "completed", conclusion: "success" }] };
    const red = { runs: [{ name: "General tests", status: "completed", conclusion: "failure" }] };
    const base = { files: ["docs/x.md"], ci: lockfileOnly, parents: ["4".repeat(40), HEAD] };
    const failing = await agentDone(seeded, githubStub({ [SHA]: base }, { [HEAD]: red }));
    expect(failing).toMatchObject({ refuse: true, reason: "checks_failed" });
    expect(failing!.message).toBe("Not done yet: the checks for 3333333 (the pull request behind 1111111) failed: General tests.");
    expect(await agentDone(seeded, githubStub({ [SHA]: base }, { [HEAD]: GREEN }))).toBeNull();
    // A merge commit with no checks of its own is fine when the pull request head is green.
    expect(await agentDone(seeded, githubStub({ [SHA]: { ...base, ci: undefined } }, { [HEAD]: GREEN }))).toBeNull();
    // ... but a pull request head with no result is not a pass.
    expect(await agentDone(seeded, githubStub({ [SHA]: base }, { [HEAD]: {} }))).toMatchObject({ reason: "no_check_result" });
  });

  it("says Paperclip has no GitHub access when there is no token and GitHub answers 404", async () => {
    const seeded = await seed({});
    const result = await agentDone(seeded, githubStub({}), { token: null });
    expect(result).toMatchObject({ refuse: true, reason: "no_github_access" });
    expect(result!.message).toContain("Paperclip has no GitHub access for this company");
    expect(result!.message).not.toContain("not on GitHub");
  });

  it("treats 401, 403 and 429 as GitHub could not be reached, never as not pushed", async () => {
    const seeded = await seed({});
    for (const status of [401, 403, 429]) {
      const denied = vi.fn(async (_url: string, _init?: RequestInit) => new Response("no", { status }));
      const result = await agentDone(seeded, denied as unknown as ReturnType<typeof githubStub>);
      expect(result).toMatchObject({ refuse: true, reason: "github_unreachable" });
    }
  });

  describe("the project's branch (DUR-5209)", () => {
    const onMain = { [SHA]: { files: ["docs/x.md"], ci: GREEN } };

    it("holds the commit to the repository's default branch when the project names none", async () => {
      const seeded = await seed({ repoRef: null });
      const fetchImpl = githubStub(onMain);
      expect(await agentDone(seeded, fetchImpl)).toBeNull();
      const compared = fetchImpl.mock.calls.map((call) => String(call[0])).find((url) => url.includes("/compare/"));
      expect(compared).toContain(`/compare/main...${SHA}`);

      const stray = await agentDone(seeded, githubStub({ [SHA]: { ...onMain[SHA], onBranch: false } }));
      expect(stray).toMatchObject({ refuse: true, reason: "not_on_branch" });
      expect(stray!.message).toContain("not on main yet");
    });

    it("falls back to the default branch when the named branch does not exist", async () => {
      const seeded = await seed({ repoRef: "gone" });
      expect(await agentDone(seeded, githubStub(onMain, {}, { branches: ["main"] }))).toBeNull();
      const stray = await agentDone(seeded, githubStub({ [SHA]: { ...onMain[SHA], onBranch: false } }, {}, { branches: ["main"] }));
      expect(stray).toMatchObject({ refuse: true, reason: "not_on_branch" });
      expect(stray!.message).toContain("not on main yet");
    });

    it("does not look at the default branch when the named branch exists", async () => {
      const seeded = await seed({});
      const fetchImpl = githubStub(onMain);
      expect(await agentDone(seeded, fetchImpl)).toBeNull();
      expect(fetchImpl.mock.calls.map((call) => new URL(String(call[0])).pathname)).not.toContain("/repos/acme/widgets");
    });

    it("refuses, never skips the check, when the default branch cannot be read", async () => {
      const seeded = await seed({ repoRef: null });
      expect(await agentDone(seeded, githubStub(onMain, {}, { repo: { status: 500 } }))).toMatchObject({ refuse: true, reason: "github_unreachable" });
      const denied = await agentDone(seeded, githubStub(onMain, {}, { repo: { status: 403 } }));
      expect(denied).toMatchObject({ refuse: true, reason: "github_unreachable" });
      expect(denied!.message).toContain("no access or rate limit");
    });
  });

  describe("a token that cannot read GitHub (DUR-5209)", () => {
    const NO_ACCESS = "GitHub could not be reached (no access or rate limit)";

    it("says so when the token cannot see the repository, instead of 'not on GitHub'", async () => {
      const seeded = await seed({});
      const result = await agentDone(seeded, githubStub({}, {}, { repo: { status: 404 } }));
      expect(result).toMatchObject({ refuse: true, reason: "github_unreachable" });
      expect(result!.message).toContain(NO_ACCESS);
      expect(result!.message).not.toContain("not on GitHub");
    });

    it("still says 'not on GitHub' when the token can see the repository and the commit is not in it", async () => {
      const seeded = await seed({});
      expect(await agentDone(seeded, githubStub({}))).toMatchObject({ reason: "not_on_origin" });
    });

    it("says the same in plain words for 401, 403 and 429 on the commit itself", async () => {
      const seeded = await seed({});
      for (const status of [401, 403, 429]) {
        const denied = vi.fn(async (_url: string, _init?: RequestInit) => new Response("no", { status }));
        const result = await agentDone(seeded, denied as unknown as ReturnType<typeof githubStub>);
        expect(result).toMatchObject({ refuse: true, reason: "github_unreachable" });
        expect(result!.message).toContain(NO_ACCESS);
      }
    });

    it("says it for a rate limit while reading checks, not 'no check result'", async () => {
      const seeded = await seed({});
      for (const status of [401, 403, 429]) {
        const result = await agentDone(seeded, githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN } }, {}, { checksStatus: status }));
        expect(result).toMatchObject({ refuse: true, reason: "github_unreachable" });
        expect(result!.message).toContain(NO_ACCESS);
        expect(result!.message).not.toContain("no check result");
      }
    });

    it("keeps 'no check result' for a commit GitHub simply has no checks for", async () => {
      const seeded = await seed({});
      expect(await agentDone(seeded, githubStub({ [SHA]: { files: ["docs/x.md"] } }))).toMatchObject({ reason: "no_check_result" });
    });

    it("says it for a rate limit on the branch comparison", async () => {
      const seeded = await seed({});
      const limited = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes("/compare/")) return new Response("slow down", { status: 429 });
        return githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN } })(url, _init);
      });
      const result = await agentDone(seeded, limited as unknown as ReturnType<typeof githubStub>);
      expect(result).toMatchObject({ refuse: true, reason: "github_unreachable" });
      expect(result!.message).toContain(NO_ACCESS);
    });
  });

  it("with no files named, refuses a commit older than the task unless it mentions the task", async () => {
    const seeded = await seed({ description: "## Acceptance Criteria\n- it works\n", createdAt: new Date() });
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const stale = await agentDone(seeded, githubStub({ [SHA]: { files: ["a.ts"], ci: GREEN, committedAt: old } }));
    expect(stale).toMatchObject({ refuse: true, reason: "commit_not_new" });
    expect(stale!.message).toContain(`does not mention ${seeded.identifier}`);
    const mentioned = githubStub({ [SHA]: { files: ["a.ts"], ci: GREEN, committedAt: old, message: `Fix the thing (${seeded.identifier})` } });
    expect(await agentDone(seeded, mentioned)).toBeNull();
  });

  it("reads the worker's done note when someone else approves (the review stage's return assignee)", async () => {
    const seeded = await seed({});
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId: seeded.companyId,
      name: "Reviewer",
      role: "reviewer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.agentId,
      body: `Finished: merged in commit ${SHA}.`,
    });
    const fetchImpl = githubStub({ [SHA]: { files: ["docs/x.md"], ci: GREEN } });
    // The reviewer approves with a comment that names no commit ...
    const without = await agentDone(seeded, fetchImpl, { actorAgentId: reviewerId, note: "## Review: APPROVED" });
    expect(without).toMatchObject({ reason: "no_commit" });
    // ... and once the worker (the return assignee) is named, the worker's note is read.
    const withWorker = await agentDone(seeded, fetchImpl, {
      actorAgentId: reviewerId,
      note: "## Review: APPROVED",
      otherNoteAgentIds: [reviewerId, seeded.agentId],
    });
    expect(withWorker).toBeNull();
  });

  it("recognises a refusal that was already posted a few minutes ago", async () => {
    const seeded = await seed({});
    const body = "Not done yet: commit 1111111 is not on GitHub. Push the work and name the commit that is there.";
    expect(await hasRecentIdenticalNote(db, { companyId: seeded.companyId, issueId: seeded.issueId, body })).toBe(false);
    await db.insert(issueComments).values({ companyId: seeded.companyId, issueId: seeded.issueId, body, authorType: "system" });
    expect(await hasRecentIdenticalNote(db, { companyId: seeded.companyId, issueId: seeded.issueId, body })).toBe(true);
    expect(await hasRecentIdenticalNote(db, { companyId: seeded.companyId, issueId: seeded.issueId, body: `${body} (different)` })).toBe(false);
    // Long after, the same words may be said again.
    expect(
      await hasRecentIdenticalNote(db, { companyId: seeded.companyId, issueId: seeded.issueId, body, now: new Date(Date.now() + 3600_000) }),
    ).toBe(false);
  });
});
