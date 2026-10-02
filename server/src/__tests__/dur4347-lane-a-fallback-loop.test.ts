import { describe, expect, it } from "vitest";
import {
  LANE_A_MAIN_POOL_ID,
  laneAKeywordPhraseMatches,
  resolveLaneARouting,
  runLaneAFallbackLoop,
  type LaneAFallbackAttemptResult,
} from "../services/lane-a.js";

/**
 * DUR-4347: the quick-agent backup-model pool, its two ordered fallback
 * chains (no-answer / refusal) and keyword routing. These tests exercise the
 * pure routing/loop engine in isolation (no DB, no provider client) per the
 * ticket's "Tests required" list.
 */
describe("laneAKeywordPhraseMatches", () => {
  it("matches a whole word case-insensitively", () => {
    expect(laneAKeywordPhraseMatches("Can I talk to a HUMAN please", "human")).toBe(true);
    expect(laneAKeywordPhraseMatches("humanity is great", "human")).toBe(false);
  });

  it("matches a multi-word phrase", () => {
    expect(laneAKeywordPhraseMatches("I'd like to speak to a real person now", "speak to a real person")).toBe(true);
  });

  it("does not match a substring inside another word", () => {
    expect(laneAKeywordPhraseMatches("rehumanize the discussion", "human")).toBe(false);
  });
});

describe("resolveLaneARouting", () => {
  const baseAgent = {
    laneAProvider: "anthropic",
    laneAModel: "claude-sonnet-5",
    laneABaseUrl: null,
    laneATemperature: null,
    laneABackupModels: [
      { id: "b1", provider: "openai", model: "gpt-4.1-mini" },
      { id: "b2", provider: "openai", model: "gpt-4.1" },
      { id: "b3", provider: "local", model: "llama3", baseUrl: "http://localhost:11434/v1" },
    ],
    laneANoAnswerChainIds: ["b1", "b2"],
    laneARefusalChainIds: ["b3"],
    laneAKeywordRoutes: [{ id: "r1", phrases: ["human", "person"], backupId: "b2" }],
  };

  it("starts at main and builds both chains when no keyword matches", () => {
    const result = resolveLaneARouting(baseAgent, "what's the weather like");
    expect(result.start).toBe(LANE_A_MAIN_POOL_ID);
    expect(result.startRule).toBeNull();
    expect(result.noAnswerChain).toEqual(["main", "b1", "b2"]);
    expect(result.refusalChain).toEqual(["b3"]);
    expect(result.pool.size).toBe(4);
  });

  it("routes to the keyword's backup as the start, recording the rule", () => {
    const result = resolveLaneARouting(baseAgent, "I want to talk to a human");
    expect(result.start).toBe("b2");
    expect(result.startRule).toBe("keyword:r1");
    // the no-answer chain still prepends the (keyword-picked) start
    expect(result.noAnswerChain).toEqual(["b2", "b1"]);
  });

  it("de-duplicates when the start also appears in the configured chain", () => {
    const result = resolveLaneARouting(
      { ...baseAgent, laneANoAnswerChainIds: ["b1", "main", "b2"] },
      "anything",
    );
    expect(result.noAnswerChain).toEqual(["main", "b1", "b2"]);
  });

  it("silently drops chain/route ids that no longer exist in the pool", () => {
    const result = resolveLaneARouting(
      {
        ...baseAgent,
        laneABackupModels: [{ id: "b1", provider: "openai", model: "gpt-4.1-mini" }],
        laneANoAnswerChainIds: ["b1", "ghost"],
        laneARefusalChainIds: ["ghost2"],
        laneAKeywordRoutes: [{ id: "r1", phrases: ["human"], backupId: "ghost3" }],
      },
      "talk to a human",
    );
    expect(result.start).toBe(LANE_A_MAIN_POOL_ID); // the route's backupId doesn't exist, so it's skipped
    expect(result.noAnswerChain).toEqual(["main", "b1"]);
    expect(result.refusalChain).toEqual([]);
  });

  it("an empty pool/chains means every turn is a bare main attempt", () => {
    const result = resolveLaneARouting(
      { laneAProvider: "anthropic", laneAModel: "claude-sonnet-5" },
      "hello",
    );
    expect(result.noAnswerChain).toEqual(["main"]);
    expect(result.refusalChain).toEqual([]);
  });
});

/** Builds a scripted `attempt` function from an ordered outcome list, keyed by pool id call order. */
function scriptedAttempts<T>(
  script: Record<string, LaneAFallbackAttemptResult<T>>,
): { attempt: (poolId: string) => Promise<LaneAFallbackAttemptResult<T>>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    attempt: async (poolId: string) => {
      calls.push(poolId);
      const result = script[poolId];
      if (!result) throw new Error(`no script entry for pool id "${poolId}"`);
      return result;
    },
  };
}

describe("runLaneAFallbackLoop", () => {
  it("answers on the first (main) attempt when nothing fails", async () => {
    const { attempt, calls } = scriptedAttempts<string>({ main: { outcome: "answered", value: "hi" } });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main"], refusalChain: [], attempt });
    expect(result).toEqual({ ok: true, value: "hi", poolId: "main", answeredBy: "main" });
    expect(calls).toEqual(["main"]);
  });

  it("falls back to backup 1 when main is down (retryable)", async () => {
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "retryable_error", error: new Error("main down") },
      b1: { outcome: "answered", value: "from b1" },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main", "b1", "b2"], refusalChain: [], attempt });
    expect(result).toEqual({ ok: true, value: "from b1", poolId: "b1", answeredBy: "no_answer_chain" });
    expect(calls).toEqual(["main", "b1"]);
  });

  it("falls back to backup 2 when main and backup 1 are both down", async () => {
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "retryable_error", error: new Error("main down") },
      b1: { outcome: "retryable_error", error: new Error("b1 down") },
      b2: { outcome: "answered", value: "from b2" },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main", "b1", "b2"], refusalChain: [], attempt });
    expect(result).toEqual({ ok: true, value: "from b2", poolId: "b2", answeredBy: "no_answer_chain" });
    expect(calls).toEqual(["main", "b1", "b2"]);
  });

  it("returns one plain error when the whole no-answer chain is exhausted", async () => {
    const finalError = new Error("b2 down too");
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "retryable_error", error: new Error("main down") },
      b1: { outcome: "retryable_error", error: new Error("b1 down") },
      b2: { outcome: "retryable_error", error: finalError },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main", "b1", "b2"], refusalChain: [], attempt });
    expect(result).toEqual({ ok: false, error: finalError });
    expect(calls).toEqual(["main", "b1", "b2"]);
  });

  it("a refusal on main jumps straight to the refusal chain's first entry, not the no-answer chain", async () => {
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "refusal", error: new Error("refused") },
      b1: { outcome: "answered", value: "should not be tried" },
      b3: { outcome: "answered", value: "from refusal chain" },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main", "b1"], refusalChain: ["b3"], attempt });
    expect(result).toEqual({ ok: true, value: "from refusal chain", poolId: "b3", answeredBy: "refusal_chain" });
    // b1 (the no-answer chain's next entry) must never be tried once a refusal fires.
    expect(calls).toEqual(["main", "b3"]);
  });

  it("a repeat refusal inside the refusal chain advances to its next entry", async () => {
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "refusal", error: new Error("refused") },
      b3: { outcome: "refusal", error: new Error("refused again") },
      b4: { outcome: "answered", value: "from b4" },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main"], refusalChain: ["b3", "b4"], attempt });
    expect(result).toEqual({ ok: true, value: "from b4", poolId: "b4", answeredBy: "refusal_chain" });
    expect(calls).toEqual(["main", "b3", "b4"]);
  });

  it("a timeout (retryable) inside the refusal chain also advances to its next entry", async () => {
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "refusal", error: new Error("refused") },
      b3: { outcome: "retryable_error", error: new Error("timed out") },
      b4: { outcome: "answered", value: "from b4" },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main"], refusalChain: ["b3", "b4"], attempt });
    expect(result).toEqual({ ok: true, value: "from b4", poolId: "b4", answeredBy: "refusal_chain" });
    expect(calls).toEqual(["main", "b3", "b4"]);
  });

  it("refusal-chain exhaustion returns one plain error", async () => {
    const finalError = new Error("b4 refused too");
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "refusal", error: new Error("refused") },
      b3: { outcome: "refusal", error: new Error("refused again") },
      b4: { outcome: "refusal", error: finalError },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main"], refusalChain: ["b3", "b4"], attempt });
    expect(result).toEqual({ ok: false, error: finalError });
    expect(calls).toEqual(["main", "b3", "b4"]);
  });

  it("an empty refusal chain means a refusal returns one plain error immediately", async () => {
    const refusalError = new Error("refused, nowhere to go");
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "refusal", error: refusalError },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main", "b1"], refusalChain: [], attempt });
    expect(result).toEqual({ ok: false, error: refusalError });
    expect(calls).toEqual(["main"]);
  });

  it("a fatal (non-retryable, non-refusal) error returns one plain error immediately, without trying further entries", async () => {
    const fatal = new Error("malformed request");
    const { attempt, calls } = scriptedAttempts<string>({
      main: { outcome: "fatal_error", error: fatal },
      b1: { outcome: "answered", value: "should never be reached" },
    });
    const result = await runLaneAFallbackLoop({ noAnswerChain: ["main", "b1"], refusalChain: ["b2"], attempt });
    expect(result).toEqual({ ok: false, error: fatal });
    expect(calls).toEqual(["main"]);
  });

  it("keyword routing starts at the mapped backup without trying main first", async () => {
    const routing = resolveLaneARouting(
      {
        laneAProvider: "anthropic",
        laneAModel: "claude-sonnet-5",
        laneABackupModels: [{ id: "b1", provider: "openai", model: "gpt-4.1-mini" }],
        laneAKeywordRoutes: [{ id: "r1", phrases: ["human"], backupId: "b1" }],
      },
      "let me talk to a human",
    );
    expect(routing.startRule).toBe("keyword:r1");
    const { attempt, calls } = scriptedAttempts<string>({
      b1: { outcome: "answered", value: "from the keyword-routed backup" },
    });
    const result = await runLaneAFallbackLoop({
      noAnswerChain: routing.noAnswerChain,
      refusalChain: routing.refusalChain,
      attempt,
    });
    expect(result).toEqual({ ok: true, value: "from the keyword-routed backup", poolId: "b1", answeredBy: "main" });
    // "main" here is the loop's own "answered on the chain's first entry"
    // signal; the caller (lane-a.ts) upgrades this to "keyword" using
    // routing.startRule, exactly as it does for the real attempt-record rule.
    expect(calls).toEqual(["b1"]);
  });
});
