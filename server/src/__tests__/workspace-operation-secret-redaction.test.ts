import { describe, expect, it } from "vitest";
import { sanitizeWorkspaceOperationChunk, sanitizeWorkspaceOperationMetadata } from "../services/workspace-operations.js";

// DUR-372: workspace_operations.stdoutExcerpt/stderrExcerpt/metadata were
// populated from raw process output with only redactCurrentUserText applied
// (username/homedir masking). A command that fails with an embedded
// credential -- e.g. `git clone https://x-access-token:<PAT>@github.com/...`
// -- wrote the raw credential straight into this table, the same failure
// mode DUR-317 fixed for heartbeat_runs but left open here.
describe("sanitizeWorkspaceOperationChunk", () => {
  it("redacts leaked-secret patterns from stdout/stderr chunks before they are persisted", () => {
    const chunk = "remote sync failed for https://x-access-token:ghp_1234567890abcdefghijklmnopqrstuvwxyz@github.com/org/repo.git: exit 128";

    const result = sanitizeWorkspaceOperationChunk(chunk);

    expect(result).toBe(
      "remote sync failed for https://x-access-token:[REDACTED:github_token]@github.com/org/repo.git: exit 128",
    );
  });

  it("still applies current-user redaction alongside the leaked-secret-pattern gate", () => {
    const result = sanitizeWorkspaceOperationChunk("cloning as alice with token ghp_1234567890abcdefghijklmnopqrstuvwxyz", {
      userNames: ["alice"],
    });

    expect(result).toContain("[REDACTED:github_token]");
    expect(result).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("alice");
  });

  it("is a byte-for-byte no-op when nothing matches", () => {
    const chunk = "build succeeded, no credentials here";
    expect(sanitizeWorkspaceOperationChunk(chunk)).toBe(chunk);
  });
});

describe("sanitizeWorkspaceOperationMetadata", () => {
  it("redacts leaked-secret patterns nested inside metadata values", () => {
    const result = sanitizeWorkspaceOperationMetadata({
      summary: "clone failed",
      detail: { remote: "https://x-access-token:github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/org/repo.git" },
    });

    expect(result?.summary).toBe("clone failed");
    expect((result?.detail as Record<string, unknown>).remote).toBe(
      "https://x-access-token:[REDACTED:github_pat]@github.com/org/repo.git",
    );
  });

  it("returns null for null/undefined metadata instead of an empty object", () => {
    expect(sanitizeWorkspaceOperationMetadata(null)).toBeNull();
    expect(sanitizeWorkspaceOperationMetadata(undefined)).toBeNull();
  });
});
