import { describe, expect, it, vi } from "vitest";
import {
  checkGitHubTokenForRepo,
  describeGitHubTokenRequirements,
  evaluateGitHubTokenScopes,
  GitHubTokenCheckError,
  parseGitHubRepoUrl,
} from "../services/github-token-check.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fake GitHub: routes by path suffix, records every request. */
function fakeGitHub(routes: Record<string, () => Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = new Headers(init?.headers);
    calls.push({ url: href, auth: headers.get("authorization") });
    const path = new URL(href).pathname + new URL(href).search;
    const key = Object.keys(routes).find((candidate) => path === candidate || path.startsWith(`${candidate}?`));
    if (!key) return new Response("not found", { status: 404 });
    return routes[key]!();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("parseGitHubRepoUrl", () => {
  it("parses https, .git and ssh forms", () => {
    expect(parseGitHubRepoUrl("https://github.com/acme/dashboard")).toEqual({ hostname: "github.com", owner: "acme", name: "dashboard" });
    expect(parseGitHubRepoUrl("https://github.com/acme/dashboard.git/")).toEqual({ hostname: "github.com", owner: "acme", name: "dashboard" });
    expect(parseGitHubRepoUrl("git@github.com:acme/dashboard.git")).toEqual({ hostname: "github.com", owner: "acme", name: "dashboard" });
    expect(parseGitHubRepoUrl("https://ghe.example.com/acme/dashboard")).toEqual({ hostname: "ghe.example.com", owner: "acme", name: "dashboard" });
  });

  it("rejects things that are not repositories", () => {
    expect(parseGitHubRepoUrl("")).toBeNull();
    expect(parseGitHubRepoUrl("https://github.com/acme")).toBeNull();
    expect(parseGitHubRepoUrl("/root/dashboard")).toBeNull();
  });
});

describe("describeGitHubTokenRequirements", () => {
  it("always names repo, and names workflow conditionally until the repo is checked", () => {
    const unknown = describeGitHubTokenRequirements({ hasWorkflows: null });
    expect(unknown.map((r) => r.scope)).toEqual(["repo", "workflow"]);
    expect(unknown[1]!.required).toBe(true);
    expect(unknown[1]!.why).toMatch(/only if the repository has CI files/);

    const without = describeGitHubTokenRequirements({ hasWorkflows: false });
    expect(without[1]!.required).toBe(false);
    expect(without[1]!.why).toMatch(/not needed/);
  });
});

describe("evaluateGitHubTokenScopes", () => {
  it("passes a classic token with repo + workflow on a repo with CI files", () => {
    const result = evaluateGitHubTokenScopes({
      scopesHeader: "repo, workflow, read:org",
      repoPermissions: { push: true },
      repoPrivate: true,
      hasWorkflows: true,
      tokenKind: "classic",
    });
    expect(result.map((r) => [r.scope, r.status])).toEqual([
      ["repo", "ok"],
      ["workflow", "ok"],
    ]);
  });

  it("flags the missing workflow scope by name on a classic token", () => {
    const result = evaluateGitHubTokenScopes({
      scopesHeader: "repo",
      repoPermissions: { push: true },
      repoPrivate: true,
      hasWorkflows: true,
      tokenKind: "classic",
    });
    expect(result[1]).toMatchObject({ scope: "workflow", status: "missing" });
    expect(result[1]!.note).toMatch(/tick the "workflow" scope/);
  });

  it("does not demand workflow when the repo has no CI files", () => {
    const result = evaluateGitHubTokenScopes({
      scopesHeader: "repo",
      repoPermissions: { push: true },
      repoPrivate: true,
      hasWorkflows: false,
      tokenKind: "classic",
    });
    expect(result[1]).toMatchObject({ scope: "workflow", status: "ok", required: false });
  });

  it("treats public_repo as insufficient for a private repository", () => {
    const result = evaluateGitHubTokenScopes({
      scopesHeader: "public_repo, workflow",
      repoPermissions: { push: true },
      repoPrivate: true,
      hasWorkflows: false,
      tokenKind: "classic",
    });
    expect(result[0]).toMatchObject({ scope: "repo", status: "missing" });
    expect(result[0]!.note).toMatch(/public_repo/);
  });

  it("flags a classic token whose user cannot push even though the scope is there", () => {
    const result = evaluateGitHubTokenScopes({
      scopesHeader: "repo",
      repoPermissions: { push: false },
      repoPrivate: true,
      hasWorkflows: false,
      tokenKind: "classic",
    });
    expect(result[0]).toMatchObject({ scope: "repo", status: "missing" });
    expect(result[0]!.note).toMatch(/cannot push/);
  });

  it("uses repo permissions for a fine-grained token and reports workflow as unconfirmed", () => {
    const result = evaluateGitHubTokenScopes({
      scopesHeader: null,
      repoPermissions: { push: true },
      repoPrivate: true,
      hasWorkflows: true,
      tokenKind: "fine_grained",
    });
    expect(result[0]).toMatchObject({ scope: "repo", status: "ok" });
    expect(result[1]).toMatchObject({ scope: "workflow", status: "unknown" });
    expect(result[1]!.note).toMatch(/Workflows: read and write/);
  });
});

describe("checkGitHubTokenForRepo", () => {
  it("builds a full report from the three GitHub calls and never echoes the token", async () => {
    const github = fakeGitHub({
      "/user": () => jsonResponse(200, { login: "filip" }, { "x-oauth-scopes": "repo" }),
      "/repos/acme/dashboard": () => jsonResponse(200, { private: true, default_branch: "main", permissions: { push: true } }),
      "/repos/acme/dashboard/contents/.github/workflows": () => jsonResponse(200, [{ name: "ci.yml" }]),
    });
    const report = await checkGitHubTokenForRepo({
      token: "ghp_secret_value_123",
      repoUrl: "https://github.com/acme/dashboard",
      fetchImpl: github.fetchImpl,
    });

    expect(github.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/repos/acme/dashboard",
      "https://api.github.com/repos/acme/dashboard/contents/.github/workflows?ref=main",
    ]);
    expect(github.calls.every((call) => call.auth === "Bearer ghp_secret_value_123")).toBe(true);

    expect(report.tokenKind).toBe("classic");
    expect(report.login).toBe("filip");
    expect(report.hasWorkflows).toBe(true);
    expect(report.repo).toEqual({ owner: "acme", name: "dashboard", hostname: "github.com", private: true, defaultBranch: "main" });
    expect(report.scopes.map((s) => [s.scope, s.status])).toEqual([
      ["repo", "ok"],
      ["workflow", "missing"],
    ]);
    expect(report.ok).toBe(false);
    expect(report.summary).toBe('The GitHub token (signed in to GitHub as filip) is missing: "workflow". Agents will get stuck until it is added.');
    expect(JSON.stringify(report)).not.toContain("ghp_secret_value_123");
  });

  it("reports all-clear when the repo has no workflows", async () => {
    const github = fakeGitHub({
      "/user": () => jsonResponse(200, { login: "filip" }, { "x-oauth-scopes": "repo" }),
      "/repos/acme/dashboard": () => jsonResponse(200, { private: false, default_branch: "main", permissions: { push: true } }),
      "/repos/acme/dashboard/contents/.github/workflows": () => new Response("nope", { status: 404 }),
    });
    const report = await checkGitHubTokenForRepo({ token: "ghp_x", repoUrl: "https://github.com/acme/dashboard", fetchImpl: github.fetchImpl });
    expect(report.hasWorkflows).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatch(/has everything this project needs/);
  });

  it("explains a rejected token and an invisible repository in plain words", async () => {
    const rejected = fakeGitHub({ "/user": () => new Response("", { status: 401 }) });
    await expect(
      checkGitHubTokenForRepo({ token: "ghp_bad", repoUrl: "https://github.com/acme/dashboard", fetchImpl: rejected.fetchImpl }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/invalid, expired or has been revoked/) });

    const invisible = fakeGitHub({
      "/user": () => jsonResponse(200, { login: "filip" }, { "x-oauth-scopes": "repo" }),
      "/repos/acme/dashboard": () => new Response("", { status: 404 }),
    });
    await expect(
      checkGitHubTokenForRepo({ token: "ghp_x", repoUrl: "https://github.com/acme/dashboard", fetchImpl: invisible.fetchImpl }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/cannot see acme\/dashboard/) });
  });

  it("refuses a repo address that is not GitHub-shaped", async () => {
    await expect(checkGitHubTokenForRepo({ token: "ghp_x", repoUrl: "/root/dashboard" })).rejects.toBeInstanceOf(GitHubTokenCheckError);
  });

  it("talks to a GitHub Enterprise host through its /api/v3 base", async () => {
    const github = fakeGitHub({
      "/api/v3/user": () => jsonResponse(200, { login: "filip" }, { "x-oauth-scopes": "repo, workflow" }),
      "/api/v3/repos/acme/dashboard": () => jsonResponse(200, { private: true, default_branch: "main", permissions: { push: true } }),
      "/api/v3/repos/acme/dashboard/contents/.github/workflows": () => new Response("", { status: 404 }),
    });
    const report = await checkGitHubTokenForRepo({ token: "ghp_x", repoUrl: "https://ghe.example.com/acme/dashboard", fetchImpl: github.fetchImpl });
    expect(github.calls[0]!.url).toBe("https://ghe.example.com/api/v3/user");
    expect(report.ok).toBe(true);
  });
});
