import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactCardNumbers,
  redactEventPayload,
  redactHeartbeatRunPatchSecrets,
  redactKnownLeakedSecretPatterns,
  redactKnownLeakedSecretPatternsDeep,
  redactKnownSecretValues,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";

// DUR-4040: Stripe's canonical test Visa number -- obviously fake, Luhn-valid,
// and exactly the shape a real PAN would have. Used across this suite so a
// regression that stops redacting it is a single easy-to-spot failure.
const CANARY_CARD_NUMBER = "4242424242424242";

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

  // DUR-370: a fine-grained PAT on its own line (no other secret hint, no ".")
  // used to bypass the hint gate in redactSensitiveText entirely.
  it("redacts a fine-grained github_pat_ token even without another secret hint", () => {
    const pat =
      "github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = redactSensitiveText(`remote url had ${pat} in it`);
    expect(result).toBe(`remote url had ${REDACTED_EVENT_VALUE} in it`);
  });

  it("redacts a PEM private key block from unstructured text", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
    const result = redactSensitiveText(`deploy key was ${pem} oops`);
    expect(result).toBe(`deploy key was ${REDACTED_EVENT_VALUE} oops`);
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

  // DUR-1430 (DUR-954 false positive): the unanchored openai_key regex used
  // to match "sk-notification" mid-word inside "task-notification".
  it("does not treat the mid-word 'sk-' in 'task-notification' as a leaked openai_key", () => {
    const input = '{"origin":{"kind":"task-notification"}}';
    expect(redactKnownLeakedSecretPatterns(input)).toBe(input);
  });

  // DUR-322 adversarial review found these GitHub/Slack token variants missing.
  it("masks the remaining GitHub token variants and the Slack user token", () => {
    const input = [
      "gho_1234567890abcdefghijklmnopqrstuvwxyz",
      "ghu_1234567890abcdefghijklmnopqrstuvwxyz",
      "ghs_1234567890abcdefghijklmnopqrstuvwxyz",
      "ghr_1234567890abcdefghijklmnopqrstuvwxyz",
      "xoxp-test-fixture-not-a-real-token-000000",
    ].join("\n");

    const result = redactKnownLeakedSecretPatterns(input);

    expect(result).toContain("[REDACTED:github_oauth_token]");
    expect(result).toContain("[REDACTED:github_user_token]");
    expect(result).toContain("[REDACTED:github_app_installation_token]");
    expect(result).toContain("[REDACTED:github_refresh_token]");
    expect(result).toContain("[REDACTED:slack_user_token]");
    expect(result).not.toContain("gho_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("ghu_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("ghs_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("ghr_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("xoxp-test-fixture-not-a-real-token-000000");
  });
});

describe("redactCardNumbers", () => {
  it("redacts the canary card number wherever it appears in free text, spaced or not", () => {
    expect(redactCardNumbers(`Card on file: ${CANARY_CARD_NUMBER}`)).toBe(
      "Card on file: [REDACTED:card_number]",
    );
    expect(redactCardNumbers("Card on file: 4242 4242 4242 4242")).toBe(
      "Card on file: [REDACTED:card_number]",
    );
    expect(redactCardNumbers("Card on file: 4242-4242-4242-4242")).toBe(
      "Card on file: [REDACTED:card_number]",
    );
  });

  it("does not redact an ordinary long number that fails the Luhn check", () => {
    const input = "Order ID: 1234567890123456";
    expect(redactCardNumbers(input)).toBe(input);
  });

  it("DUR-4536: no longer tries to detect UUID shape at all -- a Luhn-valid run inside a UUID-looking string is always redacted", () => {
    // Earlier versions of this function tried to tell apart "incidental
    // UUID digit coincidence" from "a card number dressed up as a UUID" by
    // the shape of the surrounding characters. Every such heuristic was
    // defeatable (DUR-4535, DUR-4536), because the string is fully
    // attacker-controlled. redactCardNumbers no longer makes that
    // distinction at all -- it always redacts. The original DUR-4534
    // complaint (genuine server-generated UUIDs getting corrupted) is now
    // fixed at the call site, not here -- see the
    // redactKnownLeakedSecretPatternsDeep tests below for the exact-path
    // allowlist that protects known-safe fields instead.
    const input = "issueId: c10d6206-1c57-4904-9223-982c6cf4b18b";
    expect(redactCardNumbers(input)).toBe(
      "issueId: c10d6206-1c[REDACTED:card_number]c6cf4b18b",
    );
  });

  it("DUR-4536: redacts a card number padded with hex letters on both sides to fit a UUID's interior groups", () => {
    // DUR-4536's finding against the previous (now-removed) boundary
    // heuristic: a PAN placed in the middle groups of a UUID shape, with
    // hex letters on both sides so neither edge of the match touches the
    // UUID span's outer edge, used to pass through unredacted.
    const input = "aaaaaaaa-4111-1111-1111-1111aaaaaaaa";
    expect(redactCardNumbers(input)).toBe(
      "aaaaaaaa-[REDACTED:card_number]aaaaaaaa",
    );
  });

  it("DUR-4535: does not let a real card number dressed up as a UUID bypass redaction", () => {
    // The Visa test PAN 4111111111111111 laid out across the UUID's first
    // three dash groups, with the remaining groups padded as hex so the
    // whole token still matches the UUID shape. This must still be caught --
    // the card match starts at the UUID span's own start, so it is not
    // "incidental UUID noise" the way DUR-4534's fix is meant to protect.
    const input = "card: 41111111-1111-1111-aaaa-aaaaaaaaaaaa";
    expect(redactCardNumbers(input)).toBe(
      "card: [REDACTED:card_number]-aaaa-aaaaaaaaaaaa",
    );
  });

  it("DUR-4535: does not let a card number smuggled at the end of a UUID bypass redaction", () => {
    // Same trick, mirrored: the PAN occupies the UUID's trailing groups and
    // the match ends exactly at the UUID span's own end.
    const input = "card: aaaaaaaa-aaaa-aaaa-4111-111111111111";
    expect(redactCardNumbers(input)).toBe(
      "card: aaaaaaaa-aaaa-aaaa-[REDACTED:card_number]",
    );
  });

  it("DUR-4535: does not let a card number truncated by the 19-digit cap keep its UUID cover", () => {
    // The digit run here is 20 digits long -- one over CARD_NUMBER_TOKEN_RE's
    // 19-digit cap -- so the match itself falls one digit short of the
    // UUID's own end. That is an artifact of our own token regex, not a
    // genuine letter/dash boundary, so it must not be treated as "safely
    // embedded in the UUID" either. (First 19 digits, "1111111111111111113",
    // are themselves a valid Luhn check digit sequence; the trailing "4" is
    // just padding to make the full run 20 digits.)
    const input = "card: aaaaaaaa-aaaa-1111-1111-111111111134";
    expect(redactCardNumbers(input)).toBe(
      "card: aaaaaaaa-aaaa-[REDACTED:card_number]4",
    );
  });

  it("is folded into redactKnownLeakedSecretPatterns, the run-output redaction path", () => {
    const result = redactKnownLeakedSecretPatterns(
      `browser_type filled the field with ${CANARY_CARD_NUMBER}`,
    );
    expect(result).not.toContain(CANARY_CARD_NUMBER);
    expect(result).toContain("[REDACTED:card_number]");
  });

  it("is folded into the deep-walk activity-log/workspace-metadata redaction path", () => {
    const result = redactKnownLeakedSecretPatternsDeep({
      note: `typed ${CANARY_CARD_NUMBER} into the form`,
      nested: [{ detail: CANARY_CARD_NUMBER }],
    }) as { note: string; nested: Array<{ detail: string }> };
    expect(result.note).not.toContain(CANARY_CARD_NUMBER);
    expect(result.nested[0].detail).not.toContain(CANARY_CARD_NUMBER);
  });
});

describe("canary card number never survives serialization (DUR-4040)", () => {
  it("is redacted from an activity-log-shaped details object via sanitizeRecord", () => {
    const result = sanitizeRecord({
      cardNumber: CANARY_CARD_NUMBER,
      cvc: "123",
      cardCvc: "123",
      label: "Test card",
    });
    expect(result.cardNumber).toBe(REDACTED_EVENT_VALUE);
    expect(result.cvc).toBe(REDACTED_EVENT_VALUE);
    expect(result.cardCvc).toBe(REDACTED_EVENT_VALUE);
    expect(result.label).toBe("Test card");
    expect(JSON.stringify(result)).not.toContain(CANARY_CARD_NUMBER);
  });

  it("is redacted from an unstructured log/transcript line even with no field name at all", () => {
    const line = `POST /checkout body: {"total":"499 kr","card":"${CANARY_CARD_NUMBER}"}`;
    const result = redactKnownLeakedSecretPatterns(line);
    expect(result).not.toContain(CANARY_CARD_NUMBER);
  });
});

// DUR-372: exported so workspace-operations.ts can scrub its own
// arbitrary-shaped `metadata` JSON with the same deep-walk used internally
// by redactHeartbeatRunPatchSecrets below.
describe("redactKnownLeakedSecretPatternsDeep", () => {
  it("redacts a matching pattern nested inside arrays and objects", () => {
    const input = {
      remoteUrl: "https://x-access-token:ghp_1234567890abcdefghijklmnopqrstuvwxyz@github.com/acme/app.git",
      history: ["clean line", { note: "AKIAABCDEFGHIJKLMNOP leaked here" }],
    };

    expect(redactKnownLeakedSecretPatternsDeep(input)).toEqual({
      remoteUrl: "https://x-access-token:[REDACTED:github_token]@github.com/acme/app.git",
      history: ["clean line", { note: "[REDACTED:aws_access_key_id] leaked here" }],
    });
  });

  it("leaves non-string primitives and clean values untouched", () => {
    const input = { count: 3, ok: true, nested: { safe: "no secret here" } };
    expect(redactKnownLeakedSecretPatternsDeep(input)).toEqual(input);
  });

  it("DUR-4534/4536: preserves a genuine UUID at the known workspaceValidation id paths", () => {
    const input = {
      workspaceValidation: {
        reason: "missing_project_id",
        issueId: "c10d6206-1c57-4904-9223-982c6cf4b18b",
        issueProjectId: "aaaaaaaa-4111-1111-1111-1111aaaaaaaa",
        unrelatedNote: "plain text",
      },
    };
    expect(redactKnownLeakedSecretPatternsDeep(input)).toEqual(input);
  });

  it("DUR-4536: still redacts a card-shaped value at a path NOT on the known-id allowlist, even if it is UUID-shaped", () => {
    // The allowlist is by exact field path, not by "looks like a UUID" --
    // a value under an unrecognized key still gets the full scrub, so
    // smuggling a PAN into some other field of workspaceValidation (or
    // anywhere else in resultJson) does not get a free pass just because
    // the string happens to be UUID-shaped.
    const input = {
      workspaceValidation: {
        reason: "missing_project_id",
        attackerControlledNote: "aaaaaaaa-4111-1111-1111-1111aaaaaaaa",
      },
    };
    const result = redactKnownLeakedSecretPatternsDeep(input) as {
      workspaceValidation: { attackerControlledNote: string };
    };
    expect(result.workspaceValidation.attackerControlledNote).toBe(
      "aaaaaaaa-[REDACTED:card_number]aaaaaaaa",
    );
  });

  it("DUR-4536: a malformed value at a known id path (not actually a UUID) still gets scrubbed", () => {
    const input = {
      workspaceValidation: {
        issueId: `prefix ${CANARY_CARD_NUMBER} suffix`,
      },
    };
    const result = redactKnownLeakedSecretPatternsDeep(input) as {
      workspaceValidation: { issueId: string };
    };
    expect(result.workspaceValidation.issueId).not.toContain(CANARY_CARD_NUMBER);
  });

  // DUR-4538: cancelRunInternal's operator-interrupt resultJson
  // (operatorInterruptCancelOptions in routes/issues.ts) writes the real
  // issue.id to a root-level `interruptedIssueId` field, not under
  // `workspaceValidation` -- it needs its own allowlist entry.
  it("DUR-4538: preserves a genuine UUID at the root-level interruptedIssueId path used by operator-interrupt cancellation", () => {
    const input = {
      operatorInterrupted: true,
      interruptionSource: "issue_comment_interrupt",
      interruptedIssueId: "c10d6206-1c57-4904-9223-982c6cf4b18b",
    };
    expect(redactKnownLeakedSecretPatternsDeep(input)).toEqual(input);
  });

  it("DUR-4538: still redacts a card-shaped value smuggled under a field that merely resembles interruptedIssueId", () => {
    const input = { otherInterruptedIssueId: "aaaaaaaa-4111-1111-1111-1111aaaaaaaa" };
    const result = redactKnownLeakedSecretPatternsDeep(input) as { otherInterruptedIssueId: string };
    expect(result.otherInterruptedIssueId).toBe("aaaaaaaa-[REDACTED:card_number]aaaaaaaa");
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
