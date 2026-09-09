import { describe, expect, it } from "vitest";
import {
  PREVIEW_PROXY_PATH_PREFIX,
  buildPreviewProxyPath,
  describePreviewStatus,
  isPreviewableApprovalPayload,
  normalizePreviewForwardPath,
  parsePreviewProxyPath,
  readApprovalPreviewRef,
} from "./preview-environments.js";

describe("isPreviewableApprovalPayload", () => {
  it("accepts merge and deploy board approvals", () => {
    expect(isPreviewableApprovalPayload("request_board_approval", { kind: "merge_pr" })).toBe(true);
    expect(isPreviewableApprovalPayload("request_board_approval", { kind: "deploy" })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isPreviewableApprovalPayload("request_board_approval", { kind: "tool_grant" })).toBe(false);
    expect(isPreviewableApprovalPayload("hire_agent", { kind: "deploy" })).toBe(false);
    expect(isPreviewableApprovalPayload("request_board_approval", null)).toBe(false);
  });
});

describe("readApprovalPreviewRef", () => {
  it("pins a deploy to the exact commit the card would ship", () => {
    expect(readApprovalPreviewRef({ kind: "deploy", commit: "abcdef1234567890", sourceBranch: "custom" }))
      .toEqual({ kind: "commit", value: "abcdef1234567890", label: "the exact version abcdef1" });
  });

  it("falls back to the deploy source branch when no commit is pinned", () => {
    expect(readApprovalPreviewRef({ kind: "deploy", sourceBranch: "custom" }))
      .toEqual({ kind: "branch", value: "custom", label: "the latest code on custom" });
  });

  it("previews the moving head branch for a merge", () => {
    expect(readApprovalPreviewRef({ kind: "merge_pr", branch: "build/fix-login", commit: "deadbeef" }))
      .toEqual({ kind: "branch", value: "build/fix-login", label: "the latest code on build/fix-login" });
  });

  it("returns null when there is nothing to check out", () => {
    expect(readApprovalPreviewRef({ kind: "merge_pr" })).toBeNull();
    expect(readApprovalPreviewRef({ kind: "deploy" })).toBeNull();
    expect(readApprovalPreviewRef({ kind: "tool_grant", branch: "x" })).toBeNull();
  });
});

describe("parsePreviewProxyPath", () => {
  const workspaceId = "0b6e1e2c-1111-4222-8333-444444444444";

  it("splits the workspace id from the path inside the previewed app", () => {
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}/api/health`))
      .toEqual({ workspaceId, forwardPath: "/api/health" });
  });

  it("treats the bare workspace root as /", () => {
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}/`))
      .toEqual({ workspaceId, forwardPath: "/" });
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}`))
      .toEqual({ workspaceId, forwardPath: "/" });
  });

  it("refuses paths that are not previews", () => {
    expect(parsePreviewProxyPath("/api/health")).toBeNull();
    expect(parsePreviewProxyPath("")).toBeNull();
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/not a workspace/x`)).toBeNull();
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/../../etc/passwd`)).toBeNull();
  });

  it("never lets a request climb out of the preview", () => {
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}/../../secrets`))
      .toEqual({ workspaceId, forwardPath: "/secrets" });
    expect(parsePreviewProxyPath(`${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}/..%2f..%2fsecrets`)?.forwardPath)
      .toBe("/..%2f..%2fsecrets");
  });
});

describe("normalizePreviewForwardPath", () => {
  it("always produces a single rooted path", () => {
    expect(normalizePreviewForwardPath("")).toBe("/");
    expect(normalizePreviewForwardPath("a/b")).toBe("/a/b");
    expect(normalizePreviewForwardPath("///a////b//")).toBe("/a/b");
  });

  it("drops traversal, backslashes and anything that would name another host", () => {
    expect(normalizePreviewForwardPath("../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePreviewForwardPath("./a/./b")).toBe("/a/b");
    expect(normalizePreviewForwardPath("..\\..\\windows")).toBe("/windows");
    // A protocol-relative or absolute URL can never survive as one.
    expect(normalizePreviewForwardPath("/evil.example.com/x")).toBe("/evil.example.com/x");
    expect(normalizePreviewForwardPath("http://evil.example.com/x")).toBe("/http:/evil.example.com/x");
  });

  it("keeps the query and fragment out of the path", () => {
    expect(normalizePreviewForwardPath("a/b?x=1")).toBe("/a/b");
    expect(normalizePreviewForwardPath("a/b#frag")).toBe("/a/b");
  });
});

describe("buildPreviewProxyPath", () => {
  it("points at the workspace root", () => {
    expect(buildPreviewProxyPath("abc")).toBe("/_preview/abc/");
  });
});

describe("describePreviewStatus", () => {
  it("speaks plainly for every state", () => {
    expect(describePreviewStatus({ status: "starting", refLabel: "the latest code on custom" }))
      .toContain("Starting a copy of the latest code on custom");
    expect(describePreviewStatus({ status: "ready", idleTimeoutMinutes: 30 })).toContain("30 minutes");
    expect(describePreviewStatus({ status: "failed", failureReason: "the start command exited straight away" }))
      .toContain("the start command exited straight away");
    expect(describePreviewStatus({ status: "stopped" })).toBe("Nothing is running for this branch yet.");
  });
});
