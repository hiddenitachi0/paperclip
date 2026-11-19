import { describe, expect, it, vi } from "vitest";
import { fetchCommitCiStatus } from "./commit-ci-status.js";

const REPO = { owner: "acme", name: "widgets" };
const SHA = "a".repeat(40);

type Run = { name: string; status: string; conclusion: string | null };
const run = (name: string, status = "completed", conclusion: string | null = "success"): Run => ({ name, status, conclusion });

/** A GitHub stub: combined status plus the check-runs, paged the way the real API pages them. */
function githubStub(input: {
  status?: unknown;
  runs?: Run[];
  statusHttp?: number;
  runsHttp?: number;
}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/status")) {
      if (input.statusHttp) return new Response("nope", { status: input.statusHttp });
      return new Response(JSON.stringify(input.status ?? { state: "pending", total_count: 0, statuses: [] }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/check-runs")) {
      if (input.runsHttp) return new Response("nope", { status: input.runsHttp });
      const runs = input.runs ?? [];
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const perPage = Number(parsed.searchParams.get("per_page") ?? "30");
      return new Response(
        JSON.stringify({ total_count: runs.length, check_runs: runs.slice((page - 1) * perPage, page * perPage) }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, calls };
}

describe("fetchCommitCiStatus", () => {
  it("is green when every check run finished green (neutral and skipped count as green)", async () => {
    const { fetchImpl } = githubStub({
      runs: [run("build"), run("lint", "completed", "neutral"), run("optional", "completed", "skipped")],
    });
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toEqual({ state: "green", failedChecks: [], pendingChecks: [] });
  });

  it("is green with only a successful combined status and no check runs", async () => {
    const { fetchImpl } = githubStub({ status: { state: "success", total_count: 1, statuses: [{ context: "ci/legacy", state: "success" }] } });
    expect((await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).state).toBe("green");
  });

  it("is none when the commit has no check run and no commit status at all", async () => {
    const { fetchImpl } = githubStub({});
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toEqual({ state: "none", failedChecks: [], pendingChecks: [] });
  });

  it("is pending while a check is queued or running, and names it", async () => {
    const { fetchImpl } = githubStub({ runs: [run("build"), run("General tests (server 2/3)", "in_progress", null), run("e2e", "queued", null)] });
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toEqual({
      state: "pending",
      failedChecks: [],
      pendingChecks: ["General tests (server 2/3)", "e2e"],
    });
  });

  it("is pending when the combined status is pending", async () => {
    const { fetchImpl } = githubStub({
      status: { state: "pending", total_count: 1, statuses: [{ context: "ci/legacy", state: "pending" }] },
      runs: [run("build")],
    });
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toMatchObject({ state: "pending", pendingChecks: ["ci/legacy"] });
  });

  it("is failed and names the failed checks", async () => {
    const { fetchImpl } = githubStub({ runs: [run("build"), run("General tests (server 2/3)", "completed", "failure")] });
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toEqual({
      state: "failed",
      failedChecks: ["General tests (server 2/3)"],
      pendingChecks: [],
    });
  });

  it("counts cancelled, timed out and action-required runs as failed", async () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale", "startup_failure"]) {
      const { fetchImpl } = githubStub({ runs: [run("build", "completed", conclusion)] });
      expect((await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).state).toBe("failed");
    }
  });

  it("lets red win over pending: a finished red check is terminal while others still run", async () => {
    const { fetchImpl } = githubStub({ runs: [run("e2e", "in_progress", null), run("build", "completed", "failure")] });
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toEqual({
      state: "failed",
      failedChecks: ["build"],
      pendingChecks: ["e2e"],
    });
  });

  it("is failed when the combined status is red, naming the failing context", async () => {
    const { fetchImpl } = githubStub({
      status: { state: "failure", total_count: 2, statuses: [{ context: "ci/legacy", state: "failure" }, { context: "ci/other", state: "success" }] },
      runs: [run("build")],
    });
    expect(await fetchCommitCiStatus(REPO, SHA, { fetchImpl })).toMatchObject({ state: "failed", failedChecks: ["ci/legacy"] });
  });

  it("reads every page of check runs, so a red check on page 2 is not missed", async () => {
    const runs = Array.from({ length: 100 }, (_, i) => run(`job-${i}`));
    runs.push(run("late-failure", "completed", "failure"));
    const { fetchImpl, calls } = githubStub({ runs });
    const result = await fetchCommitCiStatus(REPO, SHA, { fetchImpl });
    expect(result).toMatchObject({ state: "failed", failedChecks: ["late-failure"] });
    expect(calls.filter((url) => url.includes("/check-runs"))).toHaveLength(2);
    expect(calls.find((url) => url.includes("/check-runs"))).toContain("per_page=100");
  });

  it("is unknown (never green) when GitHub errors, is unreachable, or the sha is not a sha", async () => {
    expect((await fetchCommitCiStatus(REPO, SHA, { fetchImpl: githubStub({ statusHttp: 500 }).fetchImpl })).state).toBe("unknown");
    expect((await fetchCommitCiStatus(REPO, SHA, { fetchImpl: githubStub({ runsHttp: 403 }).fetchImpl })).state).toBe("unknown");
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    expect((await fetchCommitCiStatus(REPO, SHA, { fetchImpl: down })).state).toBe("unknown");
    const untouched = vi.fn();
    expect((await fetchCommitCiStatus(REPO, "../etc/passwd", { fetchImpl: untouched })).state).toBe("unknown");
    expect(untouched).not.toHaveBeenCalled();
  });

  it("sends the token when one is given and none when it is not", async () => {
    const withToken = githubStub({ runs: [run("build")] });
    await fetchCommitCiStatus(REPO, SHA, { fetchImpl: withToken.fetchImpl, token: "ghp_secret" });
    expect((withToken.fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer ghp_secret" });
    const without = githubStub({ runs: [run("build")] });
    await fetchCommitCiStatus(REPO, SHA, { fetchImpl: without.fetchImpl, token: null });
    expect((without.fetchImpl.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty("authorization");
  });
});
