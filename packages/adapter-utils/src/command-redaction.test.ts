import { describe, expect, it } from "vitest";
import { redactCommandText } from "./command-redaction.js";

// DUR-370: `gh auth status` (no --show-token) partially masks classic tokens
// (ghp_/gho_/...) with literal asterisks, but fine-grained PATs use the
// `github_pat_<id>_<secret>` shape and fell through this redactor entirely.
describe("redactCommandText", () => {
  it("redacts a fine-grained github_pat_ token", () => {
    const input = "Token: github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = redactCommandText(input);
    expect(result).not.toContain("github_pat_11AAAAAAA0aaaaaaaaaaaa");
    expect(result).toContain("***REDACTED***");
  });

  it("still redacts classic ghp_ tokens", () => {
    const input = "Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const result = redactCommandText(input);
    expect(result).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts a PEM private key block", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
    const result = redactCommandText(input);
    expect(result).not.toContain("MIIBOgIBAAJBAK");
    expect(result).toContain("***REDACTED***");
  });

  it("leaves an unmatched BEGIN marker (no END) alone rather than hanging", () => {
    const input = "discussion of -----BEGIN RSA PRIVATE KEY----- as a test fixture, no closing marker";
    const result = redactCommandText(input);
    expect(result).toBe(input);
  });
});
