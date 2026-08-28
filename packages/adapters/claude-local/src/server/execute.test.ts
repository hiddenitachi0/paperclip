import { describe, expect, it } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { ADVERSARIAL_SUCCESS_TRANSCRIPT } from "@paperclipai/adapter-utils/execution-classification-test-kit";
import { resolveClaudeAdapterResult, resolveClaudeBillingType, resolveClaudeSubscriptionOverage } from "./execute.js";
import { parseClaudeStreamJson, createClaudeUsageCapTracker } from "./parse.js";

// DUR-41: eight runs in one window were recorded `failed` (with the agent's
// own closing summary stored as the "error", and `claude_auth_required`
// attached to a completely successful run) purely because a post-completion
// SIGTERM (exitCode 143) delivered *after* Claude already produced a
// successful terminal JSON result was treated as an unconditional failure
// signal. These tests pin the fix: a genuine `is_error: false` terminal
// result must always win over the process exit code / raw stdout text.

const baseEnv = {
  timeoutSec: 600,
  cwd: "/workspace",
  promptBundleKey: "bundle-1",
  executionTargetIsRemote: false,
  remoteExecutionSessionIdentity: null,
  workspaceId: null,
  workspaceRepoUrl: null,
  workspaceRepoRef: null,
  effectiveEnv: {},
  model: "claude-sonnet-5",
  billingType: "subscription" as const,
  maxTokensPerRun: 0,
};

function buildProc(overrides: Partial<RunProcessResult> & { stdout: string }): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    pid: 4242,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function attemptFromStdout(stdout: string, proc: Partial<RunProcessResult> = {}) {
  const built = buildProc({ stdout, ...proc });
  const parsedStream = parseClaudeStreamJson(built.stdout);
  return {
    proc: built,
    parsedStream,
    parsed: parsedStream.resultJson ?? null,
    usageCapTracker: createClaudeUsageCapTracker(0),
  };
}

function successStreamStdout(summary: string, extra: Record<string, unknown> = {}) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-5" }),
    JSON.stringify({
      type: "assistant",
      session_id: "sess-1",
      message: { content: [{ type: "text", text: "Working on it..." }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sess-1",
      result: summary,
      total_cost_usd: 0.05,
      usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 20 },
      ...extra,
    }),
  ].join("\n");
}

describe("resolveClaudeAdapterResult — DUR-41 success/failure integrity", () => {
  it("keeps a run succeeded when the process is killed after it already produced a successful result", () => {
    const summary =
      "I have verified the redesign compiles cleanly, renders correctly, and PR #30 passed CI and merged.";
    const attempt = attemptFromStdout(successStreamStdout(summary), {
      exitCode: 143,
      signal: "SIGTERM",
    });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.killedAfterSuccess).toBe(true);
    expect(result.summary).toBe(summary);
  });

  it("never stores the agent's closing summary in the error column", () => {
    const summary = "This heartbeat work is done and durable; no further action needed.";
    const attempt = attemptFromStdout(successStreamStdout(summary), { exitCode: 143, signal: "SIGTERM" });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    // The regression bug: describeClaudeFailure() fell back to the summary
    // text as the "error". Assert the error column is genuinely empty, not
    // just non-identical to the summary.
    expect(result.errorMessage).toBeNull();
    expect(result.errorMessage).not.toBe(summary);
  });

  it("does not raise claude_auth_required when a successful run's transcript happens to mention 'unauthorized'", () => {
    // Simulates an agent legitimately testing an API and observing a 401
    // response body somewhere in its own tool output/stdout — incidental
    // text that used to get scanned by detectClaudeLoginRequired() against
    // the FULL raw stdout, regardless of whether the run actually succeeded.
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2", model: "claude-sonnet-5" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-2",
        message: {
          content: [
            { type: "text", text: 'curl returned {"error":"unauthorized"} for the old token, then I retried with the new one and it worked.' },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-2",
        result: "Confirmed the new API token is valid.",
        total_cost_usd: 0.01,
        usage: { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 8 },
      }),
    ].join("\n");
    const attempt = attemptFromStdout(stdout, { exitCode: 143, signal: "SIGTERM" });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorCode).not.toBe("claude_auth_required");
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("does not raise claude_transient_upstream when a successful run's transcript mentions rate limiting", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-3", model: "claude-sonnet-5" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-3",
        message: {
          content: [{ type: "text", text: "The upstream API returned 429 rate limit reached once, but a retry succeeded." }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-3",
        result: "Done — the flaky call now retries on 429.",
      }),
    ].join("\n");
    const attempt = attemptFromStdout(stdout, { exitCode: 143, signal: "SIGTERM" });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorCode).not.toBe("claude_transient_upstream");
    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
  });

  it("does not set killedAfterSuccess for an ordinary clean exit (exitCode 0)", () => {
    const attempt = attemptFromStdout(successStreamStdout("All good."), { exitCode: 0 });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.killedAfterSuccess).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it("still records a genuine failure (is_error: true) as failed, with a real error message", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-4",
        result: "Something actually broke.",
      }),
    ].join("\n");
    const attempt = attemptFromStdout(stdout, { exitCode: 1 });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorMessage).toContain("Something actually broke.");
    expect(result.killedAfterSuccess).toBe(false);
  });

  it("[DUR-258] never attaches an error code to a run the CLI reported successful, against the shared cross-adapter adversarial transcript", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-6", model: "claude-sonnet-5" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-6",
        message: { content: [{ type: "text", text: ADVERSARIAL_SUCCESS_TRANSCRIPT }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-6",
        result: "Done.",
      }),
    ].join("\n");
    const attempt = attemptFromStdout(stdout, { exitCode: 143, signal: "SIGTERM" });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.errorFamily).toBeNull();
  });

  it("[DUR-258] a genuine, unrelated failure is not mislabeled just because the transcript mentions auth/rate-limit words earlier", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-7", model: "claude-sonnet-5" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-7",
        message: { content: [{ type: "text", text: ADVERSARIAL_SUCCESS_TRANSCRIPT }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-7",
        result: "TypeError: cannot read property 'foo' of undefined",
      }),
    ].join("\n");
    const attempt = attemptFromStdout(stdout, { exitCode: 1 });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorMessage).toContain("cannot read property");
    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
  });

  it("still raises claude_auth_required for a genuine authentication failure", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-5",
        result: "Invalid API key · Please run /login",
      }),
    ].join("\n");
    const attempt = attemptFromStdout(stdout, { exitCode: 1 });

    const result = resolveClaudeAdapterResult(attempt, { fallbackSessionId: null }, baseEnv);

    expect(result.errorCode).toBe("claude_auth_required");
  });
});

// DUR-210: the Claude CLI never reports when subscription-included quota ran
// out and spend moved to overage/credits, so every run under subscription
// auth billed $0 forever. These pin the operator-declared-boundary fix.
describe("resolveClaudeBillingType (DUR-210)", () => {
  it("reports metered_api for bedrock auth regardless of any overage override", () => {
    const billingType = resolveClaudeBillingType(
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { exhaustedAt: new Date(0), billingType: "credits" },
    );
    expect(billingType).toBe("metered_api");
  });

  it("reports api when an API key is present, ignoring any overage override", () => {
    const billingType = resolveClaudeBillingType(
      { ANTHROPIC_API_KEY: "sk-test" },
      { exhaustedAt: new Date(0), billingType: "credits" },
    );
    expect(billingType).toBe("api");
  });

  it("reports subscription for subscription auth with no overage boundary set", () => {
    const billingType = resolveClaudeBillingType({}, null);
    expect(billingType).toBe("subscription");
  });

  it("still reports subscription before the declared exhaustion boundary", () => {
    const billingType = resolveClaudeBillingType({}, {
      exhaustedAt: new Date(Date.now() + 60_000),
      billingType: "subscription_overage",
    });
    expect(billingType).toBe("subscription");
  });

  it("reports the declared override type at/after the exhaustion boundary", () => {
    const billingType = resolveClaudeBillingType({}, {
      exhaustedAt: new Date(Date.now() - 60_000),
      billingType: "credits",
    });
    expect(billingType).toBe("credits");
  });
});

describe("resolveClaudeSubscriptionOverage (DUR-210)", () => {
  it("returns null when no boundary is configured", () => {
    expect(resolveClaudeSubscriptionOverage({})).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(resolveClaudeSubscriptionOverage({ subscriptionQuotaExhaustedAt: "not-a-date" })).toBeNull();
  });

  it("defaults to subscription_overage when no billing type is specified", () => {
    const result = resolveClaudeSubscriptionOverage({ subscriptionQuotaExhaustedAt: "2026-08-25T00:00:00Z" });
    expect(result?.billingType).toBe("subscription_overage");
    expect(result?.exhaustedAt.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("honors an explicit credits billing type override", () => {
    const result = resolveClaudeSubscriptionOverage({
      subscriptionQuotaExhaustedAt: "2026-08-25T00:00:00Z",
      subscriptionQuotaExhaustedBillingType: "credits",
    });
    expect(result?.billingType).toBe("credits");
  });
});
