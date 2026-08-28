import { describe, expect, it } from "vitest";
import { assertNoEmbeddedGitCredential, hasEmbeddedGitCredential } from "./git-remote-url.js";

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
