import { describe, expect, it } from "vitest";
import {
  assertNoEmbeddedGitCredential,
  hasEmbeddedGitCredential,
  redactEmbeddedGitCredentials,
} from "./git-remote-url.js";

describe("hasEmbeddedGitCredential", () => {
  it("rejects a PAT used as the URL username", () => {
    expect(hasEmbeddedGitCredential("https://ghp_abc123def456@github.com/acme/repo.git")).toBe(true);
  });

  it("rejects a username:password pair", () => {
    expect(hasEmbeddedGitCredential("https://user:hunter2@github.com/acme/repo.git")).toBe(true);
  });

  it("rejects a credential over plain http", () => {
    expect(hasEmbeddedGitCredential("http://token@example.com/acme/repo.git")).toBe(true);
  });

  it("rejects a password embedded in an ssh URL", () => {
    expect(hasEmbeddedGitCredential("ssh://git:hunter2@github.com/acme/repo.git")).toBe(true);
  });

  it("passes a plain https GitHub URL", () => {
    expect(hasEmbeddedGitCredential("https://github.com/acme/repo.git")).toBe(false);
  });

  it("passes the scp-like SSH shorthand", () => {
    expect(hasEmbeddedGitCredential("git@github.com:acme/repo.git")).toBe(false);
  });

  it("passes an ssh:// URL with only the conventional git username", () => {
    expect(hasEmbeddedGitCredential("ssh://git@github.com/acme/repo.git")).toBe(false);
  });

  it("passes an empty or blank string", () => {
    expect(hasEmbeddedGitCredential("")).toBe(false);
    expect(hasEmbeddedGitCredential("   ")).toBe(false);
  });

  it("passes a value that isn't a parseable URL", () => {
    expect(hasEmbeddedGitCredential("not a url")).toBe(false);
  });

  // Regression coverage for the adversarial review of PR #189 (DUR-326/DUR-325):
  // hasEmbeddedGitCredential() had two independent bypasses.

  it("rejects a backslash-prefixed decoy hiding real userinfo (git/libcurl parses backslash literally, WHATWG URL does not)", () => {
    expect(hasEmbeddedGitCredential("https://decoy.example\\@svcuser:s3cr3t@127.0.0.1:8899/x.git")).toBe(true);
  });

  it("rejects a backslash anywhere in the raw URL, not just before the decoy host", () => {
    expect(hasEmbeddedGitCredential("https://github.com/acme/repo\\.git")).toBe(true);
  });

  it("rejects a non-'git' bare username on an ssh:// URL (PAT smuggled as the ssh account)", () => {
    expect(hasEmbeddedGitCredential("ssh://ghp_realsecrettoken@github.com/acme/repo.git")).toBe(true);
  });

  it("rejects a non-'git' account in scp-like shorthand (PAT smuggled as the scp account)", () => {
    expect(hasEmbeddedGitCredential("ghp_realsecrettoken@github.com:acme/repo.git")).toBe(true);
  });

  it("rejects a user:pass@host:path form that resembles but doesn't match scp-like syntax", () => {
    expect(hasEmbeddedGitCredential("weird:creds@github.com:owner/repo.git")).toBe(true);
  });
});

describe("redactEmbeddedGitCredentials", () => {
  it("redacts userinfo out of a scheme URL embedded in free text", () => {
    expect(
      redactEmbeddedGitCredentials(
        "fatal: unable to access 'https://svcuser:s3cr3t@127.0.0.1:8899/x.git/': URL rejected",
      ),
    ).toBe("fatal: unable to access 'https://<redacted>@127.0.0.1:8899/x.git/': URL rejected");
  });

  it("redacts a non-'git' scp-like account embedded in free text", () => {
    expect(redactEmbeddedGitCredentials("cloning ghp_realsecrettoken@github.com:acme/repo.git failed")).toBe(
      "cloning <redacted>@github.com:acme/repo.git failed",
    );
  });

  it("leaves the canonical scp-like 'git' account alone", () => {
    expect(redactEmbeddedGitCredentials("cloning git@github.com:acme/repo.git failed")).toBe(
      "cloning git@github.com:acme/repo.git failed",
    );
  });

  it("leaves text with no embedded credential unchanged", () => {
    expect(redactEmbeddedGitCredentials("fatal: repository 'https://github.com/acme/repo.git/' not found")).toBe(
      "fatal: repository 'https://github.com/acme/repo.git/' not found",
    );
  });
});

describe("assertNoEmbeddedGitCredential", () => {
  it("throws naming the credential-helper and deploy-key alternatives", () => {
    expect(() => assertNoEmbeddedGitCredential("https://ghp_abc123@github.com/acme/repo.git")).toThrow(
      /credential helper|SSH deploy key/,
    );
  });

  it("does not throw for a clean URL", () => {
    expect(() => assertNoEmbeddedGitCredential("https://github.com/acme/repo.git")).not.toThrow();
  });
});
