/**
 * DUR-4072 PR2: the number check on report commentary, reusing
 * business-data-number-check.ts's pattern (DUR-3972 S4) -- the ticket asks
 * for exactly this: "the agent never calculates; reuse
 * business-data-number-check.ts so every number in the text must come from
 * the script output".
 *
 * Unlike the business-data check, the allowed set here is a script's JSON
 * output rather than a fixed-text answer card, so there is no footer and no
 * "no data" marker to special-case: `findUngroundedNumbers` is handed the
 * output serialised to text, which is enough for `extractQuantities` to pick
 * every number out of it (object keys and punctuation never match the
 * number patterns).
 */
import { findUngroundedNumbers } from "./business-data-number-check.js";

export interface ReportNumberCheckResult {
  ungrounded: string[];
  ok: boolean;
}

/** Every number in `commentaryText` that is not present anywhere in `numbers`'s JSON. */
export function checkReportCommentaryNumbers(commentaryText: string, numbers: unknown): ReportNumberCheckResult {
  const serialised = safeStringify(numbers);
  const ungrounded = findUngroundedNumbers(commentaryText, [serialised]);
  return { ungrounded, ok: ungrounded.length === 0 };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
