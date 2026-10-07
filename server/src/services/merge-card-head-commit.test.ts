/**
 * DUR-4601: a `merge_pr` card's `payload.commit` used to be entirely filer-supplied -- an
 * agent filing one with only `repo`/`prNumber` left it `null` forever, so
 * security-review.ts's `requestReview`/`recordVerdict` could never pass their
 * `mergePrHeadCommit` gate (422 "This card has no commit yet"). These tests cover the
 * GitHub resolution itself and its three call sites: card creation
 * (`withResolvedMergePrHeadCommit`), on-demand refresh (`refreshMergePrHeadCommit`), and the
 * startup backfill of already-open cards (`backfillOpenMergeCardHeadCommits`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSecretService = vi.hoisted(() => ({ resolveGitHubToken: vi.fn() }));
vi.mock("./secrets.js", () => ({ secretService: () => mockSecretService }));

beforeEach(() => {
  vi.clearAllMocks();
  mockSecretService.resolveGitHubToken.mockResolvedValue("gh-token");
});

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
}

describe("resolvePullRequestHeadCommit", () => {
  it("returns the PR's head sha on a successful GitHub lookup", async () => {
    const { resolvePullRequestHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = fetchReturning({ head: { sha: "abc123" } });
    const result = await resolvePullRequestHeadCommit(
      { kind: "merge_pr", repo: "acme/paperclip", prNumber: 42 },
      { fetchImpl, token: "gh-token" },
    );
    expect(result).toBe("abc123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/paperclip/pulls/42",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer gh-token" }) }),
    );
  });

  it("returns null when the payload has no repo/prNumber (never blocks)", async () => {
    const { resolvePullRequestHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = vi.fn();
    const result = await resolvePullRequestHeadCommit({ kind: "merge_pr" }, { fetchImpl, token: null });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a non-ok GitHub response", async () => {
    const { resolvePullRequestHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = fetchReturning({}, false);
    const result = await resolvePullRequestHeadCommit(
      { kind: "merge_pr", repo: "acme/paperclip", prNumber: 42 },
      { fetchImpl, token: null },
    );
    expect(result).toBeNull();
  });

  it("returns null when GitHub is unreachable, instead of throwing", async () => {
    const { resolvePullRequestHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await resolvePullRequestHeadCommit(
      { kind: "merge_pr", repo: "acme/paperclip", prNumber: 42 },
      { fetchImpl, token: null },
    );
    expect(result).toBeNull();
  });
});

describe("withResolvedMergePrHeadCommit (card creation)", () => {
  it("fills payload.commit from GitHub when the card was filed without one", async () => {
    const { withResolvedMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = fetchReturning({ head: { sha: "head-sha" } });
    const payload = await withResolvedMergePrHeadCommit(
      {} as any,
      "company-a",
      { kind: "merge_pr", repo: "acme/paperclip", prNumber: 589 },
      { fetchImpl },
    );
    expect(payload.commit).toBe("head-sha");
  });

  it("leaves an already-present commit alone (never overwrites a filer-supplied value)", async () => {
    const { withResolvedMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = vi.fn();
    const payload = await withResolvedMergePrHeadCommit(
      {} as any,
      "company-a",
      { kind: "merge_pr", repo: "acme/paperclip", prNumber: 589, commit: "already-set" },
      { fetchImpl },
    );
    expect(payload.commit).toBe("already-set");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a non-merge_pr payload untouched", async () => {
    const { withResolvedMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const fetchImpl = vi.fn();
    const original = { kind: "deploy", commit: undefined };
    const payload = await withResolvedMergePrHeadCommit({} as any, "company-a", original, { fetchImpl });
    expect(payload).toBe(original);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("refreshMergePrHeadCommit (on-demand refresh)", () => {
  function fakeDb(row: { id: string; companyId: string; payload: Record<string, unknown> }) {
    const updateCalls: Array<{ set: Record<string, unknown> }> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((set: Record<string, unknown>) => {
          updateCalls.push({ set });
          return { where: vi.fn(async () => undefined) };
        }),
      })),
    };
    return { db, updateCalls };
  }

  it("persists a resolved commit when the card had none", async () => {
    const { refreshMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const { db, updateCalls } = fakeDb({ id: "a1", companyId: "company-a", payload: {} });
    const fetchImpl = fetchReturning({ head: { sha: "new-head" } });

    const result = await refreshMergePrHeadCommit(
      db as any,
      { id: "a1", companyId: "company-a", payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 1 } },
      { fetchImpl },
    );

    expect(result.headCommit).toBe("new-head");
    expect(result.payload.commit).toBe("new-head");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set).toEqual(expect.objectContaining({ payload: expect.objectContaining({ commit: "new-head" }) }));
  });

  it("persists a refreshed commit when the PR head has moved past the stored one", async () => {
    const { refreshMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const { db, updateCalls } = fakeDb({ id: "a1", companyId: "company-a", payload: {} });
    const fetchImpl = fetchReturning({ head: { sha: "newer-head" } });

    const result = await refreshMergePrHeadCommit(
      db as any,
      {
        id: "a1",
        companyId: "company-a",
        payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 1, commit: "older-head" },
      },
      { fetchImpl },
    );

    expect(result.headCommit).toBe("newer-head");
    expect(updateCalls).toHaveLength(1);
  });

  it("does not write anything when GitHub's answer matches what's already stored", async () => {
    const { refreshMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const { db, updateCalls } = fakeDb({ id: "a1", companyId: "company-a", payload: {} });
    const fetchImpl = fetchReturning({ head: { sha: "same-head" } });

    const result = await refreshMergePrHeadCommit(
      db as any,
      {
        id: "a1",
        companyId: "company-a",
        payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 1, commit: "same-head" },
      },
      { fetchImpl },
    );

    expect(result.headCommit).toBe("same-head");
    expect(updateCalls).toHaveLength(0);
  });

  it("fails open: keeps the existing commit when GitHub can't be reached", async () => {
    const { refreshMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const { db, updateCalls } = fakeDb({ id: "a1", companyId: "company-a", payload: {} });
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });

    const result = await refreshMergePrHeadCommit(
      db as any,
      {
        id: "a1",
        companyId: "company-a",
        payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 1, commit: "existing-head" },
      },
      { fetchImpl },
    );

    expect(result.headCommit).toBe("existing-head");
    expect(updateCalls).toHaveLength(0);
  });

  it("is a no-op for a non-merge_pr approval", async () => {
    const { refreshMergePrHeadCommit } = await import("./merge-card-head-commit.js");
    const { db, updateCalls } = fakeDb({ id: "a1", companyId: "company-a", payload: {} });
    const fetchImpl = vi.fn();

    const result = await refreshMergePrHeadCommit(
      db as any,
      { id: "a1", companyId: "company-a", payload: { kind: "deploy" } },
      { fetchImpl },
    );

    expect(result.headCommit).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });
});

describe("backfillOpenMergeCardHeadCommits (startup backfill)", () => {
  it("resolves and persists a commit for every open merge_pr card missing one", async () => {
    const { backfillOpenMergeCardHeadCommits } = await import("./merge-card-head-commit.js");
    const openCards = [
      { id: "fd3ff13e", companyId: "company-a", payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 589 } },
      { id: "card-2", companyId: "company-a", payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 600 } },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => openCards),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const fetchImpl = fetchReturning({ head: { sha: "resolved-head" } });

    const result = await backfillOpenMergeCardHeadCommits(db as any, { fetchImpl });

    expect(result).toEqual({ checked: 2, resolved: 2 });
  });

  it("counts a card GitHub can't resolve as checked but not resolved", async () => {
    const { backfillOpenMergeCardHeadCommits } = await import("./merge-card-head-commit.js");
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { id: "fd3ff13e", companyId: "company-a", payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 589 } },
          ]),
        })),
      })),
      update: vi.fn(),
    };
    const fetchImpl = fetchReturning({}, false);

    const result = await backfillOpenMergeCardHeadCommits(db as any, { fetchImpl });

    expect(result).toEqual({ checked: 1, resolved: 0 });
    expect(db.update).not.toHaveBeenCalled();
  });
});
