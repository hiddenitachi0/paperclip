// What may be made in a safe-for-work (SFW) film and what may not be made at
// all. Pure rules over ids, names, categories and Sogni's own flags: nothing
// here reads the network or the database. Strictest defaults apply until the
// owner decides otherwise (Media Studio film studio plan, Phase 0).
//
// The rules are matched by id and category, not by Sogni's flags alone: the
// 24 Oct 2026 catalog leaves the filter-bypass LoRAs and the anatomy sliders
// unflagged (ui.nsfw and ui.sexual both false).

import type { SogniLoraInfo } from "./sogni-loras.js";

/**
 * DUR-4133/DUR-4138: the fixed "things to avoid" text merged onto a picture
 * made with `safeForWork: true` — used for pictures nobody reviews before
 * they go out (the morning report's illustrations). DUR-4138: this text
 * (plus "fully clothed" in the prompt) is the *only* safety net `safeForWork`
 * adds now — it no longer touches the provider's own content-filter switch.
 */
export const SAFE_FOR_WORK_AVOID = "nudity, nsfw, text, letters, words, watermark, logo";

/** "sfw": strictest. "mature": the owner allowed mature content; the always-refused list still applies. */
export type ContentMode = "sfw" | "mature";

export type DenyReason =
  | "filter-bypass"
  | "nsfw-flag"
  | "sexual-flag"
  | "anatomy-slider"
  | "age-slider"
  | "mystic-x"
  | "mature-model"
  | "unreviewed";

export interface PolicyVerdict {
  allowed: boolean;
  reason: DenyReason | null;
  /** True when the item is refused in every mode (not just SFW). */
  alwaysRefused: boolean;
  /** One plain sentence for the owner. Null when allowed. */
  message: string | null;
}

const ALLOWED: PolicyVerdict = { allowed: true, reason: null, alwaysRefused: false, message: null };

function deny(reason: DenyReason, message: string, alwaysRefused = false): PolicyVerdict {
  return { allowed: false, reason, alwaysRefused, message };
}

// ─── LoRAs ────────────────────────────────────────────────────────────────────

/** Filter-bypass LoRAs (category prompt-control). Refused in every film on every path. */
export const FILTER_BYPASS_LORA_IDS: readonly string[] = ["krea2-filter-bypass-2", "krea2-filter-bypass-3"];
/** Anatomy sliders that Sogni leaves unflagged. Refused in SFW. */
export const ANATOMY_SLIDER_LORA_IDS: readonly string[] = ["krea2-breast", "krea2-chest-firmness", "krea2-nipple-projection"];

/**
 * LoRAs that were SFW-refused in the 24 Oct 2026 snapshot only because Sogni
 * flagged them (ui.nsfw / ui.sexual). Recorded by id so the refusal still holds
 * when a caller has only the pick (no catalog row) or Sogni drops the flag.
 */
export const FLAGGED_LORA_IDS: readonly string[] = ["krea2-aberrant", "krea2-realism-engine", "h3-vbvr-video-reasoning"];

/** Age sliders ("Younger" <-> "Older"). Refused in every film: with an adult's likeness LoRA they can make a person look under-age. */
export const AGE_SLIDER_LORA_IDS: readonly string[] = ["krea2-age"];

// A future "filter-bypass-4" is refused too: id or name says filter bypass, in
// either word order, with any run of whitespace, punctuation or dash-like
// characters between the words. Matched on normalised text (see foldForMatch).
const SEP = "[\\s._\\-\\u2010-\\u2015\\u2212]*";
const FILTER_BYPASS = new RegExp(
  `filter${SEP}by${SEP}pass|by${SEP}pass${SEP}(the${SEP})?filter|(^|[^a-z])(un|no)${SEP}filter|filter${SEP}(off|disabl|remov|break|evad)|jailbreak`,
  "i",
);
// Age sliders by name, for a LoRA the snapshot has not seen. Whole words only.
const AGE_WORDS = /(^|[^a-z])(age|aging|younger|older|young|youth|youthful|child|childlike|teen|teenager|loli|lolita|shota|underage)($|[^a-z])/i;
// Mystic X, any host family (krea2-mystic-x, h3-mystic-xxx-v5, moss-mystic-x).
const MYSTIC_X = /mystic[\s._-]*x/i;

// Look-alike letters used to slip past a name match (Cyrillic/Greek, digits for letters).
const LOOKALIKES: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0455": "s",
  "\u03b1": "a", "\u03bf": "o", "\u03b9": "i", "\u03c1": "p", "\u03c5": "u", "\u03bd": "v",
};
const LEET: Readonly<Record<string, string>> = { "4": "a", "@": "a", "3": "e", "1": "i", "0": "o", "5": "s", "$": "s" };

/**
 * Text as the name rules should see it: NFKC-normalised, zero-width and other
 * invisible characters removed, look-alike letters folded to ASCII. With
 * `leet`, digits that stand in for letters (byp4ss) are folded too. Only used
 * to match refusal rules, so folding too much only refuses more.
 */
export function foldForMatch(value: string | null | undefined, leet = false): string {
  const text = (value ?? "")
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .toLowerCase();
  let out = "";
  for (const ch of text) out += LOOKALIKES[ch] ?? (leet ? (LEET[ch] ?? ch) : ch);
  return out;
}

/**
 * The LoRAs treated as reviewed: every public id in Sogni's catalog
 * of 24 Oct 2026 (51 LoRAs, GET /v1/loras/comfy lastUpdated 1792813614206).
 * Being listed does not make a LoRA SFW: the deny rules above and Sogni's
 * flags still apply to listed ids. Any other catalog id counts as mature until
 * it is reviewed and added here.
 */
export const REVIEWED_LORA_SNAPSHOT_DATE = "2026-10-24";
export const REVIEWED_LORA_IDS: ReadonlySet<string> = new Set([
  "krea2-detail-enhancer",
  "krea2-scene-complexity",
  "krea2-realism",
  "krea2-afterlight",
  "krea2-warm-light",
  "krea2-amateur",
  "krea2-breast",
  "krea2-chest-firmness",
  "krea2-nipple-projection",
  "krea2-height",
  "krea2-weight",
  "krea2-skin-tone",
  "krea2-wetness",
  "krea2-age",
  "krea2-skin-detail",
  "krea2-candid",
  "krea2-zoom",
  "krea2-aberrant",
  "krea2-mystic-x",
  "krea2-filter-bypass-2",
  "krea2-filter-bypass-3",
  "krea2-realism-engine",
  "krea2-hourglass-figure",
  "krea2-bloomgirls",
  "krea2-purple-grainy",
  "krea2-retro-vintage-photo",
  "krea2-fever-dream-mood",
  "krea2-kodachrome-photo",
  "krea2-lenovo-ultrareal",
  "krea2-grainscape-ultrareal",
  "krea2-canon-ultrareal",
  "h3-realism-people",
  "h3-combat-base-v2",
  "h3-vbvr-video-reasoning",
  "h3-mystic-xxx-v4",
  "h3-action-speed-slider",
  "h3-mystic-xxx-v5",
  "h3-vh5tape-vhs",
  "h3-natural-face-speech",
  "h3-better-motion",
  "moss-lenovo-ultrareal",
  "moss-grainscape-ultrareal",
  "moss-nicegirls-ultrareal",
  "moss-detail-tweaker",
  "moss-canon-ultrareal",
  "moss-mystic-x",
  "moss-2000s-analog-core",
  "moss-retro-vintage-photo",
  "moss-fever-dream-mood",
  "moss-kodachrome-photo",
  "moss-max-ultra-hires",
]);

export interface LoraPolicyInput {
  id: string;
  name?: string | null;
  category?: string | null;
  /** Sogni ui.nsfw (SogniLoraInfo.needsFilterOff). */
  nsfw?: boolean;
  /** Sogni ui.sexual. */
  sexual?: boolean;
  /**
   * The account's own imported LoRA. These are not in Sogni's public catalog, so
   * the "unreviewed" rule does not apply to them. Honoured only when the id
   * also starts with "personal-" (Sogni's id for imported LoRAs), so a caller
   * cannot exempt a public catalog LoRA by setting the flag.
   */
  personal?: boolean;
}

/** The fields of a parsed catalog row the rules look at. */
export function loraPolicyInput(lora: SogniLoraInfo): LoraPolicyInput {
  return { id: lora.id, name: lora.name, category: lora.category, nsfw: lora.needsFilterOff, sexual: lora.sexual, personal: lora.personal };
}

function lc(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Refused in every film on every path, whatever the mode: the two known bypass
 * ids, anything whose id or name says filter bypass, and any prompt-control
 * LoRA that is not in the reviewed snapshot (the snapshot's only prompt-control
 * LoRAs are the two bypass ids above).
 */
export function isFilterBypassLora(lora: Pick<LoraPolicyInput, "id" | "name" | "category">): boolean {
  const id = lc(lora.id);
  if (FILTER_BYPASS_LORA_IDS.includes(id)) return true;
  if (lc(lora.category) === "prompt-control" && !REVIEWED_LORA_IDS.has(lora.id)) return true;
  for (const leet of [false, true]) {
    if (FILTER_BYPASS.test(foldForMatch(lora.id, leet)) || FILTER_BYPASS.test(foldForMatch(lora.name, leet))) return true;
  }
  return false;
}

/** Refused in every film: the age slider, and any LoRA whose id or name says it changes age. */
export function isAgeSliderLora(lora: Pick<LoraPolicyInput, "id" | "name">): boolean {
  if (AGE_SLIDER_LORA_IDS.includes(lc(lora.id))) return true;
  return AGE_WORDS.test(foldForMatch(lora.id)) || AGE_WORDS.test(foldForMatch(lora.name));
}

/**
 * Whether a LoRA may be used. Order matters: the always-refused rule comes
 * first so its message is the one the owner sees.
 */
export function evaluateLora(lora: LoraPolicyInput, mode: ContentMode): PolicyVerdict {
  const label = lora.name?.trim() || lora.id;
  if (isFilterBypassLora(lora)) {
    return deny("filter-bypass", `The LoRA "${label}" switches off Sogni's safety filter and is never allowed.`, true);
  }
  if (isAgeSliderLora(lora)) {
    return deny("age-slider", `The LoRA "${label}" changes how old a person looks and is not allowed, because it could make a person look under-age.`, true);
  }
  if (mode !== "sfw") return ALLOWED;
  if (lora.nsfw === true) return deny("nsfw-flag", `The LoRA "${label}" is marked not safe for work by Sogni, so it cannot be used in a safe-for-work film.`);
  if (lora.sexual === true) return deny("sexual-flag", `The LoRA "${label}" is marked sexual by Sogni, so it cannot be used in a safe-for-work film.`);
  if (FLAGGED_LORA_IDS.includes(lc(lora.id))) {
    return deny("nsfw-flag", `The LoRA "${label}" was marked not safe for work when it was reviewed, so it cannot be used in a safe-for-work film.`);
  }
  if (ANATOMY_SLIDER_LORA_IDS.includes(lc(lora.id))) {
    return deny("anatomy-slider", `The LoRA "${label}" changes body anatomy and cannot be used in a safe-for-work film.`);
  }
  if (MYSTIC_X.test(foldForMatch(lora.id)) || MYSTIC_X.test(foldForMatch(lora.name))) {
    return deny("mystic-x", `The LoRA "${label}" belongs to the Mystic X family and cannot be used in a safe-for-work film.`);
  }
  const own = lora.personal === true && lc(lora.id).startsWith("personal-");
  if (!own && !REVIEWED_LORA_IDS.has(lora.id)) {
    return deny(
      "unreviewed",
      `The LoRA "${label}" is new in Sogni's catalog and has not been reviewed yet, so it counts as mature. New LoRAs are added to the reviewed list in a release; a review register comes later.`,
    );
  }
  return ALLOWED;
}

// ─── Models ───────────────────────────────────────────────────────────────────

/** Our own content tags for a model. A model with any of them is refused in SFW. */
export type ContentTag = "off-required" | "mature" | "uncensored" | "spicy";

export interface ModelPolicyInput {
  /** Catalog model id (or alias such as ltx23-eros). */
  id: string;
  /** Sogni's tags for the model, when known. */
  tags?: readonly string[];
}

// By id because Sogni leaves some of these untagged (wan3.0-spicy-video,
// seedream-5-0-pro-uncensored). Sogni's own "uncensored" tag is NOT used on its
// own: it sits on most models, including the default Z-Image Turbo.
const DARK_BEAST = /dark[\s_-]*beast/i;
const ID_UNCENSORED = /uncensored/i;
const ID_SPICY = /spicy/i;
const ID_NSFW = /nsfw/i;
// 10Eros (ltx23-22b-10eros-...) and its alias ltx23-eros.
// A digit may come right before it (ltx23Eros), a letter may not (zeros).
const ID_EROS = /(^|[^a-z])(10)?eros($|[^a-z])/i;

/** The content tags that apply to a model, from its id and from Sogni's "spicy"/"mature"/"off-required" tags. */
export function modelContentTags(model: ModelPolicyInput): ContentTag[] {
  const out = new Set<ContentTag>();
  const sogni = new Set((model.tags ?? []).map((t) => t.trim().toLowerCase()));
  if (DARK_BEAST.test(model.id) || sogni.has("off-required")) out.add("off-required");
  if (sogni.has("mature") || ID_EROS.test(model.id) || ID_NSFW.test(model.id)) out.add("mature");
  if (sogni.has("spicy") || ID_SPICY.test(model.id)) out.add("spicy");
  if (ID_UNCENSORED.test(model.id)) out.add("uncensored");
  if (ID_EROS.test(model.id)) out.add("spicy");
  return [...out];
}

/** Whether a model may be used. Models have no always-refused list; the mode only matters for SFW. */
export function evaluateModel(model: ModelPolicyInput, mode: ContentMode): PolicyVerdict {
  if (mode !== "sfw") return ALLOWED;
  const tags = modelContentTags(model);
  if (tags.length === 0) return ALLOWED;
  return deny("mature-model", `The model "${model.id}" is made for mature pictures (${tags.join(", ")}) and cannot be used in a safe-for-work film.`);
}
