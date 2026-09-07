/**
 * DUR-291: company-level deploy-branch resolution for issues that have no project.
 * Exercises the pure repo parser and the resolver's decision table against a fake
 * drizzle chain (issues -> projects -> project_workspaces, dispatched by call order).
 */
import { describe, expect, it } from "vitest";
import { parseGitHubRepoReference, resolveFallbackDeployBranches } from "../services/deploy-branch-fallback.js";

// resolveFallbackDeployBranches issues, in order: issues lookup (only when issueIds is
// non-empty), projects lookup, and -- only when several projects match -- a
// project_workspaces lookup. Each `select().from().where()` resolves the next queued rows.
function fakeDb(queued: unknown[][]) {
  const queue = [...queued];
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(queue.shift() ?? []),
      }),
    }),
  } as any;
}

describe("parseGitHubRepoReference", () => {
  it("accepts owner/name, https and ssh forms, case-insensitively, with or without .git", () => {
    expect(parseGitHubRepoReference("Acme/Paperclip")).toEqual({ owner: "acme", name: "paperclip" });
    expect(parseGitHubRepoReference("https://github.com/acme/paperclip.git")).toEqual({ owner: "acme", name: "paperclip" });
    expect(parseGitHubRepoReference("https://github.com/acme/paperclip/")).toEqual({ owner: "acme", name: "paperclip" });
    expect(parseGitHubRepoReference("git@github.com:acme/paperclip.git")).toEqual({ owner: "acme", name: "paperclip" });
  });

  it("rejects anything that is not a repo reference", () => {
    expect(parseGitHubRepoReference("")).toBeNull();
    expect(parseGitHubRepoReference("paperclip")).toBeNull();
    expect(parseGitHubRepoReference(42)).toBeNull();
    expect(parseGitHubRepoReference(null)).toBeNull();
  });
});

describe("resolveFallbackDeployBranches", () => {
  const input = { companyId: "company-1", issueIds: ["issue-1"], bases: ["custom"], repo: "acme/paperclip" };

  it("stays out of it when the issue has a project of its own", async () => {
    const db = fakeDb([[{ projectId: "project-9" }]]);
    const result = await resolveFallbackDeployBranches(db, input);
    expect(result).toEqual({ branches: null, issueHasProject: true, reason: "issue_has_project" });
  });

  it("resolves the one company project that deploys from the merge's target branch", async () => {
    const db = fakeDb([
      [{ projectId: null }],
      [{ id: "project-1", deployPolicy: { deployBranch: "custom", mirrorBranch: "master" } }],
    ]);
    const result = await resolveFallbackDeployBranches(db, input);
    expect(result.reason).toBe("resolved_unique");
    expect(result.issueHasProject).toBe(false);
    expect(result.branches).toEqual({
      projectId: "project-1",
      deployBranch: "custom",
      mirrorBranch: "master",
      resolvedViaFallback: true,
    });
  });

  it("reports no match (not a guess) when no project deploys from that branch", async () => {
    const db = fakeDb([[{ projectId: null }], []]);
    const result = await resolveFallbackDeployBranches(db, input);
    expect(result).toEqual({ branches: null, issueHasProject: false, reason: "no_matching_project" });
  });

  it("disambiguates several matching projects by the repo the merge approval names", async () => {
    const db = fakeDb([
      [{ projectId: null }],
      [
        { id: "project-a", deployPolicy: { deployBranch: "custom" } },
        { id: "project-b", deployPolicy: { deployBranch: "custom" } },
      ],
      [
        { projectId: "project-a", repoUrl: "https://github.com/acme/other.git" },
        { projectId: "project-b", repoUrl: "git@github.com:acme/paperclip.git" },
      ],
    ]);
    const result = await resolveFallbackDeployBranches(db, input);
    expect(result.reason).toBe("resolved_by_repo");
    expect(result.branches?.projectId).toBe("project-b");
  });

  it("gives up as ambiguous when several projects match and the repo does not single one out", async () => {
    const db = fakeDb([
      [{ projectId: null }],
      [
        { id: "project-a", deployPolicy: { deployBranch: "custom" } },
        { id: "project-b", deployPolicy: { deployBranch: "custom" } },
      ],
      [
        { projectId: "project-a", repoUrl: "https://github.com/acme/paperclip" },
        { projectId: "project-b", repoUrl: "https://github.com/acme/paperclip" },
      ],
    ]);
    const result = await resolveFallbackDeployBranches(db, input);
    expect(result).toEqual({ branches: null, issueHasProject: false, reason: "ambiguous" });
  });

  it("needs a base branch to do anything at all", async () => {
    const db = fakeDb([[{ projectId: null }]]);
    const result = await resolveFallbackDeployBranches(db, { ...input, bases: ["", "  "] });
    expect(result).toEqual({ branches: null, issueHasProject: false, reason: "no_base" });
  });
});
