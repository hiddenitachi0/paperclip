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
//
// A copy of the same section in server/src/services/video-provider-clients.ts
// (the server cannot import this private package, nor this package the
// server); server/src/__tests__/sogni-video-provider.test.ts checks both give
// the same answers and the same request body.

export type SogniVideoTool = "generate_video" | "animate_photo";

/** Tool keys per published schema (videoModel enums). */
const GENERATE_VIDEO_KEYS = new Set([
  "ltx25", "ltx23", "wan22", "seedance2", "seedance2-mini", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-t2v", "minimax-h3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo-2stage",
  "happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "minimax-h3-r2v", "minimax-h3-r2v-turbo", "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
]);
const ANIMATE_PHOTO_KEYS = new Set([
  "ltx25", "ltx23", "wan22", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "minimax-h3-i2v", "minimax-h3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo-2stage",
  "minimax-h3-flf2v", "minimax-h3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
]);
/** Models whose generate_video takes loose reference pictures (referenceImageIndices). */
const LOOSE_REFERENCE_KEYS = new Set([
  "seedance2", "seedance2-mini", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-r2v", "minimax-h3-r2v-turbo", "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced-2stage",
  "happyhorse-1.1-r2v", "wan3.0-video", "wan3.0-spicy-video",
]);
const SEEDANCE_KEYS: Record<string, string> = {
  "seedance-2-0": "seedance2",
  "seedance-2-0-fast": "seedance2-mini",
  "seedance-2-0-mini": "seedance2-mini",
  "seedance-2-5": "seedance2-5",
  "seedance-2-5-uncensored": "seedance2-5-uncensored",
};

/**
 * The videoModel key for a model name (a tool key, or a catalogue id from the
 * picker) and the job: with a start picture the image-to-video variant,
 * without one the text-to-video variant. null = Sogni's default; an unknown
 * name is returned unchanged.
 */
export function sogniVideoModelKey(model: string | null | undefined, withStartImage: boolean): string | null {
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
    if (id.includes("r2v")) {
      if (twoStage) return id.includes("balanced") ? "minimax-h3-r2v-balanced-2stage" : "minimax-h3-r2v-2stage";
      return id.includes("turbo") ? "minimax-h3-r2v-turbo" : "minimax-h3-r2v";
    }
    const flf = id.includes("flf2v");
    const workflow = withStartImage ? (flf ? "flf2v" : "i2v") : "t2v";
    if (id.includes("fastvideo") || id.includes("fasth3")) return `minimax-h3-fasth3-${workflow}-turbo${twoStage ? "-2stage" : ""}`;
    return `minimax-h3-${workflow}${id.includes("turbo") ? "-turbo" : ""}`;
  }
  return raw;
}

/** Which tool a shot uses, and whether its pictures go along as a start frame or as loose references. */
export function sogniVideoStep(model: string | null | undefined, hasStartImage: boolean): { tool: SogniVideoTool; videoModel: string | null; pictures: "start" | "references" | "none" } {
  const startKey = sogniVideoModelKey(model, true);
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
