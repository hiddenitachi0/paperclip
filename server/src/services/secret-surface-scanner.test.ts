import { describe, expect, it } from "vitest";
import {
  computeFindingFingerprint,
  maskSecretMatch,
  resolveCompanyIdFromPath,
  scanTextForSecrets,
} from "./secret-surface-scanner.js";

describe("scanTextForSecrets", () => {
  it("matches every DUR-316 starter pattern", () => {
    const samples: Record<string, string> = {
      github_pat: "github_pat_11ABCDEFGH0123456789012345678901234567890123456789012345",
      github_token_classic: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      generic_sk_key: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      // Split from the vendor prefix so this fixture doesn't read as one
      // contiguous secret-shaped token to GitHub's own push-protection scan
      // -- it is a synthetic value, but the whole point of this pattern set
      // is to look exactly like the real thing.
      shopify_shared_secret: "shpss_" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      shopify_access_token: "shpat_" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      slack_bot_token: "xoxb-" + "1234567890-abcdefghijklmnop",
      aws_access_key_id: "AKIAABCDEFGHIJKLMNOP",
      pem_private_key: "-----BEGIN RSA PRIVATE KEY-----",
    };

    for (const [pattern, value] of Object.entries(samples)) {
      const matches = scanTextForSecrets(`token=${value}`);
      expect(matches.some((m) => m.pattern === pattern && m.value === value), pattern).toBe(true);
    }
  });

  it("matches a token embedded in a git remote URL, same shape as NOR-316", () => {
    const gitConfigText = [
      "[remote \"origin\"]",
      "\turl = https://x-access-token:ghp_realTokenLooksLikeThis123456789012@github.com/acme/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\n");
    const matches = scanTextForSecrets(gitConfigText);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe("github_token_classic");
  });

  it("does not match plain text with no secret-shaped substrings", () => {
    const matches = scanTextForSecrets("this is a perfectly ordinary log line with no tokens in it");
    expect(matches).toHaveLength(0);
  });

  it("excludes redacted / placeholder / example values", () => {
    const lines = [
      "token=ghp_REDACTEDREDACTEDREDACTEDRE",
      "token=ghp_your_example_token_goes_here_12",
      "token=sk-changeme00000000000000000",
    ];
    for (const line of lines) {
      expect(scanTextForSecrets(line), line).toHaveLength(0);
    }
  });

  it("excludes low-entropy repeated-character placeholders", () => {
    const placeholderAkiaKey = `AKIA${"A".repeat(16)}`;
    // Sanity-check the fixture is actually shaped like a real AWS key (20
    // chars) before asserting the entropy filter is what drops it, not the
    // pattern simply failing to match a malformed string.
    expect(placeholderAkiaKey).toHaveLength(20);
    const matches = scanTextForSecrets(`token=${placeholderAkiaKey}`);
    expect(matches).toHaveLength(0);
  });
});

describe("maskSecretMatch", () => {
  it("never returns the original value and keeps only a short head/tail", () => {
    const value = "ghp_realTokenLooksLikeThis123456789012";
    const masked = maskSecretMatch(value);
    expect(masked).not.toBe(value);
    expect(masked).not.toContain(value.slice(10, -4));
    expect(masked.startsWith(value.slice(0, 6))).toBe(true);
    expect(masked.endsWith(value.slice(-4))).toBe(true);
  });

  it("fully masks short values instead of leaking them via head/tail", () => {
    const masked = maskSecretMatch("AKIA1234");
    expect(masked).toBe("*".repeat(8));
  });
});

describe("computeFindingFingerprint", () => {
  it("is deterministic for the same surface/location/pattern", () => {
    const a = computeFindingFingerprint({ surface: "dotenv", location: "a/.env", pattern: "sk-" });
    const b = computeFindingFingerprint({ surface: "dotenv", location: "a/.env", pattern: "sk-" });
    expect(a).toBe(b);
  });

  it("differs when location or pattern differs, and never embeds the secret value", () => {
    const base = computeFindingFingerprint({ surface: "dotenv", location: "a/.env", pattern: "sk-" });
    const otherLocation = computeFindingFingerprint({ surface: "dotenv", location: "b/.env", pattern: "sk-" });
    const otherPattern = computeFindingFingerprint({ surface: "dotenv", location: "a/.env", pattern: "ghp_" });
    expect(otherLocation).not.toBe(base);
    expect(otherPattern).not.toBe(base);
  });
});

describe("resolveCompanyIdFromPath", () => {
  it("extracts a company id from a /companies/<uuid>/ path segment", () => {
    const id = resolveCompanyIdFromPath("/paperclip/instances/default/companies/7600f03c-c836-4326-8d48-c801813c3a87/agents/x/.env");
    expect(id).toBe("7600f03c-c836-4326-8d48-c801813c3a87");
  });

  it("extracts a company id from a /projects/<uuid>/ path segment", () => {
    const id = resolveCompanyIdFromPath("/paperclip/instances/default/projects/7600f03c-c836-4326-8d48-c801813c3a87/9c681226-1065-4e4b-8c9a-f7fd01ce3053/paperclip/.git/config");
    expect(id).toBe("7600f03c-c836-4326-8d48-c801813c3a87");
  });

  it("returns null when no company id segment is present", () => {
    expect(resolveCompanyIdFromPath("/tmp/scratch/.env")).toBeNull();
  });
});
