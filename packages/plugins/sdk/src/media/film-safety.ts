// How the safe-for-work (SFW) rule is carried out on a request: the words
// added to a prompt, the LoRAs kept or dropped, and the safety fields sent to
// Fal. Pure rules, no network, shared by the server (film paths) and the Media
// Studio plugin worker (Create tab, Identities, agent pictures). The deny
// lists themselves live in safety.ts.
//
// Two rules sit above everything here:
//   * nothing works around a provider's own filter, and
//   * the strictest answer wins when a rating is missing or unreadable.

import { evaluateLora, loraPolicyInput, SAFE_FOR_WORK_AVOID, type ContentMode, type DenyReason, type PolicyVerdict } from "./safety.js";
import type { SogniLoraInfo } from "./sogni-loras.js";

// ─── The film's rating ────────────────────────────────────────────────────────

/** A stored or requested rating, read strictly: anything but exactly "mature" is "sfw". */
export function readContentMode(value: unknown): ContentMode {
  return value === "mature" ? "mature" : "sfw";
}

// ─── SFW words ────────────────────────────────────────────────────────────────

/** The positive wording that goes in the prompt of every SFW picture or clip. */
export const SFW_PROMPT_WORDS = "Fully clothed.";

const SFW_MARK = /\bfully clothed\b/i;

/**
 * The prompt with the SFW words added ("Fully clothed." and what to keep out).
 * For requests with no negative-prompt field (Sogni edit_image, H3, Wan 3,
 * Seedance, Sogni video). Adding it twice does nothing.
 */
export function withSfwPromptWords(prompt: string): string {
  if (SFW_MARK.test(prompt) && prompt.includes(SAFE_FOR_WORK_AVOID)) return prompt;
  return `${prompt.trimEnd()}\n\n${SFW_PROMPT_WORDS} Keep out of the picture: ${SAFE_FOR_WORK_AVOID}.`;
}

/** The prompt with only "Fully clothed." added, for requests that have a negative-prompt field to carry the rest. */
export function withSfwPositiveWords(prompt: string): string {
  return SFW_MARK.test(prompt) ? prompt : `${prompt.trimEnd()}\n\n${SFW_PROMPT_WORDS}`;
}

/** The negative prompt with the fixed avoid-list merged in, or null when it would not fit in `max` characters. */
export function withSfwNegativePrompt(existing: string | null | undefined, max: number): string | null {
  const base = (existing ?? "").trim();
  if (base.includes(SAFE_FOR_WORK_AVOID)) return base.length <= max ? base : null;
  const merged = base ? `${base}, ${SAFE_FOR_WORK_AVOID}` : SAFE_FOR_WORK_AVOID;
  return merged.length <= max ? merged : null;
}

// ─── LoRAs ────────────────────────────────────────────────────────────────────

export interface LoraRuleResult<T extends { id: string }> {
  /** The LoRAs that may go with the request, in their original order. */
  kept: T[];
  /** Dropped from the request (SFW only), each with the plain reason. */
  dropped: Array<{ id: string; reason: DenyReason; message: string }>;
  /** Refused outright (filter-bypass LoRAs, in every film). The caller stops the request. */
  refused: Array<{ id: string; reason: DenyReason; message: string }>;
  /** One plain sentence per dropped LoRA, for the note shown with the result. */
  notes: string[];
}

function personalById(id: string): boolean {
  return id.startsWith("personal-");
}

/**
 * Apply the LoRA deny rules for one request. `known` is Sogni's list (null:
 * it could not be read; the rules that go by id and name still apply).
 * Filter-bypass LoRAs are refused in every mode. In SFW, LoRAs Sogni flags
 * (not safe for work, sexual), the anatomy sliders, Mystic X and any LoRA not
 * yet reviewed are dropped, each with a note.
 */
export function applyLoraRules<T extends { id: string }>(loras: readonly T[], mode: ContentMode, known: readonly SogniLoraInfo[] | null): LoraRuleResult<T> {
  const kept: T[] = [];
  const dropped: LoraRuleResult<T>["dropped"] = [];
  const refused: LoraRuleResult<T>["refused"] = [];
  for (const lora of loras) {
    const info = known?.find((l) => l.id === lora.id);
    const verdict: PolicyVerdict = evaluateLora(info ? loraPolicyInput(info) : { id: lora.id, personal: personalById(lora.id) }, mode);
    if (verdict.allowed) {
      kept.push(lora);
    } else if (verdict.alwaysRefused) {
      refused.push({ id: lora.id, reason: verdict.reason!, message: verdict.message! });
    } else {
      dropped.push({ id: lora.id, reason: verdict.reason!, message: verdict.message! });
    }
  }
  return { kept, dropped, refused, notes: dropped.map((d) => `${d.message} It was left out of this picture.`) };
}

/**
 * Whether one of the account's own (personal) LoRAs needs Sogni's content
 * filter off. The per-LoRA flag Sogni gives (ui.nsfw); a LoRA whose flag is
 * not known counts as needing it off (the strictest answer).
 */
export function personalLoraNeedsFilterOff(info: Pick<SogniLoraInfo, "needsFilterOff"> | null | undefined): boolean {
  return info ? info.needsFilterOff === true : true;
}

// ─── Fal ──────────────────────────────────────────────────────────────────────

/** Veo 3.1's safety_tolerance: "1" is the strictest ("4" is Fal's default). */
export const FAL_STRICTEST_SAFETY_TOLERANCE = "1";

// Fal endpoints that have an output check besides the input check, and whose
// defaults leave both checks OFF: the Wan family (fal-ai/wan-i2v-lora,
// fal-ai/wan-flf2v, fal-ai/wan/v2.2-a14b/..., Wan 2.2 text-to-video LoRA).
const FAL_OUTPUT_CHECKER = /^fal-ai\/wan([/\-_.]|$)/i;
const FAL_VEO = /^fal-ai\/veo3(\.|\/|$)/i;

/**
 * The safety fields every Fal request carries. `enable_safety_checker` goes on
 * every request; `enable_output_safety_checker` on the endpoints that have it;
 * Veo gets the strictest `safety_tolerance`. Spread these LAST into the body,
 * so nothing a caller or a look set can turn a check off.
 */
export function falSafetyFields(model: string): Record<string, unknown> {
  const id = model.trim();
  return {
    enable_safety_checker: true,
    ...(FAL_OUTPUT_CHECKER.test(id) ? { enable_output_safety_checker: true } : {}),
    ...(FAL_VEO.test(id) ? { safety_tolerance: FAL_STRICTEST_SAFETY_TOLERANCE } : {}),
  };
}

/**
 * Whether Fal's own safety check flagged a result. `has_nsfw_concepts` is a
 * list with one flag per picture (true: the picture came back black), or a
 * single flag. A flagged result is a failure: never approved, never chained,
 * never retried with the check off.
 */
export function falResultFlagged(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const flag = (result as Record<string, unknown>).has_nsfw_concepts;
  if (flag === true) return true;
  return Array.isArray(flag) && flag.some((x) => x === true);
}

export const FAL_FLAGGED_MESSAGE = "Fal's own safety check flagged this picture, so it was thrown away. Describe it more gently and try again.";

/** What a flagged Fal result used, so the caller can still record what Fal bills for it. */
export interface FalFlaggedUsage {
  images: number;
  /** Total size of the flagged pictures, when Fal reported it (per-megapixel pricing). */
  megapixels?: number;
}

/**
 * A Fal result its own safety check flagged. The picture is thrown away (never
 * stored, approved or chained), but Fal still bills the request: whoever
 * catches this MUST record `usage` as a cost before refusing, never release
 * the money it held (DUR-4898, security review F1).
 */
export class FalFlaggedError extends Error {
  readonly falFlagged = true as const;
  constructor(
    readonly model: string,
    readonly usage: FalFlaggedUsage,
    message: string = FAL_FLAGGED_MESSAGE,
  ) {
    super(message);
    this.name = "FalFlaggedError";
  }
}

/** Whether an error is a flagged Fal result. By shape as well as class, so a second copy of this module still matches. */
export function isFalFlaggedError(err: unknown): err is FalFlaggedError {
  if (err instanceof FalFlaggedError) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as { falFlagged?: unknown; model?: unknown; usage?: unknown };
  return e.falFlagged === true && typeof e.model === "string" && !!e.usage && typeof e.usage === "object";
}

/** The usage of a flagged picture result: how many pictures, and their size when Fal said. */
export function falFlaggedUsage(result: unknown): FalFlaggedUsage {
  const images = (result as { images?: unknown } | null)?.images;
  const list = Array.isArray(images) ? (images as Array<{ width?: unknown; height?: unknown }>) : [];
  const count = Math.max(1, list.length);
  let megapixels = 0;
  let sized = list.length > 0;
  for (const image of list) {
    if (typeof image?.width === "number" && typeof image?.height === "number") megapixels += (image.width * image.height) / 1_000_000;
    else sized = false;
  }
  return { images: count, ...(sized && megapixels > 0 ? { megapixels } : {}) };
}
