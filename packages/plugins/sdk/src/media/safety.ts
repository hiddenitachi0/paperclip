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

/** "sfw": strictest. "mature": an owner or admin allowed mature content; the always-refused list still applies. */
export type ContentMode = "sfw" | "mature";

export type DenyReason =
  | "filter-bypass"
  | "nsfw-flag"
  | "sexual-flag"
  | "anatomy-slider"
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

// A future "filter-bypass-4" is refused too: id or name says filter bypass.
const FILTER_BYPASS = /filter[\s_-]*bypass/i;
// Mystic X, any host family (krea2-mystic-x, h3-mystic-xxx-v5, moss-mystic-x).
const MYSTIC_X = /mystic[\s_-]*x/i;

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
  /** The account's own imported LoRA. These are not in Sogni's public catalog, so the "unreviewed" rule does not apply to them. */
  personal?: boolean;
}

/** The fields of a parsed catalog row the rules look at. */
export function loraPolicyInput(lora: SogniLoraInfo): LoraPolicyInput {
  return { id: lora.id, name: lora.name, category: lora.category, nsfw: lora.needsFilterOff, sexual: lora.sexual, personal: lora.personal };
}

function lc(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Refused in every film on every path, whatever the mode. */
export function isFilterBypassLora(lora: Pick<LoraPolicyInput, "id" | "name" | "category">): boolean {
  const id = lc(lora.id);
  if (FILTER_BYPASS_LORA_IDS.includes(id)) return true;
  return FILTER_BYPASS.test(lora.id) || FILTER_BYPASS.test(lora.name ?? "");
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
  if (mode !== "sfw") return ALLOWED;
  if (lora.nsfw === true) return deny("nsfw-flag", `The LoRA "${label}" is marked not safe for work by Sogni, so it cannot be used in a safe-for-work film.`);
  if (lora.sexual === true) return deny("sexual-flag", `The LoRA "${label}" is marked sexual by Sogni, so it cannot be used in a safe-for-work film.`);
  if (ANATOMY_SLIDER_LORA_IDS.includes(lc(lora.id))) {
    return deny("anatomy-slider", `The LoRA "${label}" changes body anatomy and cannot be used in a safe-for-work film.`);
  }
  if (MYSTIC_X.test(lora.id) || MYSTIC_X.test(lora.name ?? "")) {
    return deny("mystic-x", `The LoRA "${label}" belongs to the Mystic X family and cannot be used in a safe-for-work film.`);
  }
  if (!lora.personal && !REVIEWED_LORA_IDS.has(lora.id)) {
    return deny(
      "unreviewed",
      `The LoRA "${label}" is new in Sogni's catalog and has not been reviewed yet, so it counts as mature. An owner or admin needs to review it first.`,
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
const DARK_BEAST = /^dark[_-]?beast/i;
const ID_UNCENSORED = /(^|[^a-z0-9])uncensored($|[^a-z0-9])/i;
const ID_SPICY = /(^|[^a-z0-9])spicy($|[^a-z0-9])/i;
// 10Eros (ltx23-22b-10eros-...) and its alias ltx23-eros.
const ID_EROS = /(^|[^a-z0-9])(10)?eros($|[^a-z0-9])/i;

/** The content tags that apply to a model, from its id and from Sogni's "spicy"/"mature"/"off-required" tags. */
export function modelContentTags(model: ModelPolicyInput): ContentTag[] {
  const out = new Set<ContentTag>();
  const sogni = new Set((model.tags ?? []).map((t) => t.toLowerCase()));
  if (DARK_BEAST.test(model.id) || sogni.has("off-required")) out.add("off-required");
  if (sogni.has("mature") || ID_EROS.test(model.id)) out.add("mature");
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
