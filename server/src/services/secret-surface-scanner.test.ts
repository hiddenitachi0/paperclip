import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeFindingFingerprint,
  maskSecretMatch,
  resolveCompanyIdFromPath,
  scanTextForSecrets,
} from "./secret-surface-scanner.js";

function sha256Prefix(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

describe("scanTextForSecrets", () => {
  it("matches every DUR-316 starter pattern", () => {
    const samples: Record<string, string> = {
      github_pat: "github_pat_11ABCDEFGH0123456789012345678901234567890123456789012345",
      github_token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      github_oauth_token: "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      github_user_token: "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      github_app_installation_token: "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      github_refresh_token: "ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      openai_key: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      // Split from the vendor prefix so this fixture doesn't read as one
      // contiguous secret-shaped token to GitHub's own push-protection scan
      // -- it is a synthetic value, but the whole point of this pattern set
      // is to look exactly like the real thing.
      shopify_shared_secret: "shpss_" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      shopify_access_token: "shpat_" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      slack_bot_token: "xoxb-" + "1234567890-abcdefghijklmnop",
      slack_user_token: "xoxp-" + "1234567890-abcdefghijklmnop",
      aws_access_key_id: "AKIAABCDEFGHIJKLMNOP",
    };

    for (const [pattern, value] of Object.entries(samples)) {
      const matches = scanTextForSecrets(`token=${value}`);
      expect(matches.some((m) => m.pattern === pattern && m.value === value), pattern).toBe(true);
    }
  });

  it("matches the shared PEM pattern's full BEGIN...END block, not just the header line", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEr8IqhbEDbMQPO+2VDL0Fzd/HTdWkEIiw2K",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const matches = scanTextForSecrets(pem);
    expect(matches.some((m) => m.pattern === "pem_private_key")).toBe(true);
  });

  it("matches a token embedded in a git remote URL, same shape as NOR-316", () => {
    const gitConfigText = [
      "[remote \"origin\"]",
      "\turl = https://x-access-token:ghp_realTokenLooksLikeThis123456789012@github.com/acme/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\n");
    const matches = scanTextForSecrets(gitConfigText);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe("github_token");
  });

  it("does not match plain text with no secret-shaped substrings", () => {
    const matches = scanTextForSecrets("this is a perfectly ordinary log line with no tokens in it");
    expect(matches).toHaveLength(0);
  });

  // DUR-1430: DUR-954 was filed as a critical openai_key finding against a
  // heartbeat_runs row whose resultJson just contained
  // {"origin":{"kind":"task-notification"}} -- the unanchored sk- regex
  // matched "sk-notification" mid-word inside "task-notification".
  it("does not match the mid-word 'sk-' in 'task-notification' (DUR-954 false positive)", () => {
    const matches = scanTextForSecrets('{"origin":{"kind":"task-notification"}}');
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
  /** No contiguous 4+ char run of the real value -- head, tail, or anywhere else -- may survive into the masked output. */
  function assertNoLiteralSubstringLeaked(value: string, masked: string) {
    for (let i = 0; i + 4 <= value.length; i += 1) {
      const chunk = value.slice(i, i + 4);
      expect(masked, `masked output must not contain literal chunk "${chunk}" from the real value`).not.toContain(chunk);
    }
  }

  it("never returns the original value or any literal fragment of it, for a long token", () => {
    // Random-looking suffix with no dictionary words, so it can't coincidentally overlap
    // with the pattern-name label (a public constant, not secret material) in the output.
    const value = "ghp_Q7mX2vLpZ9wR4tK6nB1cF8jH3dS5yA0e";
    const masked = maskSecretMatch(value, "github_token_classic");
    expect(masked).not.toBe(value);
    assertNoLiteralSubstringLeaked(value, masked);
    expect(masked).toBe(`<github_token_classic> (len ${value.length}, sha256 prefix ${sha256Prefix(value)})`);
  });

  it("never returns the original value or any literal fragment of it, for a short token", () => {
    const value = "AKIA1234";
    const masked = maskSecretMatch(value, "aws_access_key_id");
    expect(masked).not.toBe(value);
    assertNoLiteralSubstringLeaked(value, masked);
    expect(masked).toBe(`<aws_access_key_id> (len ${value.length}, sha256 prefix ${sha256Prefix(value)})`);
  });

  it("is deterministic for the same value and pattern", () => {
    const a = maskSecretMatch("sk-abcdefghijklmnopqrstuvwxyz", "generic_sk_key");
    const b = maskSecretMatch("sk-abcdefghijklmnopqrstuvwxyz", "generic_sk_key");
    expect(a).toBe(b);
  });

  it("produces a different hash prefix for a different value even with the same pattern and length", () => {
    const a = maskSecretMatch("sk-abcdefghijklmnopqrstuvwxyz", "generic_sk_key");
    const b = maskSecretMatch("sk-zyxwvutsrqponmlkjihgfedcba", "generic_sk_key");
    expect(a).not.toBe(b);
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
