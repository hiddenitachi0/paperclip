import { describe, expect, it } from "vitest";
import { LaneAProviderError } from "../services/lane-a-providers.js";

/**
 * DUR-4347: `LaneAProviderError.retryable`/`.refusal` drive the fallback
 * loop's routing decisions (lane-a.ts's `runLaneAFallbackLoop`). This locks in
 * the classification rules the ticket lists explicitly: connection failure,
 * timeout, 5xx, 429 and "model not loaded/not found" are retryable; a bad key
 * is not; a provider's own content-policy rejection is a refusal (and never
 * also retryable in the no-answer sense); an ordinary 4xx (our own malformed
 * request) is neither.
 */
describe("LaneAProviderError retryable/refusal classification", () => {
  it("a network failure (connection refused / DNS) is retryable, not a refusal", () => {
    const err = new LaneAProviderError({ kind: "network", provider: "local", message: "Could not reach Local model: connect ECONNREFUSED" });
    expect(err.retryable).toBe(true);
    expect(err.refusal).toBe(false);
  });

  it("a timeout is retryable", () => {
    const err = new LaneAProviderError({ kind: "network", provider: "local", message: "Local model did not answer within 5 seconds." });
    expect(err.retryable).toBe(true);
    expect(err.refusal).toBe(false);
  });

  it("a 429 rate limit is retryable", () => {
    const err = new LaneAProviderError({ kind: "rate_limit", provider: "openai", status: 429, message: "OpenAI is rate limited." });
    expect(err.retryable).toBe(true);
  });

  it("a 5xx upstream failure is retryable", () => {
    const err = new LaneAProviderError({ kind: "upstream", provider: "openai", status: 503, message: "OpenAI answered 503: overloaded" });
    expect(err.retryable).toBe(true);
    expect(err.refusal).toBe(false);
  });

  it("'model not found'/'model not loaded' upstream errors are retryable", () => {
    const notFound = new LaneAProviderError({
      kind: "upstream",
      provider: "local",
      status: 400,
      message: 'Local model answered 400: {"error":{"message":"The requested model \'DeepSeek-V3\' does not exist."}}',
    });
    expect(notFound.retryable).toBe(true);
    const notLoaded = new LaneAProviderError({
      kind: "upstream",
      provider: "local",
      status: 404,
      message: "Local model answered 404: model 'llama3' is not available",
    });
    expect(notLoaded.retryable).toBe(true);
  });

  it("a bad key (auth) is NOT retryable — a different model on the same key would fail identically", () => {
    const err = new LaneAProviderError({ kind: "auth", provider: "openai", status: 401, message: "OpenAI refused the key." });
    expect(err.retryable).toBe(false);
    expect(err.refusal).toBe(false);
  });

  it("an ordinary 4xx (our own malformed request) is neither retryable nor a refusal", () => {
    const err = new LaneAProviderError({
      kind: "upstream",
      provider: "openai",
      status: 400,
      message: "OpenAI answered 400: Invalid value for 'temperature': must be between 0 and 2.",
    });
    expect(err.retryable).toBe(false);
    expect(err.refusal).toBe(false);
  });

  it("a content-policy rejection is a refusal, and is never also retryable on the no-answer path", () => {
    const err = new LaneAProviderError({
      kind: "upstream",
      provider: "openai",
      status: 400,
      message: 'OpenAI answered 400: {"error":{"message":"Your request was rejected as a result of our content management policy."}}',
    });
    expect(err.refusal).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it("an explicit retryable/refusal override wins over the derived classification", () => {
    const err = new LaneAProviderError({
      kind: "upstream",
      provider: "openai",
      status: 418,
      message: "teapot",
      retryable: true,
      refusal: false,
    });
    expect(err.retryable).toBe(true);
    expect(err.refusal).toBe(false);
  });
});
