import { describe, expect, it } from "vitest";
import {
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  createClaudeLiveUsageTracker,
  createClaudeUsageCapTracker,
  parseClaudeStreamJson,
  readClaudeUsage,
} from "./parse.js";

function assistantEvent(usage: Record<string, number>) {
  return `${JSON.stringify({ type: "assistant", message: { usage } })}\n`;
}

describe("createClaudeLiveUsageTracker", () => {
  it("returns null until a full assistant event line has arrived", () => {
    const tracker = createClaudeLiveUsageTracker();
    const line = assistantEvent({ input_tokens: 10, output_tokens: 5 });
    expect(tracker.onChunk(line.slice(0, -1))).toBeNull();
  });

  it("accumulates input/output/cache tokens across multiple streamed events", () => {
    const tracker = createClaudeLiveUsageTracker();
    expect(
      tracker.onChunk(
        assistantEvent({
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        }),
      ),
    ).toEqual({ inputTokens: 100, cachedInputTokens: 8, outputTokens: 20 });

    expect(tracker.onChunk(assistantEvent({ input_tokens: 50, output_tokens: 10 }))).toEqual({
      inputTokens: 150,
      cachedInputTokens: 8,
      outputTokens: 30,
    });
  });

  it("handles a chunk split mid-line, only counting usage once the line completes", () => {
    const tracker = createClaudeLiveUsageTracker();
    const line = assistantEvent({ input_tokens: 40, output_tokens: 4 });
    const splitAt = Math.floor(line.length / 2);
    expect(tracker.onChunk(line.slice(0, splitAt))).toBeNull();
    expect(tracker.onChunk(line.slice(splitAt))).toEqual({
      inputTokens: 40,
      cachedInputTokens: 0,
      outputTokens: 4,
    });
  });

  it("ignores non-assistant lines and malformed JSON", () => {
    const tracker = createClaudeLiveUsageTracker();
    expect(tracker.onChunk(`${JSON.stringify({ type: "system", subtype: "init" })}\nnot json\n`)).toBeNull();
  });
});

function assistantLine(usage: Record<string, number>): string {
  return `${JSON.stringify({ type: "assistant", message: { usage } })}\n`;
}

// DUR-213: verifies the live token accountant that lets a run be killed
// mid-flight instead of only discovering the cost after it finishes.
describe("createClaudeUsageCapTracker", () => {
  it("never reports exceeded when the cap is 0 (disabled)", () => {
    const tracker = createClaudeUsageCapTracker(0);
    const exceeded = tracker.onChunk(
      assistantLine({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }),
    );
    expect(exceeded).toBe(false);
  });

  it("sums input, output, and both cache token fields across turns", () => {
    const tracker = createClaudeUsageCapTracker(0);
    tracker.onChunk(assistantLine({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }));
    tracker.onChunk(assistantLine({ input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 200 }));
    // DUR-3943: the cap still counts reads + writes (342), but the reported
    // usage keeps writes out of cachedInputTokens, matching uncapped runs.
    expect(tracker.getUsage()).toStrictEqual({
      inputTokens: 30,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 200,
      outputTokens: 12,
    });
    expect(tracker.getTotalTokens()).toBe(342);
  });

  it("still stops the run on cache writes alone (DUR-3943 split must not loosen the cap)", () => {
    const tracker = createClaudeUsageCapTracker(500);
    expect(tracker.onChunk(assistantLine({ cache_creation_input_tokens: 499 }))).toBe(false);
    expect(tracker.onChunk(assistantLine({ cache_creation_input_tokens: 1 }))).toBe(true);
  });

  it("reports exceeded once the running total reaches the cap", () => {
    const tracker = createClaudeUsageCapTracker(150);
    expect(tracker.onChunk(assistantLine({ input_tokens: 100 }))).toBe(false);
    expect(tracker.onChunk(assistantLine({ input_tokens: 60 }))).toBe(true);
  });

  it("buffers a line split across multiple chunks instead of dropping it", () => {
    const tracker = createClaudeUsageCapTracker(50);
    const line = assistantLine({ input_tokens: 100 });
    const splitAt = Math.floor(line.length / 2);
    expect(tracker.onChunk(line.slice(0, splitAt))).toBe(false);
    expect(tracker.onChunk(line.slice(splitAt))).toBe(true);
  });

  it("ignores non-assistant events and unparseable lines", () => {
    const tracker = createClaudeUsageCapTracker(10);
    tracker.onChunk(`${JSON.stringify({ type: "result", usage: { input_tokens: 999 } })}\nnot json\n`);
    expect(tracker.getTotalTokens()).toBe(0);
  });
});

// DUR-3943: the ticket's cost model read usage_json.cachedInputTokens as
// "cache reads at a tenth of the price" and had no cache writes at all. The
// numbers below are a real claude_local result event (Opus 4.8, 32 turns,
// total_cost_usd 1.7432): at $5/$25 per MTok with reads at 0.1x and 1-hour
// writes at 2x, input $0.019 + reads $0.597 + writes $0.619 + output $0.509
// = $1.743 exactly -- writes cost more than all 1.19M reads, and were dropped.
const REAL_RESULT_USAGE = {
  input_tokens: 3742,
  cache_creation_input_tokens: 61_868,
  cache_read_input_tokens: 1_194_217,
  output_tokens: 20_348,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 61_868, ephemeral_5m_input_tokens: 0 },
};

describe("readClaudeUsage (DUR-3943)", () => {
  it("keeps cachedInputTokens as reads only and reports cache writes and their 1-hour share separately", () => {
    expect(readClaudeUsage(REAL_RESULT_USAGE)).toStrictEqual({
      inputTokens: 3742,
      cachedInputTokens: 1_194_217,
      outputTokens: 20_348,
      cacheCreationInputTokens: 61_868,
      cacheCreation1hInputTokens: 61_868,
    });
  });

  it("omits the write fields when Claude did not report them, instead of claiming zero writes", () => {
    expect(readClaudeUsage({ input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 8 })).toStrictEqual({
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 8,
    });
    expect(readClaudeUsage(undefined)).toStrictEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });

  it("reports total writes even when the lifetime breakdown is missing", () => {
    expect(readClaudeUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 300 })).toStrictEqual({
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      cacheCreationInputTokens: 300,
    });
  });
});

describe("parseClaudeStreamJson — prompt cache detail (DUR-3943)", () => {
  function line(event: Record<string, unknown>) {
    return JSON.stringify(event);
  }

  it("records cache writes and the first model call's prompt size for the run", () => {
    const stdout = [
      line({ type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-4-8" }),
      // First model call: 2828 fresh + 15093 read + 4976 written = the standing context.
      line({
        type: "assistant",
        session_id: "s-1",
        message: {
          content: [{ type: "text", text: "Starting." }],
          usage: {
            input_tokens: 2828,
            cache_creation_input_tokens: 4976,
            cache_read_input_tokens: 15_093,
            output_tokens: 5,
          },
        },
      }),
      // A later call is bigger (the run's own work) and must not replace it.
      line({
        type: "assistant",
        session_id: "s-1",
        message: {
          content: [{ type: "text", text: "Done." }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 294, cache_read_input_tokens: 63_318, output_tokens: 716 },
        },
      }),
      line({ type: "result", subtype: "success", session_id: "s-1", result: "Done.", total_cost_usd: 1.7432, usage: REAL_RESULT_USAGE }),
    ].join("\n");

    expect(parseClaudeStreamJson(stdout).usage).toStrictEqual({
      inputTokens: 3742,
      cachedInputTokens: 1_194_217,
      outputTokens: 20_348,
      cacheCreationInputTokens: 61_868,
      cacheCreation1hInputTokens: 61_868,
      firstCallPromptTokens: 22_897,
    });
  });

  it("skips assistant events without usage when finding the first model call", () => {
    const stdout = [
      line({ type: "assistant", message: { content: [{ type: "text", text: "no usage on this one" }] } }),
      line({ type: "assistant", message: { content: [], usage: { input_tokens: 100, cache_read_input_tokens: 900 } } }),
      line({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 100, output_tokens: 1 } }),
    ].join("\n");

    expect(parseClaudeStreamJson(stdout).usage?.firstCallPromptTokens).toBe(1000);
  });
});

describe("detectClaudeLoginRequired", () => {
  it("classifies Claude's invalid API key login prompt as auth required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stderr: "Invalid API key · Please run /login",
      }),
    ).toEqual({ requiresLogin: true, loginUrl: null });
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stderr: "Invalid API key",
      }).requiresLogin,
    ).toBe(false);
  });

  it("does not classify a bare 'unauthorized' with no login context as requiring login (DUR-222)", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stderr: "Error: request failed: 401 unauthorized",
      }).requiresLogin,
    ).toBe(false);
  });

  it("still classifies 'unauthorized' paired with explicit login context as requiring login", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stderr: "401 unauthorized · please run /login",
      }).requiresLogin,
    ).toBe(true);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("classifies a quota stop as transient even when the message also contains 'unauthorized' (DUR-222)", () => {
    // Regression for the reported incident: a quota/rate-limit message that
    // happens to also contain the word "unauthorized" (e.g. wrapped 401
    // shape) must still win as transient_upstream, not claude_auth_required,
    // since the same shared credential succeeds again seconds later.
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "401 unauthorized: claude usage limit reached, resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stderr: "401 unauthorized: claude usage limit reached, resets 4pm (America/Chicago)",
      }).requiresLogin,
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeRefusalResult", () => {
  it("detects stop_reason: refusal even on a clean (is_error=false) result", () => {
    expect(
      isClaudeRefusalResult({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "refusal",
        result: "",
      }),
    ).toBe(true);
  });

  it("detects the camelCase stopReason variant", () => {
    expect(isClaudeRefusalResult({ stopReason: "refusal" })).toBe(true);
  });

  it("detects subtype: model_refusal", () => {
    expect(
      isClaudeRefusalResult({ subtype: "model_refusal", is_error: false }),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeRefusalResult({ stop_reason: "  Refusal " })).toBe(true);
  });

  it("returns false for ordinary successful turns", () => {
    expect(
      isClaudeRefusalResult({
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "Here is your answer.",
      }),
    ).toBe(false);
  });

  it("returns false for max-turns and other stop reasons", () => {
    expect(isClaudeRefusalResult({ stop_reason: "max_turns" })).toBe(false);
    expect(isClaudeRefusalResult({ subtype: "error_max_turns" })).toBe(false);
  });

  it("returns false for null/empty parsed result", () => {
    expect(isClaudeRefusalResult(null)).toBe(false);
    expect(isClaudeRefusalResult({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});
