import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactEventPayload,
  redactHeartbeatRunPatchSecrets,
  redactKnownLeakedSecretPatterns,
  redactKnownSecretValues,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});

// DUR-132: a resolved mcpServers secret_ref value has no known process-env
// variable NAME to key off (it's nested inside adapterConfig.mcpServers[*]
// .env/.headers), so run output redaction has to scrub it by literal value
// instead -- this is the mechanism resolveExecutionRunAdapterConfig's
// secretValues set feeds into for run log output (see heartbeat.ts).
describe("redactKnownSecretValues", () => {
  it("scrubs every occurrence of a known secret value", () => {
    const result = redactKnownSecretValues(
      "token=sk-live-abc123 and again sk-live-abc123 at the end",
      ["sk-live-abc123"],
    );
    expect(result).toBe(`token=${REDACTED_EVENT_VALUE} and again ${REDACTED_EVENT_VALUE} at the end`);
  });

  it("scrubs multiple distinct secret values", () => {
    const result = redactKnownSecretValues("a=first-secret b=second-secret", ["first-secret", "second-secret"]);
    expect(result).toBe(`a=${REDACTED_EVENT_VALUE} b=${REDACTED_EVENT_VALUE}`);
  });

  it("ignores empty and too-short values to avoid mangling unrelated output", () => {
    const result = redactKnownSecretValues("short values like ab or empty should survive", ["", "ab"]);
    expect(result).toBe("short values like ab or empty should survive");
  });

  it("is a no-op when no secret values are given", () => {
    expect(redactKnownSecretValues("nothing to redact here", [])).toBe("nothing to redact here");
  });
});

// DUR-292 item 2 (DUR-317): a GitHub PAT sitting in a git remote URL got
// copied verbatim into 706 heartbeat_runs rows (NOR-316) because nothing
// masked agent output for fixed-shape secret patterns before it was
// persisted. These patterns are unregistered (never a known Secret), so
// redactKnownSecretValues (which only scrubs literal known-secret values)
// can't catch them -- this is the write-time gate for that class of leak.
describe("redactKnownLeakedSecretPatterns", () => {
  it("masks every known leaked-secret pattern with its pattern-name marker", () => {
    const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
    const input = [
      "github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "sk-live1234567890abcdef",
      "shpss_testfixtureNOTREALzzzzzzzzzzzzzzzz",
      "shpat_testfixtureNOTREALzzzzzzzzzzzzzzzz",
      "xoxb-test-fixture-not-a-real-token-000000",
      "AKIAABCDEFGHIJKLMNOP",
      privateKey,
    ].join("\n");

    const result = redactKnownLeakedSecretPatterns(input);

    expect(result).toContain("[REDACTED:github_pat]");
    expect(result).toContain("[REDACTED:github_token]");
    expect(result).toContain("[REDACTED:openai_key]");
    expect(result).toContain("[REDACTED:shopify_shared_secret]");
    expect(result).toContain("[REDACTED:shopify_access_token]");
    expect(result).toContain("[REDACTED:slack_bot_token]");
    expect(result).toContain("[REDACTED:aws_access_key_id]");
    expect(result).toContain("[REDACTED:pem_private_key]");
    expect(result).not.toContain("github_pat_11AAAAAAA0aaaaaaaaaaaa");
    expect(result).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("MIIBOgIBAAJBAK");
  });

  it("leaves surrounding log context untouched so debugging stays useful", () => {
    const input = "remote sync failed for https://x-access-token:ghp_1234567890abcdefghijklmnopqrstuvwxyz@github.com/org/repo.git: exit 128";

    const result = redactKnownLeakedSecretPatterns(input);

    expect(result).toBe(
      "remote sync failed for https://x-access-token:[REDACTED:github_token]@github.com/org/repo.git: exit 128",
    );
  });

  it("is a byte-for-byte no-op when no pattern matches", () => {
    const input = "run completed successfully, no credentials here";
    expect(redactKnownLeakedSecretPatterns(input)).toBe(input);
  });
});

describe("redactHeartbeatRunPatchSecrets", () => {
  it("redacts matching patterns in error, stdoutExcerpt, stderrExcerpt, and nested resultJson strings", () => {
    const patch = {
      error: "push failed: ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      stdoutExcerpt: "cloning with token AKIAABCDEFGHIJKLMNOP",
      stderrExcerpt: "auth error using sk-live1234567890abcdef",
      resultJson: {
        summary: "done",
        stdout: "remote url had github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa in it",
        nested: { detail: "slack token xoxb-test-fixture-not-a-real-token-000000 leaked" },
      },
      errorCode: "adapter_failed",
      exitCode: 1,
    };

    const result = redactHeartbeatRunPatchSecrets(patch);

    expect(result.error).toBe("push failed: [REDACTED:github_token]");
    expect(result.stdoutExcerpt).toBe("cloning with token [REDACTED:aws_access_key_id]");
    expect(result.stderrExcerpt).toBe("auth error using [REDACTED:openai_key]");
    expect(result.resultJson).toEqual({
      summary: "done",
      stdout: "remote url had [REDACTED:github_pat] in it",
      nested: { detail: "slack token [REDACTED:slack_bot_token] leaked" },
    });
    // Unrelated fields pass through unchanged.
    expect(result.errorCode).toBe("adapter_failed");
    expect(result.exitCode).toBe(1);
  });

  it("is unaffected byte-for-byte when no field contains a matching pattern", () => {
    const patch = {
      error: "agent exited cleanly",
      stdoutExcerpt: "build succeeded",
      stderrExcerpt: null,
      resultJson: { summary: "ok", cost_usd: 0.12, nested: { safe: true } },
      errorCode: null,
      exitCode: 0,
    };

    expect(redactHeartbeatRunPatchSecrets(patch)).toEqual(patch);
  });

  it("leaves patches without the target fields untouched", () => {
    const patch = { status: "queued", updatedAt: new Date("2026-01-01T00:00:00Z") };
    expect(redactHeartbeatRunPatchSecrets(patch)).toEqual(patch);
  });
});
