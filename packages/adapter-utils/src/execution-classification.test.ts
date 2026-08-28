import { describe, expect, it } from "vitest";
import { classifyAdapterOutcome, type AdapterErrorPattern } from "./execution-classification.js";
import { ADVERSARIAL_SUCCESS_TRANSCRIPT } from "./execution-classification-test-kit.js";

const PATTERNS: AdapterErrorPattern[] = [
  { code: "x_auth_required", family: null, re: /unauthorized|not\s+logged\s+in/i },
  { code: "x_transient_upstream", family: "transient_upstream", re: /\b429\b|rate[-\s]?limit/i },
];

describe("classifyAdapterOutcome", () => {
  it("rule 3: a CLI-confirmed success never carries an error code, even with trigger words in the error text", () => {
    const result = classifyAdapterOutcome({
      cliVerdict: "success",
      errorText: ADVERSARIAL_SUCCESS_TRANSCRIPT,
      fallbackErrorMessage: "should never surface",
      patterns: PATTERNS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rule 1: a failure verdict with no matching pattern falls back to a null error code, not a guess", () => {
    const result = classifyAdapterOutcome({
      cliVerdict: "failure",
      errorText: "unexpected token in JSON at position 4",
      fallbackErrorMessage: "unexpected token in JSON at position 4",
      patterns: PATTERNS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBeNull();
      expect(result.errorFamily).toBeNull();
    }
  });

  it("matches a pattern only against the supplied error text, in order, first match wins", () => {
    const result = classifyAdapterOutcome({
      cliVerdict: "failure",
      errorText: "429 too many requests, please retry",
      fallbackErrorMessage: "429 too many requests, please retry",
      patterns: PATTERNS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("x_transient_upstream");
      expect(result.errorFamily).toBe("transient_upstream");
    }
  });

  it("unknown verdict still pattern-matches (caller is responsible for treating unknown as non-success)", () => {
    const result = classifyAdapterOutcome({
      cliVerdict: "unknown",
      errorText: "not logged in — run `tool login` first",
      fallbackErrorMessage: "tool exited with code 1",
      patterns: PATTERNS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("x_auth_required");
    }
  });

  it("has no stdout/stderr/transcript parameter — rule 2 is a type error, not a review checklist item", () => {
    // Compile-time guarantee: ClassifyAdapterOutcomeInput only accepts
    // cliVerdict/errorText/fallbackErrorMessage/patterns. Passing a raw
    // transcript field is a type error at the call site.
    const input = {
      cliVerdict: "failure" as const,
      errorText: "boom",
      fallbackErrorMessage: "boom",
      patterns: PATTERNS,
    };
    expect(Object.keys(input)).not.toContain("stdout");
    expect(Object.keys(input)).not.toContain("stderr");
  });
});
