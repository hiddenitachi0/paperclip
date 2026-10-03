/**
 * DUR-4347: text-refusal detection for the quick-agent fallback loop.
 *
 * A provider sometimes refuses not with an error (classified in
 * lane-a-providers.ts's `LaneAProviderError.refusal`) but with a normal,
 * successful completion whose TEXT is the refusal ("I can't help with
 * that."). The fallback loop (lane-a.ts) needs to catch this case too, or a
 * refusal chain configured for "when it refuses" would never fire for the
 * common case of a model that refuses in words rather than with an HTTP
 * error.
 *
 * Two passes, both optional and independent:
 *   1. A pattern pass over a curated list of refusal openers -- cheap,
 *      synchronous, always run. Records which pattern fired so the operator
 *      can see why a turn was routed to the refusal chain.
 *   2. An optional cheap-classifier pass (default OFF, per-agent-gated by the
 *      caller), for the harder cases a pattern list cannot catch. Injected as
 *      a callback so this module never itself holds a model client or a key;
 *      lane-a.ts wires the real call. Its OWN failure (timeout, bad key,
 *      malformed output) must never be mistaken for a refusal or a retryable
 *      provider error -- it is swallowed here and treated as "not a refusal",
 *      so a classifier outage never re-enters or redirects the fallback loop.
 */

export interface LaneATextRefusalResult {
  isRefusal: boolean;
  /** Which pattern matched (`pattern:<id>`), or `classifier` when the classifier pass caught it. Null when not a refusal. */
  rule: string | null;
}

export interface DetectTextRefusalOptions {
  /** Run the classifier pass when the pattern pass finds nothing. Default false. */
  useClassifier?: boolean;
  /**
   * Test seam / real wiring: a cheap classification call that returns true
   * when `text` is a refusal. Required when `useClassifier` is true; a
   * `useClassifier: true` with no `classify` given is treated as "classifier
   * unavailable" (no pass run), not an error.
   */
  classify?: (text: string) => Promise<boolean>;
}

/**
 * Curated refusal-opener patterns, checked against the first 300 characters
 * of the (trimmed) reply. Anchored to the OPENING of the text on purpose: a
 * refusal is how a model STARTS its answer, and anchoring avoids false
 * positives on a reply that merely mentions "I can't" in passing later on
 * (e.g. quoting the person's own message back).
 */
const LANE_A_REFUSAL_OPENERS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "sorry_cant", pattern: /^(i'?m\s+)?sorry,?\s+(but\s+)?i\s+(can'?t|cannot|can not)\b/i },
  { id: "cannot_assist", pattern: /^i\s+(can'?t|cannot|can not|won'?t|will not)\s+(help|assist)\b/i },
  { id: "cannot_provide", pattern: /^i\s+(can'?t|cannot|can not|won'?t|will not)\s+(provide|generate|create|write|give you|do that)\b/i },
  { id: "not_able", pattern: /^i'?m\s+(not able|unable)\s+to\b/i },
  { id: "must_decline", pattern: /^i\s+(must|have to|need to)\s+(decline|refuse)\b/i },
  { id: "as_an_ai", pattern: /^as\s+an\s+ai\b.{0,60}\b(can'?t|cannot|can not|unable|not allowed|not able)\b/i },
  { id: "against_policy", pattern: /^(that|this)\s+(goes against|violates|is against)\s+(my|the)\s+(guidelines|policy|policies)\b/i },
  { id: "not_appropriate", pattern: /^i\s+(don'?t|do not)\s+think\s+(i\s+)?(can|should)\s+(help|assist|provide)\b/i },
];

/** The leading slice of text the pattern pass checks against; a refusal opens here or not at all. */
const LANE_A_REFUSAL_OPENER_WINDOW = 300;

/**
 * The pattern-only half of detection — synchronous, free, always safe to
 * call. Exported separately so a caller that never wants the classifier pass
 * (or is choosing whether to even ask for it) does not need to await
 * anything.
 */
export function detectTextRefusalByPattern(text: string): LaneATextRefusalResult {
  const opening = text.trim().slice(0, LANE_A_REFUSAL_OPENER_WINDOW);
  for (const { id, pattern } of LANE_A_REFUSAL_OPENERS) {
    if (pattern.test(opening)) {
      return { isRefusal: true, rule: `pattern:${id}` };
    }
  }
  return { isRefusal: false, rule: null };
}

/**
 * Full detection: the pattern pass, then (only when asked for, and only when
 * the pattern pass found nothing) the classifier pass. A classifier failure
 * of any kind is swallowed and reported as "not a refusal" -- it is a
 * same-text re-check, never a model call the fallback loop itself depends on,
 * so there is nothing to retry and nowhere for the failure to usefully go.
 */
export async function detectTextRefusal(text: string, options: DetectTextRefusalOptions = {}): Promise<LaneATextRefusalResult> {
  const byPattern = detectTextRefusalByPattern(text);
  if (byPattern.isRefusal) return byPattern;
  if (!options.useClassifier || !options.classify) return { isRefusal: false, rule: null };
  try {
    const isRefusal = await options.classify(text);
    return isRefusal ? { isRefusal: true, rule: "classifier" } : { isRefusal: false, rule: null };
  } catch {
    return { isRefusal: false, rule: null };
  }
}
