import type { AdapterExecutionErrorFamily } from "./types.js";

// ---------------------------------------------------------------------------
// Shared, rule-enforcing outcome classifier. See DUR-258.
//
// Every adapter used to hand-write its own "is this run an auth failure / a
// rate limit / a genuine success" logic, independently, 12 times over. The
// duplicated logic diverged and — worse — several copies pattern-matched
// error-code keywords (429, rate limit, unauthorized, try again later)
// against the *entire* process transcript instead of the CLI's own
// structured error text. An agent merely *discussing* a rate limit (e.g.
// while retrying a CI job) or *working on our own auth hardening* was enough
// to mislabel a successful run as upstream downtime or a logout.
//
// Three rules, enforced structurally here rather than by caller discipline:
//   1. The CLI's own structured success/failure verdict always wins.
//   2. Pattern matching runs only over extracted error text, never a full
//      transcript — this function has no `stdout`/`stderr`/`transcript`
//      parameter on purpose, so passing a transcript in is a type error at
//      the call site, not something a reviewer has to remember to catch.
//   3. A run whose CLI verdict is "success" can never carry an error code —
//      the `ok: true` branch below returns unconditionally, before any
//      pattern is even considered.
// ---------------------------------------------------------------------------

/**
 * The CLI's own structured outcome signal for a single run, as reported by
 * the tool itself (e.g. Claude's `is_error`, Gemini's result `status`).
 *
 * "unknown" means the CLI produced no parseable structured result at all
 * (e.g. the process crashed before emitting one) — that is the *only* case
 * where a caller may fall back to a process-level signal like exit code, and
 * it must still not be treated as "success".
 */
export type AdapterCliVerdict = "success" | "failure" | "unknown";

export interface AdapterErrorPattern {
  /** Adapter-specific error code to attach when this pattern matches, e.g. "gemini_auth_required". */
  code: string;
  family?: AdapterExecutionErrorFamily | null;
  re: RegExp;
}

export interface ClassifyAdapterOutcomeInput {
  cliVerdict: AdapterCliVerdict;
  /**
   * The extracted error text to pattern-match against — the CLI's own
   * error/result field, a single stderr line, or similar. Never the full
   * stdout transcript or agent conversation.
   */
  errorText: string | null | undefined;
  /** Fallback message used when no pattern matches but the run still failed. */
  fallbackErrorMessage: string;
  /** Patterns tested in order; first match wins. */
  patterns: AdapterErrorPattern[];
}

export type AdapterOutcome =
  | { ok: true }
  | {
      ok: false;
      errorCode: string | null;
      errorFamily: AdapterExecutionErrorFamily | null;
      errorMessage: string;
    };

/**
 * Classify a single run's outcome. See module doc for the three rules.
 */
export function classifyAdapterOutcome(input: ClassifyAdapterOutcomeInput): AdapterOutcome {
  // Rule 3 (structural): a CLI-confirmed success can never carry an error
  // code. Nothing below this line can override it.
  if (input.cliVerdict === "success") {
    return { ok: true };
  }

  const text = (input.errorText ?? "").trim();
  const match = text ? input.patterns.find((pattern) => pattern.re.test(text)) : undefined;

  return {
    ok: false,
    errorCode: match?.code ?? null,
    errorFamily: match?.family ?? null,
    errorMessage: input.fallbackErrorMessage,
  };
}
