import { z } from "zod";

/**
 * Media Studio film studio, Phase 1: the LoRA library, saved model setups and
 * the setup register (scores per setup).
 *
 * A MODEL SETUP is a named recipe a person picks by name: service + exact
 * model id + LoRAs from the company's LoRA library, each with an explicit
 * strength, plus a few params (prompt expansion is always set explicitly).
 * Example: "Action" = MiniMax H3 on Sogni + Better Motion at 0.8.
 *
 * Everything here is pure: the server checks a setup against the capability
 * table below and the company's own LoRA rows, and refuses with a plain
 * sentence. Rules that matter most:
 *   - Wan 3 takes no LoRA on any service.
 *   - On Sogni only MiniMax H3 (video) and Krea 2 / MOSS (pictures) take LoRAs.
 *   - Strengths are native multipliers (Sogni recommends 0.4-0.8, default
 *     0.6), never percentages, and always explicit: Sogni runs a LoRA at 1.0
 *     when the strength is left out.
 *   - Filter-bypass LoRAs are refused everywhere; a mature or not yet reviewed
 *     part raises the setup's content rating to mature.
 *   - A video setup may only use Fal or Sogni (the storyline CHECKs).
 *
 * The content rules mirror the deny rules of the Media Studio safety module
 * (plugin-sdk/media) for the parts a setup is made of. When that module is on
 * custom, the server should take them from there; until then the lists below
 * are the source for setups.
 */

// ─── Values ──────────────────────────────────────────────────────────────────

export const MEDIA_SETUP_KINDS = ["image", "video"] as const;
export type MediaSetupKind = (typeof MEDIA_SETUP_KINDS)[number];

export const MEDIA_SETUP_PROVIDERS = ["sogni", "fal", "higgsfield", "comfyui"] as const;
export type MediaSetupProvider = (typeof MEDIA_SETUP_PROVIDERS)[number];
/** video_storylines and video_shot_render_jobs allow only these two. */
export const MEDIA_VIDEO_SETUP_PROVIDERS = ["sogni", "fal"] as const;

export const MEDIA_LORA_PROVIDERS = ["sogni", "fal"] as const;
export type MediaLoraProvider = (typeof MEDIA_LORA_PROVIDERS)[number];
export const MEDIA_LORA_SOURCES = ["catalog", "personal", "url"] as const;
export type MediaLoraSource = (typeof MEDIA_LORA_SOURCES)[number];

/** unreviewed counts as mature until an owner or admin reviews it. */
export const MEDIA_CONTENT_TAGS = ["sfw", "mature", "refused", "unreviewed"] as const;
export type MediaContentTag = (typeof MEDIA_CONTENT_TAGS)[number];
export const MEDIA_CONTENT_RATINGS = ["sfw", "mature"] as const;
export type MediaContentRating = (typeof MEDIA_CONTENT_RATINGS)[number];

export const MEDIA_SETUP_STATUSES = ["draft", "approved", "archived"] as const;
export type MediaSetupStatus = (typeof MEDIA_SETUP_STATUSES)[number];

export const MEDIA_SETUP_MODES = ["t2i", "edit", "t2v", "i2v", "flf2v", "r2v", "extend"] as const;
export type MediaSetupMode = (typeof MEDIA_SETUP_MODES)[number];

export const MEDIA_CONTINUITY_MODES = ["stills", "keyframes"] as const;
export type MediaContinuityMode = (typeof MEDIA_CONTINUITY_MODES)[number];

/** The register's 1-5 scores (D12). SFW/NSFW tendency and cost are computed, never typed in. */
export const MEDIA_SETUP_SCORE_ATTRIBUTES = ["naturalness", "movement", "faceContinuity", "outfitStability", "promptFollowing"] as const;
export type MediaSetupScoreAttribute = (typeof MEDIA_SETUP_SCORE_ATTRIBUTES)[number];
export const MEDIA_SETUP_SCORE_LABELS: Record<MediaSetupScoreAttribute, string> = {
  naturalness: "Naturalness",
  movement: "Movement",
  faceContinuity: "Face continuity",
  outfitStability: "Outfit stability",
  promptFollowing: "Follows the prompt",
};
export const MEDIA_TRIAL_RATER_KINDS = ["human", "ai"] as const;
export type MediaTrialRaterKind = (typeof MEDIA_TRIAL_RATER_KINDS)[number];

export const MEDIA_LORA_DEFAULT_STRENGTH = 0.6;
/** Sogni takes at most 8 LoRAs on one request; no setup needs more. */
export const MEDIA_SETUP_MAX_LORAS = 8;
export const MEDIA_SETUP_MAX_PER_COMPANY = 200;
export const MEDIA_LORA_MAX_PER_COMPANY = 500;
export const MEDIA_SETUP_NAME_MAX_LENGTH = 80;
export const MEDIA_SETUP_TEXT_MAX_LENGTH = 2_000;
export const MEDIA_MODEL_ID_MAX_LENGTH = 200;
export const MEDIA_LORA_REF_MAX_LENGTH = 2_000;
/** A share of flagged trials at or above this makes a setup "leans mature". */
export const MEDIA_SETUP_LEANS_MATURE_SHARE = 0.25;

// ─── Billing ─────────────────────────────────────────────────────────────────

export const MEDIA_BILLING_COVERAGES = ["sogni-unlimited", "sogni-premium", "sogni-credits", "fal-pay-per-use", "higgsfield-credits", "local", "unknown"] as const;
export type MediaBillingCoverage = (typeof MEDIA_BILLING_COVERAGES)[number];
export const MEDIA_BILLING_LABELS: Record<MediaBillingCoverage, string> = {
  "sogni-unlimited": "Covered by the Sogni Unlimited plan",
  "sogni-premium": "Paid with Sogni premium Spark (not covered by Unlimited)",
  "sogni-credits": "Paid with Sogni credits (check what your plan covers)",
  "fal-pay-per-use": "Paid per use on Fal",
  "higgsfield-credits": "Paid with Higgsfield credits",
  local: "Runs on your own ComfyUI server",
  unknown: "Cost not known yet",
};

// ─── Capability table ────────────────────────────────────────────────────────

export interface MediaModelCapability {
  provider: MediaSetupProvider;
  /** Model family, e.g. "h3", "wan3", "krea2"; null when the model is not in the table. */
  family: string | null;
  label: string;
  /** Empty = not known (any kind accepted). */
  kinds: MediaSetupKind[];
  /** The mode an exact id stands for, when the id says it (Sogni H3 ids do). */
  mode: MediaSetupMode | null;
  takesLoras: boolean;
  maxLoras: number;
  /** The family of LoRAs that fit, when LoRAs are matched by family. */
  loraFamily: string | null;
  /** The plain sentence shown when LoRAs are picked for a model that takes none. */
  noLoraReason: string | null;
  /** Our own mature tags for the model (off-required, mature, uncensored, spicy). */
  matureTags: string[];
  billing: MediaBillingCoverage;
  /** True when the model is in the table; an unknown model is allowed but takes no LoRA. */
  known: boolean;
}

const WAN3_NO_LORA =
  "Wan 3 takes no LoRA on any service (Sogni, Fal or Higgsfield). Remove the LoRAs, or pick a model that takes them, such as MiniMax H3 on Sogni.";
const SOGNI_NO_LORA = "On Sogni only MiniMax H3 (video) and Krea 2 or MOSS (pictures) take LoRAs. Remove the LoRAs or pick one of those models.";
const FAL_NO_LORA = "This Fal model takes no LoRA. Fal models that take LoRAs end in /lora (or are fal-ai/wan-flf2v). Remove the LoRAs or pick one of those.";
const HIGGSFIELD_NO_LORA = "Higgsfield takes no LoRAs; it keeps a person with a trained Soul ID instead. Remove the LoRAs.";
const COMFYUI_NO_LORA = "LoRAs on a ComfyUI server cannot be saved in a setup yet. Remove the LoRAs.";

const DARK_BEAST = /dark[_-]?beast/i;
const ID_UNCENSORED = /(^|[^a-z0-9])uncensored($|[^a-z0-9])/i;
const ID_SPICY = /(^|[^a-z0-9])spicy($|[^a-z0-9])/i;
const ID_EROS = /(^|[^a-z0-9])(10)?eros($|[^a-z0-9])/i;

/** Our own mature tags for a model id (the same id rules as the Media Studio safety module). */
export function mediaModelMatureTags(modelId: string): string[] {
  const out = new Set<string>();
  if (DARK_BEAST.test(modelId)) out.add("off-required");
  if (ID_EROS.test(modelId)) {
    out.add("mature");
    out.add("spicy");
  }
  if (ID_SPICY.test(modelId)) out.add("spicy");
  if (ID_UNCENSORED.test(modelId)) out.add("uncensored");
  return [...out];
}

function h3Mode(id: string): MediaSetupMode | null {
  if (id.includes("flf2v") || id.includes("flfa2v")) return "flf2v";
  if (id.includes("r2v")) return "r2v";
  if (id.includes("i2v") || id.includes("ia2v")) return "i2v";
  if (id.includes("t2v") || id.includes("a2v")) return "t2v";
  return null;
}

function capability(
  provider: MediaSetupProvider,
  partial: Partial<MediaModelCapability> & Pick<MediaModelCapability, "label" | "billing">,
  modelId: string,
): MediaModelCapability {
  return {
    provider,
    family: null,
    kinds: [],
    mode: null,
    takesLoras: false,
    maxLoras: 0,
    loraFamily: null,
    noLoraReason: null,
    known: true,
    ...partial,
    matureTags: mediaModelMatureTags(modelId),
  };
}

function isWan3(id: string): boolean {
  return /(^|[^a-z0-9])wan[-_ ]?v?3(\.0)?([^0-9.]|$)/.test(id) || id.startsWith("wan3");
}

/**
 * What one exact model id can do, for setups. Facts as researched on 27 Oct
 * 2026 (Sogni LoRA catalog of 24 Oct; saved Fal OpenAPI schemas).
 */
export function mediaModelCapability(provider: MediaSetupProvider, modelId: string): MediaModelCapability {
  const id = modelId.trim().toLowerCase();
  if (provider === "higgsfield") {
    return capability(provider, { family: "soul", label: "Higgsfield", kinds: ["image"], noLoraReason: HIGGSFIELD_NO_LORA, billing: "higgsfield-credits" }, id);
  }
  if (provider === "comfyui") {
    return capability(provider, { label: "ComfyUI", noLoraReason: COMFYUI_NO_LORA, billing: "local", known: false }, id);
  }
  if (isWan3(id)) {
    return capability(
      provider,
      { family: "wan3", label: "Wan 3", kinds: ["video"], noLoraReason: WAN3_NO_LORA, billing: provider === "sogni" ? "sogni-premium" : "fal-pay-per-use" },
      id,
    );
  }
  if (provider === "sogni") {
    if (id.startsWith("minimax-h3")) {
      return capability(
        provider,
        { family: "h3", label: "MiniMax H3", kinds: ["video"], mode: h3Mode(id), takesLoras: true, maxLoras: MEDIA_SETUP_MAX_LORAS, loraFamily: "h3", billing: "sogni-unlimited" },
        id,
      );
    }
    if (id.includes("krea2")) {
      return capability(
        provider,
        {
          family: "krea2",
          label: "Krea 2",
          kinds: ["image"],
          mode: id.includes("identity_edit") ? "edit" : "t2i",
          takesLoras: true,
          maxLoras: MEDIA_SETUP_MAX_LORAS,
          loraFamily: "krea2",
          billing: "sogni-credits",
        },
        id,
      );
    }
    if (id.startsWith("moss")) {
      return capability(
        provider,
        { family: "moss", label: "MOSS", kinds: ["image"], mode: "t2i", takesLoras: true, maxLoras: MEDIA_SETUP_MAX_LORAS, loraFamily: "moss", billing: "sogni-credits" },
        id,
      );
    }
    if (/^ltx/.test(id) || ID_EROS.test(id)) {
      return capability(provider, { family: "ltx", label: "LTX", kinds: ["video"], noLoraReason: SOGNI_NO_LORA, billing: "sogni-unlimited" }, id);
    }
    if (/^wan_v2\.2|^wan-?2\.?2|^wan22/.test(id)) {
      return capability(provider, { family: "wan22", label: "Wan 2.2", kinds: ["video"], noLoraReason: SOGNI_NO_LORA, billing: "sogni-unlimited" }, id);
    }
    if (id.startsWith("seedance")) {
      return capability(provider, { family: "seedance", label: "Seedance", kinds: ["video"], noLoraReason: SOGNI_NO_LORA, billing: "sogni-premium" }, id);
    }
    if (id.startsWith("happyhorse")) {
      return capability(provider, { family: "happyhorse", label: "HappyHorse", kinds: ["video"], noLoraReason: SOGNI_NO_LORA, billing: "sogni-premium" }, id);
    }
    return capability(provider, { label: "Sogni model", noLoraReason: SOGNI_NO_LORA, billing: "unknown", known: false }, id);
  }
  // Fal: exact endpoint ids.
  if (id.startsWith("minimax/h3-max")) {
    return capability(
      provider,
      {
        family: "h3",
        label: "MiniMax H3 Max",
        kinds: ["video"],
        mode: "flf2v",
        noLoraReason: "This H3 Max endpoint takes a start and an end picture but no LoRA. For LoRAs on Fal use minimax/h3/text-to-video/lora or minimax/h3/reference-to-video/lora.",
        billing: "fal-pay-per-use",
      },
      id,
    );
  }
  const falLora = id.endsWith("/lora") || id.includes("-lora") || id.includes("_lora") || id === "fal-ai/wan-flf2v";
  if (falLora) {
    const video = /video|wan|ltx|h3|kling|veo|seedance|hunyuan|flf2v|i2v|t2v/.test(id);
    const family = id.includes("minimax/h3")
      ? "h3"
      : id.includes("wan-i2v") || id.includes("wan-flf2v")
        ? "wan21"
        : id.includes("v2.2") || id.includes("wan-22")
          ? "wan22"
          : id.includes("ltx")
            ? "ltx2"
            : id.includes("qwen")
              ? "qwen-image"
              : id.includes("z-image")
                ? "z-image"
                : id.includes("flux")
                  ? "flux"
                  : null;
    const mode: MediaSetupMode | null = id.includes("flf2v")
      ? "flf2v"
      : id.includes("reference-to-video")
        ? "r2v"
        : id.includes("image-to-video") || id.includes("i2v")
          ? "i2v"
          : id.includes("text-to-video") || id.includes("t2v")
            ? "t2v"
            : id.includes("edit") || id.includes("kontext")
              ? "edit"
              : video
                ? null
                : "t2i";
    return capability(
      provider,
      { family, label: family ? `Fal ${family}` : "Fal model", kinds: [video ? "video" : "image"], mode, takesLoras: true, maxLoras: MEDIA_SETUP_MAX_LORAS, loraFamily: family, billing: "fal-pay-per-use" },
      id,
    );
  }
  return capability(provider, { label: "Fal model", noLoraReason: FAL_NO_LORA, billing: "fal-pay-per-use", known: false }, id);
}

/** For the capabilities endpoint: the families the table knows, in plain words. */
export interface MediaCapabilityFamily {
  provider: MediaSetupProvider;
  family: string;
  label: string;
  kinds: MediaSetupKind[];
  takesLoras: boolean;
  note: string;
  billing: MediaBillingCoverage;
}

export const MEDIA_CAPABILITY_FAMILIES: readonly MediaCapabilityFamily[] = [
  { provider: "sogni", family: "h3", label: "MiniMax H3", kinds: ["video"], takesLoras: true, note: "Video LoRAs (Better Motion, Natural Face & Speech, ...), allowed per exact model id. About 15 s per clip.", billing: "sogni-unlimited" },
  { provider: "sogni", family: "wan3", label: "Wan 3", kinds: ["video"], takesLoras: false, note: "Start and end picture, up to 30 s in one clip. No LoRA.", billing: "sogni-premium" },
  { provider: "sogni", family: "ltx", label: "LTX", kinds: ["video"], takesLoras: false, note: "No LoRA on Sogni.", billing: "sogni-unlimited" },
  { provider: "sogni", family: "wan22", label: "Wan 2.2", kinds: ["video"], takesLoras: false, note: "No LoRA on Sogni.", billing: "sogni-unlimited" },
  { provider: "sogni", family: "seedance", label: "Seedance", kinds: ["video"], takesLoras: false, note: "No LoRA. First and last frame only as loose references.", billing: "sogni-premium" },
  { provider: "sogni", family: "krea2", label: "Krea 2", kinds: ["image"], takesLoras: true, note: "Picture LoRAs from Sogni's list or your own imported ones, up to 8, order matters.", billing: "sogni-credits" },
  { provider: "sogni", family: "moss", label: "MOSS", kinds: ["image"], takesLoras: true, note: "Picture LoRAs from Sogni's list, up to 8.", billing: "sogni-credits" },
  { provider: "fal", family: "h3", label: "MiniMax H3 (Fal)", kinds: ["video"], takesLoras: true, note: "LoRA links on the /lora endpoints (text-to-video, reference-to-video). H3 Max takes start + end but no LoRA.", billing: "fal-pay-per-use" },
  { provider: "fal", family: "wan21", label: "Wan 2.1 (Fal)", kinds: ["video"], takesLoras: true, note: "wan-flf2v: start + end picture + LoRA links; short clips.", billing: "fal-pay-per-use" },
  { provider: "fal", family: "wan3", label: "Wan 3 (Fal)", kinds: ["video"], takesLoras: false, note: "No LoRA.", billing: "fal-pay-per-use" },
  { provider: "fal", family: "flux", label: "FLUX (Fal)", kinds: ["image"], takesLoras: true, note: "LoRA links on the /lora endpoints.", billing: "fal-pay-per-use" },
  { provider: "higgsfield", family: "soul", label: "Higgsfield Soul", kinds: ["image"], takesLoras: false, note: "Pictures only; keeps a person with a Soul ID, not a LoRA.", billing: "higgsfield-credits" },
];

// ─── Content rules for LoRAs ─────────────────────────────────────────────────

/** Filter-bypass LoRAs: refused in every film, on every path, and never saved. */
export const MEDIA_FILTER_BYPASS_LORA_IDS: readonly string[] = ["krea2-filter-bypass-2", "krea2-filter-bypass-3"];
/** Anatomy sliders Sogni leaves unflagged: never tagged safe for work. */
export const MEDIA_ANATOMY_SLIDER_LORA_IDS: readonly string[] = ["krea2-breast", "krea2-chest-firmness", "krea2-nipple-projection"];
/** Flagged when Sogni's list was reviewed (24 Oct 2026); held by id in case the flag is dropped. */
export const MEDIA_FLAGGED_LORA_IDS: readonly string[] = ["krea2-aberrant", "krea2-realism-engine", "h3-vbvr-video-reasoning"];
const FILTER_BYPASS = /filter[\s._\-‐-―−]*bypass/i;
const MYSTIC_X = /mystic[\s_-]*x/i;

export interface MediaLoraRuleInput {
  ref: string;
  name?: string | null;
  providerNsfw?: boolean;
  providerSexual?: boolean;
}

export function isFilterBypassMediaLora(lora: Pick<MediaLoraRuleInput, "ref" | "name">): boolean {
  const ref = lora.ref.trim().toLowerCase();
  if (MEDIA_FILTER_BYPASS_LORA_IDS.includes(ref)) return true;
  return FILTER_BYPASS.test(lora.ref) || FILTER_BYPASS.test(lora.name ?? "");
}

/**
 * The lowest content tag a LoRA may carry, from the rules: "refused" for a
 * filter-bypass LoRA, "mature" when the provider flags it or it is an anatomy
 * slider, a flagged id or a Mystic X LoRA; null when a person decides.
 */
export function mediaLoraContentFloor(lora: MediaLoraRuleInput): { tag: "refused" | "mature"; reason: string } | null {
  const label = lora.name?.trim() || lora.ref;
  if (isFilterBypassMediaLora(lora)) return { tag: "refused", reason: `The LoRA "${label}" switches off the provider's safety filter and is never allowed.` };
  const ref = lora.ref.trim().toLowerCase();
  if (lora.providerNsfw) return { tag: "mature", reason: `The LoRA "${label}" is marked not safe for work by its provider.` };
  if (lora.providerSexual) return { tag: "mature", reason: `The LoRA "${label}" is marked sexual by its provider.` };
  if (MEDIA_FLAGGED_LORA_IDS.includes(ref)) return { tag: "mature", reason: `The LoRA "${label}" was marked not safe for work when Sogni's list was reviewed.` };
  if (MEDIA_ANATOMY_SLIDER_LORA_IDS.includes(ref)) return { tag: "mature", reason: `The LoRA "${label}" changes body anatomy.` };
  if (MYSTIC_X.test(lora.ref) || MYSTIC_X.test(lora.name ?? "")) return { tag: "mature", reason: `The LoRA "${label}" belongs to the Mystic X family.` };
  return null;
}

/** The tag that counts: the stored tag, raised to the rule floor. */
export function effectiveMediaLoraContentTag(lora: MediaLoraRuleInput & { contentTag: MediaContentTag }): MediaContentTag {
  const floor = mediaLoraContentFloor(lora);
  if (floor?.tag === "refused" || lora.contentTag === "refused") return "refused";
  if (floor?.tag === "mature" && lora.contentTag !== "mature") return "mature";
  return lora.contentTag;
}

/** Strength bounds for a LoRA: its own scale when known, else the provider's usual one. */
export function mediaLoraStrengthBounds(lora: {
  provider: MediaLoraProvider;
  source: MediaLoraSource;
  strengthMin: number | null;
  strengthMax: number | null;
}): { min: number; max: number; minExclusive: boolean } {
  if (lora.provider === "sogni" && lora.source === "personal") {
    // Sogni runs an imported LoRA only above 0 and at most 1.
    return { min: Math.max(0, lora.strengthMin ?? 0), max: Math.min(1, lora.strengthMax ?? 1), minExclusive: (lora.strengthMin ?? 0) <= 0 };
  }
  const fallback = lora.provider === "fal" ? { min: 0, max: 4 } : { min: 0, max: 2 };
  return { min: lora.strengthMin ?? fallback.min, max: lora.strengthMax ?? fallback.max, minExclusive: false };
}

function showNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The family of a Sogni catalog LoRA from its id ("h3-better-motion" -> h3),
 * for LoRAs saved without one; null when the id does not say.
 */
export function inferMediaLoraFamily(lora: { provider: MediaLoraProvider; source: MediaLoraSource; ref: string }): string | null {
  if (lora.provider !== "sogni" || lora.source !== "catalog") return null;
  const ref = lora.ref.trim().toLowerCase();
  if (ref.startsWith("h3-")) return "h3";
  if (ref.startsWith("krea2-")) return "krea2";
  if (ref.startsWith("moss-")) return "moss";
  return null;
}

// ─── Checking a LoRA and a setup ─────────────────────────────────────────────

/** The fields of a saved LoRA a setup check needs. */
export interface MediaLoraForCheck extends MediaLoraRuleInput {
  id: string;
  provider: MediaLoraProvider;
  source: MediaLoraSource;
  family: string | null;
  compatibleModelIds: string[];
  contentTag: MediaContentTag;
  strengthMin: number | null;
  strengthMax: number | null;
  triggerWords: string[];
  archivedAt: Date | string | null;
}

/** Problems with a LoRA's own fields (create and update); empty when it can be saved. */
export function checkMediaLoraFields(lora: {
  provider: MediaLoraProvider;
  source: MediaLoraSource;
  ref: string;
  name: string;
  contentTag: MediaContentTag;
  providerNsfw: boolean;
  providerSexual: boolean;
  strengthMin: number | null;
  strengthMax: number | null;
  strengthDefault: number;
  recommendedMin: number | null;
  recommendedMax: number | null;
}): string[] {
  const problems: string[] = [];
  const label = lora.name.trim() || lora.ref;
  if (isFilterBypassMediaLora(lora)) {
    problems.push(`The LoRA "${label}" switches off the provider's safety filter, so it can never be saved.`);
    return problems;
  }
  if (lora.provider === "sogni" && lora.source === "url") {
    problems.push("Sogni takes LoRAs from its own list or the ones you imported into Sogni. A link only works on Fal.");
  }
  if (lora.provider === "fal" && lora.source !== "url") {
    problems.push("Fal takes LoRAs by link. Paste the https link to the LoRA file (Hugging Face or Civitai).");
  }
  if (lora.source === "url") {
    let url: URL | null = null;
    try {
      url = new URL(lora.ref);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
      problems.push("The LoRA link must be a plain https link (no user name or password in it).");
    }
  }
  const min = lora.strengthMin;
  const max = lora.strengthMax;
  if (min !== null && max !== null && min > max) problems.push("The lowest strength is above the highest strength.");
  if (min !== null && lora.strengthDefault < min) problems.push(`The default strength ${showNumber(lora.strengthDefault)} is below the lowest strength ${showNumber(min)}.`);
  if (max !== null && lora.strengthDefault > max) problems.push(`The default strength ${showNumber(lora.strengthDefault)} is above the highest strength ${showNumber(max)}.`);
  if (lora.recommendedMin !== null && lora.recommendedMax !== null && lora.recommendedMin > lora.recommendedMax) {
    problems.push("The recommended range starts above where it ends.");
  }
  const floor = mediaLoraContentFloor(lora);
  if (floor?.tag === "mature" && lora.contentTag === "sfw") {
    problems.push(`${floor.reason} It cannot be tagged safe for work.`);
  }
  return problems;
}

export interface MediaSetupForCheck {
  kind: MediaSetupKind;
  provider: MediaSetupProvider;
  modelId: string;
  mode: MediaSetupMode | null;
  editModelId: string | null;
  loras: Array<{ loraId: string; strength: number }>;
  params: Record<string, unknown>;
}

export interface MediaSetupCheck {
  /** Plain sentences; the setup can be saved when this is empty. */
  problems: string[];
  /** The rating the setup gets: mature when the model or any LoRA is mature or not yet reviewed. */
  contentRating: MediaContentRating;
  matureReasons: string[];
  family: string | null;
  /** The mode the setup runs in: the one given, else the one the model id says. */
  mode: MediaSetupMode | null;
  billing: MediaBillingCoverage;
  triggerWords: string[];
  capability: MediaModelCapability;
}

/**
 * Check a setup against the capability table and the company's LoRA library
 * (`library` holds this company's rows only, by id).
 */
export function checkMediaSetup(setup: MediaSetupForCheck, library: ReadonlyMap<string, MediaLoraForCheck>): MediaSetupCheck {
  const problems: string[] = [];
  const matureReasons: string[] = [];
  const cap = mediaModelCapability(setup.provider, setup.modelId);

  if (setup.kind === "video" && !(MEDIA_VIDEO_SETUP_PROVIDERS as readonly string[]).includes(setup.provider)) {
    problems.push("A video setup can only use Fal or Sogni, because films are rendered only with those two.");
  }
  if (cap.kinds.length > 0 && !cap.kinds.includes(setup.kind)) {
    problems.push(`${cap.label} makes ${cap.kinds.join(" and ")}, not ${setup.kind === "image" ? "pictures" : "video"}. Pick a ${setup.kind === "image" ? "picture" : "video"} model or change the setup's kind.`);
  }
  if (setup.mode && cap.mode && setup.mode !== cap.mode) {
    problems.push(`The model "${setup.modelId}" runs as ${cap.mode}, not ${setup.mode}. Pick the model id for ${setup.mode}, or change the mode.`);
  }
  if (typeof setup.params.promptExpansion !== "boolean") {
    problems.push("Say whether the service may rewrite the prompt (prompt expansion on or off).");
  }

  if (cap.matureTags.length > 0) matureReasons.push(`The model "${setup.modelId}" is made for mature pictures (${cap.matureTags.join(", ")}).`);
  if (setup.editModelId) {
    const editTags = mediaModelMatureTags(setup.editModelId);
    if (editTags.length > 0) matureReasons.push(`The edit model "${setup.editModelId}" is made for mature pictures (${editTags.join(", ")}).`);
  }

  const triggerWords: string[] = [];
  if (setup.loras.length > 0 && !cap.takesLoras) {
    problems.push(cap.noLoraReason ?? "This model takes no LoRA. Remove the LoRAs.");
  } else if (setup.loras.length > cap.maxLoras) {
    problems.push(`A setup can use at most ${cap.maxLoras} LoRAs; this has ${setup.loras.length}. Remove some.`);
  }
  const seen = new Set<string>();
  for (const pick of setup.loras) {
    if (seen.has(pick.loraId)) {
      problems.push("The same LoRA is in the list twice. Keep it once.");
      continue;
    }
    seen.add(pick.loraId);
    const lora = library.get(pick.loraId);
    if (!lora || lora.archivedAt) {
      problems.push("A picked LoRA is not in this company's LoRA library (it may have been archived or deleted). Pick LoRAs from the library.");
      continue;
    }
    const label = lora.name?.trim() || lora.ref;
    const tag = effectiveMediaLoraContentTag(lora);
    if (tag === "refused") {
      problems.push(`The LoRA "${label}" is refused and can never be used. Remove it.`);
      continue;
    }
    if (lora.provider !== setup.provider) {
      problems.push(`The LoRA "${label}" is a ${lora.provider === "fal" ? "Fal" : "Sogni"} LoRA, but this setup uses ${setup.provider}. Pick LoRAs for the same service.`);
      continue;
    }
    if (cap.takesLoras) {
      const canonical = setup.modelId.trim().toLowerCase();
      const family = lora.family ?? inferMediaLoraFamily(lora);
      const fits =
        lora.compatibleModelIds.length > 0
          ? lora.compatibleModelIds.some((m) => m.trim().toLowerCase() === canonical)
          : !family || !cap.loraFamily || family === cap.loraFamily;
      if (!fits) problems.push(`The LoRA "${label}" does not work with the model "${setup.modelId}". Pick a LoRA made for this model.`);
    }
    if (typeof pick.strength !== "number" || !Number.isFinite(pick.strength)) {
      problems.push(`Give the LoRA "${label}" a strength.`);
      continue;
    }
    const bounds = mediaLoraStrengthBounds(lora);
    const belowMin = bounds.minExclusive ? pick.strength <= bounds.min : pick.strength < bounds.min;
    if (belowMin || pick.strength > bounds.max) {
      problems.push(
        `The strength of "${label}" must be ${bounds.minExclusive ? "above" : "at least"} ${showNumber(bounds.min)} and at most ${showNumber(bounds.max)} (it is ${showNumber(pick.strength)}). Strengths are multipliers, not percentages.`,
      );
    }
    if (tag === "mature") matureReasons.push(`The LoRA "${label}" is mature.`);
    if (tag === "unreviewed") matureReasons.push(`The LoRA "${label}" has not been reviewed yet, so it counts as mature.`);
    for (const word of lora.triggerWords) if (word && !triggerWords.includes(word)) triggerWords.push(word);
  }

  return {
    problems,
    contentRating: matureReasons.length > 0 ? "mature" : "sfw",
    matureReasons,
    family: cap.family,
    mode: setup.mode ?? cap.mode,
    billing: cap.billing,
    triggerWords,
    capability: cap,
  };
}

// ─── Register summary ────────────────────────────────────────────────────────

export interface MediaSetupTrialForSummary {
  scores: Partial<Record<MediaSetupScoreAttribute, number>>;
  raterKind: MediaTrialRaterKind;
  flaggedByCheck: boolean;
  flaggedByProvider: boolean;
  costCents: number | null;
  secondsTaken: number | null;
}

export type MediaSetupSfwTendency = "sfw" | "leans_mature" | "mature";

export interface MediaSetupRegisterSummary {
  trialCount: number;
  /** Average 1-5 score per attribute from people's ratings (null = not rated yet). */
  humanScores: Record<MediaSetupScoreAttribute, number | null>;
  /** An AI judge's averages, shown apart from people's (D12). */
  aiScores: Record<MediaSetupScoreAttribute, number | null>;
  flaggedCount: number;
  sfwTendency: MediaSetupSfwTendency;
  sfwTendencyNote: string;
  averageCostCents: number | null;
  averageSeconds: number | null;
}

function averages(trials: MediaSetupTrialForSummary[]): Record<MediaSetupScoreAttribute, number | null> {
  const out = {} as Record<MediaSetupScoreAttribute, number | null>;
  for (const attribute of MEDIA_SETUP_SCORE_ATTRIBUTES) {
    const values = trials.map((t) => t.scores[attribute]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    out[attribute] = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
  }
  return out;
}

function mean(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
}

/** The register line for one setup: scores, flags, SFW/NSFW tendency (computed) and cost. */
export function summarizeMediaSetupTrials(trials: MediaSetupTrialForSummary[], contentRating: MediaContentRating): MediaSetupRegisterSummary {
  const flaggedCount = trials.filter((t) => t.flaggedByCheck || t.flaggedByProvider).length;
  const share = trials.length ? flaggedCount / trials.length : 0;
  let sfwTendency: MediaSetupSfwTendency = "sfw";
  let sfwTendencyNote = trials.length ? `No flagged results in ${trials.length} ${trials.length === 1 ? "try" : "tries"}.` : "No tries yet; judged from the model and LoRA tags only.";
  if (contentRating === "mature") {
    sfwTendency = "mature";
    sfwTendencyNote = "The model or a LoRA is mature or not yet reviewed.";
  } else if (flaggedCount > 0) {
    sfwTendency = share >= MEDIA_SETUP_LEANS_MATURE_SHARE ? "leans_mature" : "sfw";
    sfwTendencyNote = `${flaggedCount} of ${trials.length} ${trials.length === 1 ? "try was" : "tries were"} flagged by the picture check or the service.`;
  }
  return {
    trialCount: trials.length,
    humanScores: averages(trials.filter((t) => t.raterKind === "human")),
    aiScores: averages(trials.filter((t) => t.raterKind === "ai")),
    flaggedCount,
    sfwTendency,
    sfwTendencyNote,
    averageCostCents: mean(trials.map((t) => t.costCents)),
    averageSeconds: mean(trials.map((t) => t.secondsTaken)),
  };
}

// ─── Starters (D4) ───────────────────────────────────────────────────────────

/** Sogni's catalog model ids that take the two starter H3 LoRAs (Sogni LoRA catalog, 24 Oct 2026). */
export const SOGNI_H3_LORA_MODEL_IDS: readonly string[] = [
  "minimax-h3-fl2va-fp8_t2v",
  "minimax-h3-fl2va-fp8_i2v",
  "minimax-h3-fl2va-fp8_flf2v",
  "minimax-h3-ref2va-fp8_r2v",
  "minimax-h3-fl2va-fp8_t2v_balanced",
  "minimax-h3-fl2va-fp8_i2v_balanced",
  "minimax-h3-fl2va-fp8_flf2v_balanced",
  "minimax-h3-ref2va-fp8_r2v_balanced",
  "minimax-h3-fl2va-fp8_t2v_turbo",
  "minimax-h3-fl2va-fp8_i2v_turbo",
  "minimax-h3-fl2va-fp8_flf2v_turbo",
  "minimax-h3-ref2va-fp8_r2v_turbo",
  "minimax-h3-fastvideo-int8_t2v_turbo",
  "minimax-h3-fastvideo-int8_i2v_turbo",
  "minimax-h3-fastvideo-int8_flf2v_turbo",
  "minimax-h3-fastvideo-int8_t2v_turbo_2stage",
  "minimax-h3-fastvideo-int8_i2v_turbo_2stage",
  "minimax-h3-fastvideo-int8_flf2v_turbo_2stage",
  "minimax-h3-fastvideo-int8_a2v_turbo",
  "minimax-h3-fastvideo-int8_ia2v_turbo",
  "minimax-h3-fastvideo-int8_flfa2v_turbo",
  "minimax-h3-fastvideo-int8_a2v_turbo_2stage",
  "minimax-h3-fastvideo-int8_ia2v_turbo_2stage",
  "minimax-h3-fastvideo-int8_flfa2v_turbo_2stage",
  "minimax-h3-ref2va-fp8_r2v_2stage",
  "minimax-h3-ref2va-fp8_r2v_balanced_2stage",
  "minimax-h3-fastvideo-omni-int8_r2v_turbo",
  "minimax-h3-fastvideo-omni-int8_r2v_turbo_2stage",
];

export interface MediaStarterLora {
  key: string;
  provider: MediaLoraProvider;
  source: MediaLoraSource;
  ref: string;
  name: string;
  notes: string;
  family: string;
  compatibleModelIds: readonly string[];
  contentTag: MediaContentTag;
  strengthMin: number;
  strengthMax: number;
  strengthDefault: number;
  recommendedMin: number;
  recommendedMax: number;
}

export const MEDIA_STARTER_LORAS: readonly MediaStarterLora[] = [
  {
    key: "sogni-h3-better-motion",
    provider: "sogni",
    source: "catalog",
    ref: "h3-better-motion",
    name: "Better Motion",
    notes: "Sogni's MiniMax H3 LoRA for smoother, more natural movement. Sogni recommends 0.4-0.8 (default 0.6).",
    family: "h3",
    compatibleModelIds: SOGNI_H3_LORA_MODEL_IDS,
    contentTag: "sfw",
    strengthMin: 0,
    strengthMax: 1.5,
    strengthDefault: 0.6,
    recommendedMin: 0.4,
    recommendedMax: 0.8,
  },
  {
    key: "sogni-h3-natural-face-speech",
    provider: "sogni",
    source: "catalog",
    ref: "h3-natural-face-speech",
    name: "Natural Face & Speech",
    notes: "Sogni's MiniMax H3 LoRA for natural faces and lip movement when people talk. Sogni recommends 0.4-0.8 (default 0.6).",
    family: "h3",
    compatibleModelIds: SOGNI_H3_LORA_MODEL_IDS,
    contentTag: "sfw",
    strengthMin: 0,
    strengthMax: 1.5,
    strengthDefault: 0.6,
    recommendedMin: 0.4,
    recommendedMax: 0.8,
  },
];

export interface MediaStarterSetup {
  key: string;
  name: string;
  description: string;
  kind: MediaSetupKind;
  provider: MediaSetupProvider;
  family: string;
  mode: MediaSetupMode;
  modelId: string;
  loras: Array<{ starterLoraKey: string; strength: number }>;
  params: { promptExpansion: boolean };
  tags: string[];
  notes: string;
  /** Picked as the company's default for this kind on first use. */
  companyDefault: boolean;
}

const H3_LICENCE_NOTE =
  "MiniMax H3's licence for commercial use is still being checked (D19), so this setup stays a draft: agents only use approved setups. You can use it in your own films now.";

/**
 * The starters every company gets once (Filip's D4, 27 Oct 2026). All
 * editable; all start as drafts, so nothing is offered to agents until an
 * owner or admin approves it.
 */
export const MEDIA_STARTER_SETUPS: readonly MediaStarterSetup[] = [
  {
    key: "natural",
    name: "Natural",
    description: "MiniMax H3 on Sogni with Better Motion at 0.6: natural, everyday movement. Start and end picture, about 15 s per clip.",
    kind: "video",
    provider: "sogni",
    family: "h3",
    mode: "flf2v",
    modelId: "minimax-h3-fl2va-fp8_flf2v",
    loras: [{ starterLoraKey: "sogni-h3-better-motion", strength: 0.6 }],
    params: { promptExpansion: false },
    tags: ["starter"],
    notes: H3_LICENCE_NOTE,
    companyDefault: true,
  },
  {
    key: "natural-face-speech",
    name: "Natural face & speech",
    description: "MiniMax H3 on Sogni with Natural Face & Speech at 0.6: for people talking on camera. Start and end picture, about 15 s per clip.",
    kind: "video",
    provider: "sogni",
    family: "h3",
    mode: "flf2v",
    modelId: "minimax-h3-fl2va-fp8_flf2v",
    loras: [{ starterLoraKey: "sogni-h3-natural-face-speech", strength: 0.6 }],
    params: { promptExpansion: false },
    tags: ["starter"],
    notes: H3_LICENCE_NOTE,
    companyDefault: false,
  },
  {
    key: "action",
    name: "Action",
    description: "MiniMax H3 on Sogni with Better Motion at 0.8: livelier, faster movement for action scenes. Start and end picture, about 15 s per clip.",
    kind: "video",
    provider: "sogni",
    family: "h3",
    mode: "flf2v",
    modelId: "minimax-h3-fl2va-fp8_flf2v",
    loras: [{ starterLoraKey: "sogni-h3-better-motion", strength: 0.8 }],
    params: { promptExpansion: false },
    tags: ["starter"],
    notes: H3_LICENCE_NOTE,
    companyDefault: false,
  },
  {
    key: "romantic-calm",
    name: "Romantic / calm",
    description: "Wan 3 on Sogni with a start and an end picture, up to 30 s in one clip: slow, calm scenes. Wan 3 takes no LoRA.",
    kind: "video",
    provider: "sogni",
    family: "wan3",
    mode: "flf2v",
    modelId: "wan3.0-video",
    loras: [],
    params: { promptExpansion: false },
    tags: ["starter"],
    notes: "Wan 3 is paid with Sogni premium Spark; the Unlimited plan does not cover it.",
    companyDefault: false,
  },
  {
    key: "stills-krea2",
    name: "Stills (Krea 2)",
    description: "Krea 2 Turbo on Sogni for storyboard and keyframe pictures, no LoRA.",
    kind: "image",
    provider: "sogni",
    family: "krea2",
    mode: "t2i",
    modelId: "krea2_turbo_fp8_scaled",
    loras: [],
    params: { promptExpansion: false },
    tags: ["starter"],
    notes: "",
    companyDefault: true,
  },
];

// ─── Requests ────────────────────────────────────────────────────────────────

const nameField = z.string().trim().min(1, "Give it a name.").max(MEDIA_SETUP_NAME_MAX_LENGTH);
const textField = z.string().trim().max(MEDIA_SETUP_TEXT_MAX_LENGTH);
const modelIdField = z.string().trim().min(1, "Pick a model.").max(MEDIA_MODEL_ID_MAX_LENGTH);
const finiteNumber = z.number().finite();
const shortList = (max: number, itemMax: number) => z.array(z.string().trim().min(1).max(itemMax)).max(max);

const loraFields = {
  provider: z.enum(MEDIA_LORA_PROVIDERS),
  source: z.enum(MEDIA_LORA_SOURCES),
  ref: z.string().trim().min(1, "Give the LoRA's id or link.").max(MEDIA_LORA_REF_MAX_LENGTH),
  name: nameField,
  notes: textField,
  triggerWords: shortList(20, 100),
  family: z.string().trim().min(1).max(40).nullable(),
  compatibleModelIds: shortList(100, MEDIA_MODEL_ID_MAX_LENGTH),
  contentTag: z.enum(MEDIA_CONTENT_TAGS),
  providerNsfw: z.boolean(),
  providerSexual: z.boolean(),
  strengthMin: finiteNumber.nullable(),
  strengthMax: finiteNumber.nullable(),
  strengthDefault: finiteNumber,
  recommendedMin: finiteNumber.nullable(),
  recommendedMax: finiteNumber.nullable(),
};

export const createMediaLoraSchema = z
  .object({
    provider: loraFields.provider,
    source: loraFields.source,
    ref: loraFields.ref,
    name: loraFields.name,
    notes: loraFields.notes.optional().default(""),
    triggerWords: loraFields.triggerWords.optional().default([]),
    family: loraFields.family.optional().default(null),
    compatibleModelIds: loraFields.compatibleModelIds.optional().default([]),
    contentTag: loraFields.contentTag.optional().default("unreviewed"),
    providerNsfw: loraFields.providerNsfw.optional().default(false),
    providerSexual: loraFields.providerSexual.optional().default(false),
    strengthMin: loraFields.strengthMin.optional().default(null),
    strengthMax: loraFields.strengthMax.optional().default(null),
    strengthDefault: loraFields.strengthDefault.optional().default(MEDIA_LORA_DEFAULT_STRENGTH),
    recommendedMin: loraFields.recommendedMin.optional().default(null),
    recommendedMax: loraFields.recommendedMax.optional().default(null),
  })
  .strict();
export type CreateMediaLoraInput = z.infer<typeof createMediaLoraSchema>;

/** Provider, source and ref are fixed once saved: a different file is a different LoRA. */
export const updateMediaLoraSchema = z
  .object({
    name: loraFields.name,
    notes: loraFields.notes,
    triggerWords: loraFields.triggerWords,
    family: loraFields.family,
    compatibleModelIds: loraFields.compatibleModelIds,
    contentTag: loraFields.contentTag,
    providerNsfw: loraFields.providerNsfw,
    providerSexual: loraFields.providerSexual,
    strengthMin: loraFields.strengthMin,
    strengthMax: loraFields.strengthMax,
    strengthDefault: loraFields.strengthDefault,
    recommendedMin: loraFields.recommendedMin,
    recommendedMax: loraFields.recommendedMax,
    archived: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateMediaLoraInput = z.infer<typeof updateMediaLoraSchema>;

export const mediaSetupLoraPickSchema = z
  .object({
    loraId: z.string().uuid(),
    // Always explicit: Sogni runs a LoRA at 1.0 when the strength is left out.
    strength: z.number({ required_error: "Give every LoRA a strength." }).finite(),
  })
  .strict();

const paramValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
export const mediaSetupParamsSchema = z
  .object({ promptExpansion: z.boolean({ required_error: "Say whether the service may rewrite the prompt (promptExpansion true or false)." }) })
  .catchall(paramValue)
  .refine((params) => Object.keys(params).length <= 30, "A setup has at most 30 params.");

const setupFields = {
  kind: z.enum(MEDIA_SETUP_KINDS),
  name: nameField,
  description: textField,
  provider: z.enum(MEDIA_SETUP_PROVIDERS),
  family: z.string().trim().min(1).max(40).nullable(),
  mode: z.enum(MEDIA_SETUP_MODES).nullable(),
  modelId: modelIdField,
  editModelId: modelIdField.nullable(),
  loras: z.array(mediaSetupLoraPickSchema).max(MEDIA_SETUP_MAX_LORAS),
  params: mediaSetupParamsSchema,
  tags: shortList(20, 40),
  favorite: z.boolean(),
  notes: textField,
};

export const createMediaSetupSchema = z
  .object({
    kind: setupFields.kind,
    name: setupFields.name,
    description: setupFields.description.optional().default(""),
    provider: setupFields.provider,
    family: setupFields.family.optional().default(null),
    mode: setupFields.mode.optional().default(null),
    modelId: setupFields.modelId,
    editModelId: setupFields.editModelId.optional().default(null),
    loras: setupFields.loras.optional().default([]),
    params: setupFields.params,
    tags: setupFields.tags.optional().default([]),
    favorite: setupFields.favorite.optional().default(false),
    notes: setupFields.notes.optional().default(""),
    status: z.enum(["draft", "approved"]).optional().default("draft"),
  })
  .strict();
export type CreateMediaSetupInput = z.infer<typeof createMediaSetupSchema>;

export const updateMediaSetupSchema = z
  .object({ ...setupFields, status: z.enum(MEDIA_SETUP_STATUSES) })
  .partial()
  .strict();
export type UpdateMediaSetupInput = z.infer<typeof updateMediaSetupSchema>;

const scoreValue = z.number().int().min(1, "Scores go from 1 to 5.").max(5, "Scores go from 1 to 5.");
export const mediaSetupScoresSchema = z
  .object(Object.fromEntries(MEDIA_SETUP_SCORE_ATTRIBUTES.map((a) => [a, scoreValue])) as Record<MediaSetupScoreAttribute, typeof scoreValue>)
  .partial()
  .strict();

export const createMediaSetupTrialSchema = z
  .object({
    storylineId: z.string().uuid().nullable().optional().default(null),
    personaId: z.string().uuid().nullable().optional().default(null),
    inputs: z.record(paramValue).optional().default({}),
    prompt: z.string().trim().max(6_000).nullable().optional().default(null),
    resultFileId: z.string().uuid().nullable().optional().default(null),
    scores: mediaSetupScoresSchema.optional().default({}),
    flaggedByCheck: z.boolean().optional().default(false),
    flaggedByProvider: z.boolean().optional().default(false),
    costCents: z.number().int().min(0).nullable().optional().default(null),
    secondsTaken: z.number().int().min(0).nullable().optional().default(null),
    raterKind: z.enum(MEDIA_TRIAL_RATER_KINDS).optional().default("human"),
    notes: textField.optional().default(""),
  })
  .strict();
export type CreateMediaSetupTrialInput = z.infer<typeof createMediaSetupTrialSchema>;

export const updateMediaProjectDefaultsSchema = z
  .object({
    defaultImageSetupId: z.string().uuid().nullable(),
    defaultVideoSetupId: z.string().uuid().nullable(),
    defaultContentRating: z.enum(MEDIA_CONTENT_RATINGS),
    defaultContinuityMode: z.enum(MEDIA_CONTINUITY_MODES),
  })
  .partial()
  .strict();
export type UpdateMediaProjectDefaultsInput = z.infer<typeof updateMediaProjectDefaultsSchema>;

/** PUT .../media/storylines/:storylineId/setups: which setups a storyline uses (null = none). */
export const setStorylineMediaSetupsSchema = z
  .object({
    imageSetupId: z.string().uuid().nullable(),
    videoSetupId: z.string().uuid().nullable(),
  })
  .partial()
  .strict()
  .refine((value) => value.imageSetupId !== undefined || value.videoSetupId !== undefined, "Pick a picture setup, a video setup, or both.");
export type SetStorylineMediaSetupsInput = z.infer<typeof setStorylineMediaSetupsSchema>;

export const listMediaSetupsQuerySchema = z
  .object({
    kind: z.enum(MEDIA_SETUP_KINDS).optional(),
    includeArchived: z.enum(["true", "false"]).optional(),
  })
  .strict();

// ─── What the API returns ────────────────────────────────────────────────────

export interface MediaLora {
  id: string;
  companyId: string;
  provider: MediaLoraProvider;
  source: MediaLoraSource;
  ref: string;
  name: string;
  notes: string;
  triggerWords: string[];
  family: string | null;
  compatibleModelIds: string[];
  /** As stored (what a person set). */
  contentTag: MediaContentTag;
  /** What counts: raised to the rule floor (refused / mature) when the rules say so. */
  effectiveContentTag: MediaContentTag;
  contentNote: string | null;
  providerNsfw: boolean;
  providerSexual: boolean;
  strengthMin: number | null;
  strengthMax: number | null;
  strengthDefault: number;
  recommendedMin: number | null;
  recommendedMax: number | null;
  builtinKey: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaSetupLoraView {
  loraId: string;
  strength: number;
  /** Null when the LoRA is gone from the library. */
  name: string | null;
  ref: string | null;
  source: MediaLoraSource | null;
  triggerWords: string[];
  contentTag: MediaContentTag | null;
}

export interface MediaModelSetup {
  id: string;
  companyId: string;
  kind: MediaSetupKind;
  name: string;
  description: string;
  provider: MediaSetupProvider;
  family: string | null;
  mode: MediaSetupMode | null;
  modelId: string;
  editModelId: string | null;
  loras: MediaSetupLoraView[];
  params: Record<string, unknown>;
  contentRating: MediaContentRating;
  matureReasons: string[];
  matureEnabledByUserId: string | null;
  status: MediaSetupStatus;
  approvedByUserId: string | null;
  approvedAt: string | null;
  tags: string[];
  favorite: boolean;
  notes: string;
  builtinKey: string | null;
  billing: MediaBillingCoverage;
  billingLabel: string;
  triggerWords: string[];
  /** Problems found now (e.g. a LoRA was refused after the setup was saved); empty when usable. */
  problems: string[];
  register: MediaSetupRegisterSummary;
  createdAt: string;
  updatedAt: string;
}

export interface MediaModelSetupTrial {
  id: string;
  setupId: string;
  storylineId: string | null;
  personaId: string | null;
  inputs: Record<string, unknown>;
  prompt: string | null;
  resultFileId: string | null;
  scores: Partial<Record<MediaSetupScoreAttribute, number>>;
  flaggedByCheck: boolean;
  flaggedByProvider: boolean;
  costCents: number | null;
  secondsTaken: number | null;
  raterKind: MediaTrialRaterKind;
  raterId: string | null;
  notes: string;
  createdAt: string;
}

export interface MediaProjectDefaults {
  companyId: string;
  defaultImageSetupId: string | null;
  defaultVideoSetupId: string | null;
  defaultContentRating: MediaContentRating;
  defaultContinuityMode: MediaContinuityMode;
  setupsSeededAt: string | null;
  updatedAt: string | null;
}

export interface MediaSetupsView {
  setups: MediaModelSetup[];
  /** Owners and admins may change setups and LoRAs; everyone else reads. */
  canEdit: boolean;
}

export interface MediaLorasView {
  loras: MediaLora[];
  canEdit: boolean;
}

/** A setup resolved for a run: what goes to the provider, with the LoRAs' provider refs. */
export interface MediaResolvedSetup {
  setupId: string;
  name: string;
  kind: MediaSetupKind;
  status: MediaSetupStatus;
  provider: MediaSetupProvider;
  modelId: string;
  editModelId: string | null;
  mode: MediaSetupMode | null;
  family: string | null;
  loras: Array<{ loraId: string; ref: string; source: MediaLoraSource; name: string; strength: number; triggerWords: string[] }>;
  triggerWords: string[];
  params: Record<string, unknown>;
  contentRating: MediaContentRating;
  billing: MediaBillingCoverage;
  /** False when the setup has problems or is archived; `problems` says why in plain words. */
  usable: boolean;
  problems: string[];
}

export interface MediaSetupCheckResult {
  ok: boolean;
  problems: string[];
  contentRating: MediaContentRating;
  matureReasons: string[];
  mode: MediaSetupMode | null;
  family: string | null;
  billing: MediaBillingCoverage;
  billingLabel: string;
  triggerWords: string[];
}
