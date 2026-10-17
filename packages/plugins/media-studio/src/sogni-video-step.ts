// Sogni video: which workflow tool and videoModel key a shot uses. Follows
// Sogni's published tool schemas (@sogni-ai/sogni-intelligence-client 4.11.0,
// schema version 2026-07-18.1, additionalProperties false):
//
//   generate_video  {prompt, duration, videoModel?, referenceImageIndices?}
//   animate_photo   {prompt, duration, videoModel?, sourceImageIndex}  (start frame)
//
// `videoModel` takes Sogni's tool keys ("ltx25", "seedance2-mini", ...); a
// catalogue id from the Storylines picker is mapped to its key (the SDK's
// utils/videoModelIds.js and seedanceModelIds.js aliases).
// Sogni's default ("ltx25") is asked for by leaving videoModel out -- see
// SOGNI_DEFAULT_VIDEO_MODEL for the 17 Oct 2026 refusal that made us do so.
//
// A copy of the same section in server/src/services/video-provider-clients.ts
// (the server cannot import this private package, nor this package the
// server); server/src/__tests__/sogni-video-provider.test.ts checks both give
// the same answers and the same request body.

export type SogniVideoTool = "generate_video" | "animate_photo";

/**
 * Tool keys per Sogni's current published lists (videoModel enums of the
 * hosted tools manifest in @sogni-ai/sogni-client 5.64.0 / sogni-protocol
 * 1.0.0-alpha.51, 17 Oct 2026; Sogni's live answer that day listed the same
 * animate_photo keys, the "-balanced" ones included).
 */
const GENERATE_VIDEO_KEYS = new Set([
  "ltx25", "ltx23", "wan22", "seedance2", "seedance2-mini", "seedance2-mini-uncensored", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-t2v", "minimax-h3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo-2stage",
  "happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "minimax-h3-r2v", "minimax-h3-r2v-turbo", "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
  "minimax-h3-turbo", "minimax-h3-fasth3-turbo", "minimax-h3-fasth3-turbo-2stage",
  "minimax-h3-balanced", "minimax-h3-t2v-balanced", "minimax-h3-r2v-balanced",
]);
const ANIMATE_PHOTO_KEYS = new Set([
  "ltx25", "ltx23", "wan22", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "minimax-h3-i2v", "minimax-h3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo-2stage",
  "minimax-h3-flf2v", "minimax-h3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
  "minimax-h3-i2v-balanced", "minimax-h3-flf2v-balanced",
]);
/** Models whose generate_video takes loose reference pictures (referenceImageIndices). */
const LOOSE_REFERENCE_KEYS = new Set([
  "seedance2", "seedance2-mini", "seedance2-mini-uncensored", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-r2v", "minimax-h3-r2v-turbo", "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced", "minimax-h3-r2v-balanced-2stage",
  "happyhorse-1.1-r2v", "wan3.0-video", "wan3.0-spicy-video",
]);
const SEEDANCE_KEYS: Record<string, string> = {
  "seedance-2-0": "seedance2",
  "seedance-2-0-fast": "seedance2-mini",
  "seedance-2-0-mini": "seedance2-mini",
  "seedance-2-0-mini-uncensored": "seedance2-mini-uncensored",
  "seedance-2-5": "seedance2-5",
  "seedance-2-5-uncensored": "seedance2-5-uncensored",
};

/**
 * The videoModel key for a model name (a tool key, or a catalogue id from the
 * picker) and the job: with a start picture the image-to-video variant,
 * without one the text-to-video variant. null = Sogni's default; an unknown
 * name is returned unchanged.
 */
export function sogniVideoModelKey(model: string | null | undefined, withStartImage: boolean, withEndImage = false): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  if (SEEDANCE_KEYS[id]) return SEEDANCE_KEYS[id]!;
  if (id.startsWith("seedance")) return id;
  if (/^ltx-?2\.?5|^ltx25/.test(id)) return "ltx25";
  if (/^ltx-?2\.?3|^ltx23|10eros/.test(id)) return "ltx23";
  if (/^wan_v2\.2|^wan-?2\.?2|^wan22/.test(id)) return "wan22";
  if (/^wan3/.test(id)) return id.includes("spicy") ? "wan3.0-spicy-video" : "wan3.0-video";
  if (id.startsWith("happyhorse-1.1")) {
    if (id.endsWith("r2v")) return "happyhorse-1.1-r2v";
    return withStartImage ? "happyhorse-1.1-i2v" : "happyhorse-1.1-t2v";
  }
  if (id.startsWith("minimax-h3")) {
    const twoStage = id.includes("2stage");
    const balanced = id.includes("balanced");
    if (id.includes("r2v")) {
      if (twoStage) return balanced ? "minimax-h3-r2v-balanced-2stage" : "minimax-h3-r2v-2stage";
      if (balanced) return "minimax-h3-r2v-balanced";
      return id.includes("turbo") ? "minimax-h3-r2v-turbo" : "minimax-h3-r2v";
    }
    // A start AND an end picture (a transition) needs H3's first/last-frame variant, never plain i2v.
    const flf = id.includes("flf2v") || (withStartImage && withEndImage);
    const workflow = withStartImage ? (flf ? "flf2v" : "i2v") : "t2v";
    if (id.includes("fastvideo") || id.includes("fasth3")) return `minimax-h3-fasth3-${workflow}-turbo${twoStage ? "-2stage" : ""}`;
    // The LightX2V 8-step "Balanced" engine (t2v / i2v / flf2v).
    if (balanced) return `minimax-h3-${workflow}-balanced`;
    return `minimax-h3-${workflow}${id.includes("turbo") ? "-turbo" : ""}`;
  }
  return raw;
}

/** Which tool a shot uses, and whether its pictures go along as a start frame or as loose references. */
export function sogniVideoStep(model: string | null | undefined, hasStartImage: boolean, hasEndImage = false): { tool: SogniVideoTool; videoModel: string | null; pictures: "start" | "references" | "none" } {
  const startKey = sogniVideoModelKey(model, true, hasEndImage);
  // Image-to-video when there is a start frame and the model can take one (Seedance and r2v models use loose references instead).
  if (hasStartImage && (startKey === null || ANIMATE_PHOTO_KEYS.has(startKey)) && !(startKey && startKey.endsWith("r2v"))) {
    return { tool: "animate_photo", videoModel: startKey, pictures: "start" };
  }
  const key = sogniVideoModelKey(model, false);
  const known = key === null || GENERATE_VIDEO_KEYS.has(key);
  const loose = key !== null && LOOSE_REFERENCE_KEYS.has(key);
  if (hasStartImage && !known && startKey !== null) {
    // A custom id we cannot classify: send the start frame the image-to-video way.
    return { tool: "animate_photo", videoModel: startKey, pictures: "start" };
  }
  return { tool: "generate_video", videoModel: key, pictures: loose ? "references" : "none" };
}

/**
 * Sogni's documented default video model for both tools. It is asked for by
 * leaving `videoModel` out rather than naming it: on 17 Oct 2026 Sogni's
 * workflow check refused animate_photo with videoModel "ltx25" while listing
 * "ltx25" as allowed, so naming its own default is the one request shape we
 * know it can trip over. The model the shot is recorded with stays "ltx25".
 */
export const SOGNI_DEFAULT_VIDEO_MODEL = "ltx25";

/** The `videoModel` argument to send for a planned model (null = leave it out). */
export function sogniVideoModelArgument(videoModel: string | null): string | null {
  return videoModel && videoModel !== SOGNI_DEFAULT_VIDEO_MODEL ? videoModel : null;
}

const SOGNI_ERROR_DETAIL_MAX = 1500;
const SOGNI_TOOL_WORDS: Record<SogniVideoTool, string> = {
  animate_photo: "animating a picture",
  generate_video: "making a video",
};

/**
 * Sogni's own words, safe to log and show: no links (upload/download
 * addresses), no data: URIs or long base64/token runs, no API key, at most
 * ~1500 characters.
 */
export function sanitizeSogniErrorText(text: string, secrets: readonly string[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[hidden]");
  }
  out = out
    .replace(/data:[^\s"',;]*;base64,[A-Za-z0-9+/=_-]*/gi, "[picture]")
    .replace(/\b(?:https?|wss?|s3|gs):\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [hidden]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[…]")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > SOGNI_ERROR_DETAIL_MAX ? `${out.slice(0, SOGNI_ERROR_DETAIL_MAX - 1).trimEnd()}…` : out;
}

/** Sogni turned a video request down. Carries what we sent (tool, model) and what Sogni said, for the logs. */
export class SogniVideoRequestError extends Error {
  readonly status: number;
  readonly sogniErrorCode: number | string | null;
  readonly sogniMessage: string;
  readonly tool: SogniVideoTool;
  /** The model the shot asked for (Sogni's key), null = Sogni's default. */
  readonly videoModel: string | null;
  /** What actually went in `arguments.videoModel` (null = left out). */
  readonly sentVideoModel: string | null;
  constructor(
    message: string,
    details: { status: number; sogniErrorCode: number | string | null; sogniMessage: string; tool: SogniVideoTool; videoModel: string | null; sentVideoModel: string | null },
  ) {
    super(message);
    this.name = "SogniVideoRequestError";
    this.status = details.status;
    this.sogniErrorCode = details.sogniErrorCode;
    this.sogniMessage = details.sogniMessage;
    this.tool = details.tool;
    this.videoModel = details.videoModel;
    this.sentVideoModel = details.sentVideoModel;
  }
}

/**
 * The plain-English error for a refused workflow start. Sogni answers
 * `{status:"error", errorCode, message}`; its message is kept whole (cleaned,
 * up to ~1500 characters), and a refused video model is spelled out with the
 * list Sogni accepts.
 */
export function sogniVideoRefusal(
  status: number,
  bodyText: string,
  sent: { tool: SogniVideoTool; videoModel: string | null; sentVideoModel: string | null },
  secrets: readonly string[] = [],
): SogniVideoRequestError {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(bodyText);
    parsed = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const nested = parsed?.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : null;
  const rawMessage = [parsed?.message, nested?.message].find((m): m is string => typeof m === "string" && m.trim() !== "") ?? bodyText;
  const code = [parsed?.errorCode, nested?.code, parsed?.code].find((c): c is number | string => typeof c === "number" || typeof c === "string") ?? null;
  const said = sanitizeSogniErrorText(rawMessage, secrets);
  const doing = SOGNI_TOOL_WORDS[sent.tool];
  const model = sent.videoModel ? `the video model "${sent.videoModel}"` : "Sogni's default video model";
  const leftOut = sent.videoModel && !sent.sentVideoModel ? " (asked for as Sogni's default, without naming it)" : "";
  let message: string;
  const enumMatch = /Argument "videoModel" must be one of ((?:"[^"]*"(?:,\s*)?)+)/.exec(rawMessage);
  if (enumMatch) {
    const accepted = [...enumMatch[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).filter((v) => v !== "");
    const list = sanitizeSogniErrorText(accepted.join(", "), secrets);
    message = `Sogni refused the video request (${status}): it didn't accept ${model}${leftOut} for ${doing}; it accepts: ${list}.`;
    if (sent.videoModel && accepted.includes(sent.videoModel)) {
      message += ` "${sent.videoModel}" is on Sogni's own list, so this looks like a problem on Sogni's side. Try again later, or pick another video model for this shot.`;
    }
    message += ` Sogni said: ${said}`;
  } else {
    message = `Sogni refused the video request (${status}) for ${doing} with ${model}${leftOut}: ${said || "no reason given"}`;
  }
  return new SogniVideoRequestError(message, { status, sogniErrorCode: code, sogniMessage: said, tool: sent.tool, videoModel: sent.videoModel, sentVideoModel: sent.sentVideoModel });
}
