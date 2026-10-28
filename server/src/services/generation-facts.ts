// DUR-4902: what a picture or video request really carried, read back from the
// request body the provider client built (not from the settings that were
// meant to go into it), so a "How was this made?" record cannot disagree with
// what was sent. Only safety, seed, tool and prompt-expansion facts live here;
// the rest of the record comes from the caller (generation-record.ts).

import { GENERATION_SEED_SERVICE_CHOSE, GENERATION_SEED_UNSUPPORTED } from "@paperclipai/shared";

export interface SentRequestFacts {
  /** The service's tool (generate_image, edit_image, animate_photo, ...); null for one-endpoint-per-model services. */
  tool: string | null;
  /** The provider's own safety fields exactly as sent. */
  safety: Record<string, string | number | boolean>;
  /** Sogni's content filter as sent; null when the service has no such flag. */
  contentFilterOn: boolean | null;
  /** "off", "on", "service default" or "not supported by this tool". */
  promptExpansion: string;
  seed: number | string;
  /** The "things to avoid" text as sent; null when none. */
  negativePrompt: string | null;
}

export const PROMPT_EXPANSION_UNSUPPORTED = "not supported by this tool";

const SAFETY_FIELD = /safety|safe_content|nsfw/i;

/** The safety fields of a request body, as sent. Picked by name so a field added to a request later is recorded without touching this file. */
export function safetyFieldsOf(...bodies: Array<Record<string, unknown> | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const body of bodies) {
    if (!body) continue;
    for (const [key, value] of Object.entries(body)) {
      if (SAFETY_FIELD.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) out[key] = value;
    }
  }
  return out;
}

/** A tool with a seed setting: the seed sent, or that the service chose. */
export function seedSent(value: unknown): number | string {
  return typeof value === "number" ? value : GENERATION_SEED_SERVICE_CHOSE;
}

export const SEED_UNSUPPORTED = GENERATION_SEED_UNSUPPORTED;
