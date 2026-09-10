/**
 * Pointless deploy cards: the parts of the "would this deploy change anything?" check that do
 * not need GitHub -- which files count as written notes, the summary stamped on
 * the card, and the wording of each refusal (every one of them has to name the
 * version running now and say what to do instead).
 */
import { deployChangeSummarySchema } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import {
  DEPLOY_CHANGED_FILES_STAMP_LIMIT,
  DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH,
  describeDeployCardPartialCommitId,
  describeDeployCardWithoutCommitId,
  describeDeployCommitAlreadyLive,
  describeDeployCommitNotBuiltOnLive,
  describeDocumentationOnlyDeploy,
  describeMergeCommitAlreadyInBase,
  describeMissingDeployCommit,
  findCommitIdLikeText,
  isDocumentationPath,
  isFullCommitId,
  resolveLiveDeployCommit,
  shortCommit,
  summarizeChangedPaths,
} from "../services/deploy-change-guard.js";

describe("isDocumentationPath", () => {
  it("counts markdown, PROJECT_STATUS.md and docs folders as written notes", () => {
    expect(isDocumentationPath("README.md")).toBe(true);
    expect(isDocumentationPath("PROJECT_STATUS.md")).toBe(true);
    expect(isDocumentationPath("docs/runbook.txt")).toBe(true);
    expect(isDocumentationPath("docs/images/box.png")).toBe(true);
    expect(isDocumentationPath("server/docs/design.txt")).toBe(true);
  });

  it("does not count code, templates or migrations", () => {
    expect(isDocumentationPath("server/src/app.ts")).toBe(false);
    expect(isDocumentationPath("ui/src/components/ApprovalCard.tsx")).toBe(false);
    expect(isDocumentationPath("packages/db/src/migrations/0165_thing.sql")).toBe(false);
    expect(isDocumentationPath("scripts/deploy-runner.sh")).toBe(false);
    // "documentation" is a folder rule, not a substring one.
    expect(isDocumentationPath("server/src/docsearch.ts")).toBe(false);
  });
});

describe("summarizeChangedPaths", () => {
  it("is documentation-only when every changed file is written notes", () => {
    expect(summarizeChangedPaths("aaaaaaaaaaaa", ["README.md", "docs/x.md"])).toEqual({
      liveCommit: "aaaaaaaaaaaa",
      changedFileCount: 2,
      changedFiles: ["README.md", "docs/x.md"],
      documentationOnly: true,
    });
  });

  it("is not documentation-only as soon as one real file changed", () => {
    expect(summarizeChangedPaths("aaaaaaaaaaaa", ["README.md", "server/src/app.ts"]).documentationOnly).toBe(false);
  });

  it("de-duplicates paths and caps how many get stamped onto the card", () => {
    const many = Array.from({ length: 40 }, (_, i) => `server/src/file${i}.ts`);
    const summary = summarizeChangedPaths("aaaaaaaaaaaa", [...many, ...many]);
    expect(summary.changedFileCount).toBe(40);
    expect(summary.changedFiles).toHaveLength(DEPLOY_CHANGED_FILES_STAMP_LIMIT);
  });

  it("shortens a very long path so one file cannot bloat the stored card", () => {
    const long = `server/src/${"very-long-folder-name/".repeat(20)}approvals.ts`;
    const summary = summarizeChangedPaths("aaaaaaaaaaaa", [long]);
    expect(long.length).toBeGreaterThan(DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH);
    expect(summary.changedFiles[0]!.length).toBe(DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH);
    // The end is kept, because that is where the file name is.
    expect(summary.changedFiles[0]).toMatch(/^\.\.\./);
    expect(summary.changedFiles[0]!.endsWith("approvals.ts")).toBe(true);
  });

  it("always produces a summary the deploy payload will accept, however big the diff", () => {
    const huge = Array.from(
      { length: 400 },
      (_, i) => `server/src/${"deeply-nested-folder/".repeat(15)}file${i}.ts`,
    );
    const summary = summarizeChangedPaths("aaaaaaaaaaaa", huge);
    expect(summary.changedFileCount).toBe(400);
    expect(() => deployChangeSummarySchema.parse(summary)).not.toThrow();
    expect(JSON.stringify(summary).length).toBeLessThan(2500);
  });

  it("never concludes documentation-only from a truncated file list", () => {
    expect(summarizeChangedPaths("aaaaaaaaaaaa", ["README.md"], { truncated: true }).documentationOnly).toBe(false);
  });
});

describe("the refusal wording", () => {
  it("(a) a commit that does not exist names the repo and the live version", () => {
    const message = describeMissingDeployCommit({
      commit: "bbbbbbbbbbbbccccc",
      repo: "acme/widgets",
      liveCommit: "aaaaaaaaaaaa",
    });
    expect(message).toContain("bbbbbbbbbbbb");
    expect(message).toContain("acme/widgets");
    expect(message).toContain("aaaaaaaaaaaa");
    expect(message).toMatch(/file the card again/i);
  });

  it("(a) still says what to do when nothing is known to be live", () => {
    const message = describeMissingDeployCommit({ commit: "bbbbbbbbbbbb", repo: "acme/widgets", liveCommit: null });
    expect(message).toMatch(/could not work out which version is running/i);
  });

  it("(b) an already-live commit says nothing would change and names the live version", () => {
    const behind = describeDeployCommitAlreadyLive({
      commit: "bbbbbbbbbbbb",
      liveCommit: "aaaaaaaaaaaa",
      identical: false,
    });
    expect(behind).toMatch(/already running/i);
    expect(behind).toContain("aaaaaaaaaaaa");
    const identical = describeDeployCommitAlreadyLive({
      commit: "bbbbbbbbbbbb",
      liveCommit: "aaaaaaaaaaaa",
      identical: true,
    });
    expect(identical).toMatch(/exactly what is running now/i);
  });

  it("(c) a rewritten history says to bring the live version back into the branch first", () => {
    const message = describeDeployCommitNotBuiltOnLive({
      commit: "bbbbbbbbbbbb",
      liveCommit: "aaaaaaaaaaaa",
      deployBranch: "custom",
    });
    expect(message).toMatch(/not built on top of what is running now/i);
    expect(message).toContain("aaaaaaaaaaaa");
    expect(message).toContain('"custom"');
    expect(message).toMatch(/merge it in/i);
  });

  it("(d) a notes-only deploy says nothing would change and when to file instead", () => {
    const message = describeDocumentationOnlyDeploy({
      commit: "bbbbbbbbbbbb",
      liveCommit: "aaaaaaaaaaaa",
      changedFiles: ["PROJECT_STATUS.md"],
      changedFileCount: 1,
    });
    expect(message).toMatch(/nothing would change/i);
    expect(message).toContain("PROJECT_STATUS.md");
    expect(message).toContain("aaaaaaaaaaaa");
    expect(message).toMatch(/code, the page templates or the database setup/i);
  });

  it("(d) says so plainly when not a single file differs", () => {
    const message = describeDocumentationOnlyDeploy({
      commit: "bbbbbbbbbbbb",
      liveCommit: "aaaaaaaaaaaa",
      changedFiles: [],
      changedFileCount: 0,
    });
    expect(message).toMatch(/not a single file differs/i);
  });

  it("shows commits short", () => {
    expect(shortCommit("aaaaaaaaaaaabbbbbbbbbbbb")).toBe("aaaaaaaaaaaa");
    expect(shortCommit(" abc1234 ")).toBe("abc1234");
  });
});

describe("resolveLiveDeployCommit", () => {
  it("returns the version the deploy runner last reported live", async () => {
    vi.resetModules();
    vi.doMock("../services/deploy-history.js", () => ({
      readProjectDeployHistory: vi.fn(async () => ({
        current: { commit: "aaaaaaaaaaaa", approvalId: "approval-1", deployedAt: "2026-09-08T10:00:00Z" },
        previous: null,
      })),
    }));
    const { resolveLiveDeployCommit: resolve } = await import("../services/deploy-change-guard.js");
    await expect(resolve({} as never, "company-1", "project-1")).resolves.toBe("aaaaaaaaaaaa");
    vi.doUnmock("../services/deploy-history.js");
    vi.resetModules();
  });

  it("returns null rather than throwing when the deploy history cannot be read", async () => {
    vi.resetModules();
    vi.doMock("../services/deploy-history.js", () => ({
      readProjectDeployHistory: vi.fn(async () => {
        throw new Error("status log unreadable");
      }),
    }));
    const { resolveLiveDeployCommit: resolve } = await import("../services/deploy-change-guard.js");
    await expect(resolve({} as never, "company-1", "project-1")).resolves.toBeNull();
    vi.doUnmock("../services/deploy-history.js");
    vi.resetModules();
  });

  it("returns null when nothing has ever deployed", async () => {
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) };
    await expect(
      resolveLiveDeployCommit(db as never, "company-1", "project-1", { readStatusLog: () => [] }),
    ).resolves.toBeNull();
  });
});

describe("DUR-3964: a card must name the exact commit, and say so plainly when it does not", () => {
  it("only accepts a written-out 40-character commit id", () => {
    expect(isFullCommitId("8623c28bd1234567890abcdef1234567890abcde")).toBe(true);
    expect(isFullCommitId("  8623C28BD1234567890ABCDEF1234567890ABCDE  ")).toBe(true);
    expect(isFullCommitId("8623c28")).toBe(false);
    expect(isFullCommitId("8623c28bd1234567890abcdef1234567890abcd")).toBe(false);
    expect(isFullCommitId("custom")).toBe(false);
    expect(isFullCommitId("")).toBe(false);
  });

  it("spots a commit id written into a note, and is not fooled by ordinary text", () => {
    expect(findCommitIdLikeText("Deploying 8623c28f after the merge.")).toBe("8623c28f");
    expect(findCommitIdLikeText("commit 8623c28bd1234567890abcdef1234567890abcde")).toBe(
      "8623c28bd1234567890abcdef1234567890abcde",
    );
    // A plain number, a plain word, and anything too short are not commit ids.
    expect(findCommitIdLikeText("Ships invoice page 1234567 of the redesign.")).toBeNull();
    expect(findCommitIdLikeText("Deploy the accessible dashboard.")).toBeNull();
    expect(findCommitIdLikeText("Fixes bug abc12.")).toBeNull();
  });

  it("tells an agent where to get the commit id, and names the one it wrote in the note", () => {
    const withNote = describeDeployCardWithoutCommitId({ commitIdInText: "8623c28f" });
    expect(withNote).toMatch(/does not say which commit to deploy/i);
    expect(withNote).toMatch(/commit field is empty/i);
    expect(withNote).toContain("8623c28f");
    expect(withNote).toContain("git rev-parse HEAD");

    const without = describeDeployCardWithoutCommitId({ commitIdInText: null });
    expect(without).toMatch(/does not say which commit to deploy/i);
    expect(without).not.toMatch(/commit field is empty/i);
    expect(without).toContain("git rev-parse HEAD");
  });

  it("says why a shortened commit id is not enough", () => {
    const message = describeDeployCardPartialCommitId({ commit: "8623c28" });
    expect(message).toContain("8623c28");
    expect(message).toMatch(/not a full commit id/i);
    expect(message).toContain("40 characters");
    expect(message).toContain("git rev-parse HEAD");
  });

  it("points an already-merged change at the deploy card the agent actually wanted", () => {
    const message = describeMergeCommitAlreadyInBase({
      commit: "8623c28bd1234567890abcdef1234567890abcde",
      base: "custom",
    });
    expect(message).toMatch(/already merged into "custom"/i);
    expect(message).toContain("8623c28bd123");
    expect(message).toMatch(/file a deploy card with the commit id/i);
    expect(message).toContain("8623c28bd1234567890abcdef1234567890abcde");
  });
});
