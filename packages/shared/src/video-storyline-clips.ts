import { z } from "zod";

/**
 * Storyline Simple editor, Phase 2 (design 2.5-2.7): mixed clips (AI shots,
 * the company's own videos and photos), the music lane and export. Shared by
 * the server; the plugin UI keeps plain copies (it cannot import this
 * package). These lists MUST stay in sync with packages/db's CHECKs.
 */

// ─── Clip kinds ──────────────────────────────────────────────────────────

export const VIDEO_CLIP_KINDS = ["generated", "uploaded_video", "still"] as const;
export type VideoClipKind = (typeof VIDEO_CLIP_KINDS)[number];

export const VIDEO_CLIP_KIND_LABELS: Record<VideoClipKind, string> = {
  generated: "AI shot",
  uploaded_video: "Your video",
  still: "Photo",
};

/** How a photo clip moves: held still, or a slow zoom made by ffmpeg (both free). "Animate" turns it into an AI shot instead. */
export const VIDEO_STILL_MOTIONS = ["hold", "slow_zoom"] as const;
export type VideoStillMotion = (typeof VIDEO_STILL_MOTIONS)[number];

/** A clip in the film is at most this long (the shots table's own limit). Longer videos are trimmed, or added twice with different trims. */
export const VIDEO_CLIP_MAX_SECONDS = 60;
export const VIDEO_CLIP_MIN_MS = 500;
export const VIDEO_PHOTO_DEFAULT_SECONDS = 4;

export const VIDEO_UPLOAD_KINDS = ["video", "photo"] as const;
export type VideoUploadKind = (typeof VIDEO_UPLOAD_KINDS)[number];

/** File types the upload route takes (checked again by ffprobe/sharp on the server). */
export const VIDEO_UPLOAD_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp"] as const;
export const VIDEO_UPLOAD_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;

// ─── Picture shape and export ────────────────────────────────────────────

export const VIDEO_STORYLINE_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type VideoStorylineAspect = (typeof VIDEO_STORYLINE_ASPECTS)[number];

export const VIDEO_STORYLINE_ASPECT_LABELS: Record<VideoStorylineAspect, string> = {
  "16:9": "Wide 16:9 (YouTube, TV)",
  "9:16": "Tall 9:16 (Reels, TikTok, Shorts)",
  "1:1": "Square 1:1",
};

export interface VideoExportPreset {
  id: "youtube_16_9" | "reels_9_16" | "square_1_1";
  label: string;
  aspect: VideoStorylineAspect;
  width: number;
  height: number;
}

export const VIDEO_EXPORT_PRESETS: readonly VideoExportPreset[] = [
  { id: "youtube_16_9", label: "YouTube 16:9 1080p", aspect: "16:9", width: 1920, height: 1080 },
  { id: "reels_9_16", label: "Reels / TikTok 9:16", aspect: "9:16", width: 1080, height: 1920 },
  { id: "square_1_1", label: "Square 1:1", aspect: "1:1", width: 1080, height: 1080 },
];
export type VideoExportPresetId = VideoExportPreset["id"];
const PRESET_IDS = VIDEO_EXPORT_PRESETS.map((p) => p.id) as [VideoExportPresetId, ...VideoExportPresetId[]];

export const VIDEO_EXPORT_FPS = [16, 24, 25, 30, 60] as const;
export type VideoExportFps = (typeof VIDEO_EXPORT_FPS)[number];

export const VIDEO_TITLE_MAX_CHARS = 200;
export const VIDEO_CREDITS_MAX_CHARS = 1_500;
export const VIDEO_CREDITS_MAX_LINES = 30;
export const VIDEO_TITLE_MIN_SECONDS = 1;
export const VIDEO_TITLE_MAX_SECONDS = 15;

export interface VideoTitleCard {
  text: string;
  seconds: number;
}

export interface VideoStorylineExportSettings {
  preset: VideoExportPresetId;
  fps: VideoExportFps;
  /** fill = crop to fill the frame; fit = show the whole picture (bars only when the shape is really different). */
  fit: "fill" | "fit";
  /** trim = drop the repeated picture where one AI shot continues from the last picture of the one before. */
  endFrame: "keep" | "trim";
  quality: "standard" | "high";
  opening: VideoTitleCard | null;
  credits: VideoTitleCard | null;
}

export function videoExportPreset(id: VideoExportPresetId): VideoExportPreset {
  return VIDEO_EXPORT_PRESETS.find((p) => p.id === id) ?? VIDEO_EXPORT_PRESETS[0]!;
}

export function videoExportPresetForAspect(aspect: string): VideoExportPreset {
  return VIDEO_EXPORT_PRESETS.find((p) => p.aspect === aspect) ?? VIDEO_EXPORT_PRESETS[0]!;
}

/** Removes control characters (newlines kept for credits) and trims; never lets anything but plain text through. */
export function cleanVideoTitleText(text: string, multiline: boolean, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  const noControls = text.replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, multiline ? "" : " ");
  let lines = noControls.split("\n").map((l) => l.replace(/ {2,}/g, " ").replace(/\s+$/g, ""));
  if (multiline) lines = lines.slice(0, VIDEO_CREDITS_MAX_LINES);
  return lines.join("\n").trim().slice(0, maxChars);
}

function readTitle(raw: unknown, multiline: boolean): VideoTitleCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === "string" ? cleanVideoTitleText(r.text, multiline, multiline ? VIDEO_CREDITS_MAX_CHARS : VIDEO_TITLE_MAX_CHARS) : "";
  if (!text) return null;
  const seconds = typeof r.seconds === "number" && Number.isFinite(r.seconds) ? r.seconds : 3;
  return { text, seconds: Math.min(VIDEO_TITLE_MAX_SECONDS, Math.max(VIDEO_TITLE_MIN_SECONDS, Math.round(seconds))) };
}

/** The stored jsonb, read strictly with defaults: the storyline's own shape, 30 fps, fit, keep, standard, no titles. */
export function readVideoExportSettings(raw: unknown, aspect: string): VideoStorylineExportSettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const preset = typeof r.preset === "string" && (PRESET_IDS as readonly string[]).includes(r.preset) ? (r.preset as VideoExportPresetId) : videoExportPresetForAspect(aspect).id;
  const fps = typeof r.fps === "number" && (VIDEO_EXPORT_FPS as readonly number[]).includes(r.fps) ? (r.fps as VideoExportFps) : 30;
  return {
    preset,
    fps,
    fit: r.fit === "fill" ? "fill" : "fit",
    endFrame: r.endFrame === "trim" ? "trim" : "keep",
    quality: r.quality === "high" ? "high" : "standard",
    opening: readTitle(r.opening, false),
    credits: readTitle(r.credits, true),
  };
}

/** The share (0-100, rounded) of each picture thrown away when a picture of one shape is cropped to fill another. */
export function videoCropLossPercent(source: { width: number; height: number }, target: { width: number; height: number }): number {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) return 0;
  const s = source.width / source.height;
  const t = target.width / target.height;
  const kept = s > t ? t / s : s / t;
  return Math.round((1 - kept) * 100);
}

export function videoAspectSize(aspect: string): { width: number; height: number } {
  const preset = videoExportPresetForAspect(aspect);
  return { width: preset.width, height: preset.height };
}

const titleSchema = z
  .object({
    text: z.string().max(VIDEO_CREDITS_MAX_CHARS),
    seconds: z.number().int().min(VIDEO_TITLE_MIN_SECONDS).max(VIDEO_TITLE_MAX_SECONDS),
  })
  .strict();

export const updateVideoExportSettingsSchema = z
  .object({
    preset: z.enum(PRESET_IDS).optional(),
    fps: z.union([z.literal(16), z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional(),
    fit: z.enum(["fill", "fit"]).optional(),
    endFrame: z.enum(["keep", "trim"]).optional(),
    quality: z.enum(["standard", "high"]).optional(),
    opening: titleSchema.nullable().optional(),
    credits: titleSchema.nullable().optional(),
  })
  .strict();
export type UpdateVideoExportSettingsInput = z.infer<typeof updateVideoExportSettingsSchema>;

/** "Export again": optionally new settings, then the film is put together again from the finished clips (no re-rendering). */
export const exportVideoStorylineSchema = z.object({ settings: updateVideoExportSettingsSchema.optional() }).strict();
export type ExportVideoStorylineInput = z.infer<typeof exportVideoStorylineSchema>;

export const updateVideoStorylineAspectSchema = z.object({ aspect: z.enum(VIDEO_STORYLINE_ASPECTS) }).strict();

// ─── Music lane ──────────────────────────────────────────────────────────

export const VIDEO_MUSIC_AUDIO_MODES = ["mix", "replace"] as const;
export type VideoMusicAudioMode = (typeof VIDEO_MUSIC_AUDIO_MODES)[number];

export const updateVideoMusicLaneSchema = z
  .object({
    /** A company file id (what Media Studio hands out) or an assets id; null clears the music. */
    musicFileId: z.string().uuid().nullable().optional(),
    trimInMs: z.number().int().min(0).max(3_600_000).optional(),
    trimOutMs: z.number().int().min(1).max(3_600_000).nullable().optional(),
    offsetMs: z.number().int().min(0).max(3_600_000).optional(),
    fadeInMs: z.number().int().min(0).max(30_000).optional(),
    fadeOutMs: z.number().int().min(0).max(30_000).optional(),
    volumeDb: z.number().int().min(-60).max(0).optional(),
    audioMode: z.enum(VIDEO_MUSIC_AUDIO_MODES).optional(),
  })
  .strict();
export type UpdateVideoMusicLaneInput = z.infer<typeof updateVideoMusicLaneSchema>;

export interface VideoMusicLane {
  musicAssetId: string | null;
  fileName: string | null;
  trimInMs: number;
  trimOutMs: number | null;
  offsetMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  volumeDb: number;
  audioMode: VideoMusicAudioMode;
}

export interface VideoMusicChoice {
  /** Pass this as musicFileId. */
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  /** "media_studio" = made in Media Studio (or attached to a task); "upload" = uploaded for a storyline. */
  source: "media_studio" | "upload";
}

// ─── Clips ───────────────────────────────────────────────────────────────

export const createVideoClipSchema = z
  .object({
    uploadId: z.string().uuid(),
    /** Put the clip right after this shot; omitted = at the end of the film. */
    afterShotId: z.string().uuid().nullable().optional(),
    trimInMs: z.number().int().min(0).optional(),
    trimOutMs: z.number().int().min(1).nullable().optional(),
    stillMotion: z.enum(VIDEO_STILL_MOTIONS).optional(),
    holdSeconds: z.number().int().min(1).max(VIDEO_CLIP_MAX_SECONDS).optional(),
  })
  .strict();
export type CreateVideoClipInput = z.infer<typeof createVideoClipSchema>;

export const updateVideoClipSchema = z
  .object({
    trimInMs: z.number().int().min(0).optional(),
    trimOutMs: z.number().int().min(1).nullable().optional(),
    stillMotion: z.enum(VIDEO_STILL_MOTIONS).optional(),
    holdSeconds: z.number().int().min(1).max(VIDEO_CLIP_MAX_SECONDS).optional(),
    muted: z.boolean().optional(),
    volumeDb: z.number().int().min(-60).max(12).optional(),
  })
  .strict();
export type UpdateVideoClipInput = z.infer<typeof updateVideoClipSchema>;

export const reorderVideoShotsSchema = z.object({ shotIds: z.array(z.string().uuid()).min(1).max(5_000) }).strict();
export type ReorderVideoShotsInput = z.infer<typeof reorderVideoShotsSchema>;

export const animateVideoClipSchema = z
  .object({
    /** What should move, in plain words (sent to the video model with the photo as the start picture). */
    prompt: z.string().trim().min(1).max(2_000),
    /** The cost the person saw; the server refuses if its own estimate is higher. */
    confirmCostCents: z.number().int().min(0),
  })
  .strict();
export type AnimateVideoClipInput = z.infer<typeof animateVideoClipSchema>;

export const updateVideoUploadConsentSchema = z
  .object({
    showsPeople: z.boolean(),
    consentLikeness: z.boolean(),
    consentAdults: z.boolean(),
  })
  .strict();
export type UpdateVideoUploadConsentInput = z.infer<typeof updateVideoUploadConsentSchema>;

export const VIDEO_UPLOAD_CONSENT_LIKENESS_LABEL = "Everyone shown has agreed to their likeness being used in AI-made video.";
export const VIDEO_UPLOAD_CONSENT_ADULTS_LABEL = "Everyone shown is an adult (18 or older).";
export const VIDEO_UPLOAD_CONSENT_EXPLANATION =
  "Your photos and videos are only ever sent to an AI service when you ask for something that needs it (an AI bridge next to the clip, or animating a photo). Before that, every picture is checked for apparent age, and pictures of people also need both ticks.";

export interface VideoUploadSummary {
  id: string;
  kind: VideoUploadKind;
  status: "processing" | "ready" | "failed";
  fileName: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  byteSize: number;
  wasHdr: boolean;
  wasVariableFrameRate: boolean;
  hasAudio: boolean;
  showsPeople: boolean;
  consentLikeness: boolean;
  consentAdults: boolean;
  error: string | null;
  inUse: boolean;
  createdAt: string;
}

// ─── Per-company settings (Media Studio's company settings row) ──────────

export const MEDIA_FOOTAGE_SETTINGS_KEYS = {
  storageQuotaBytes: "mediaStorageQuotaBytes",
  maxVideoMb: "mediaUploadMaxVideoMb",
  maxPhotoMb: "mediaUploadMaxPhotoMb",
  maxVideoSeconds: "mediaUploadMaxVideoSeconds",
  cleanupDays: "mediaUnchosenCleanupDays",
  neverSendUploadsToSogni: "neverSendUploadsToSogni",
} as const;

export interface MediaFootageSettings {
  storageQuotaBytes: number;
  maxVideoMb: number;
  maxPhotoMb: number;
  maxVideoSeconds: number;
  cleanupDays: number;
  neverSendUploadsToSogni: boolean;
}

/** Upper limits no company setting can go past (the server box is shared). */
export const MEDIA_FOOTAGE_HARD_LIMITS = {
  storageQuotaBytes: 200 * 1024 ** 3,
  maxVideoMb: 1_024,
  maxPhotoMb: 50,
  maxVideoSeconds: 3_600,
  cleanupDays: 365,
} as const;

export const MEDIA_FOOTAGE_DEFAULTS: MediaFootageSettings = {
  storageQuotaBytes: 5 * 1024 ** 3,
  maxVideoMb: 300,
  maxPhotoMb: 20,
  maxVideoSeconds: 600,
  cleanupDays: 14,
  neverSendUploadsToSogni: true,
};

export const MEDIA_FOOTAGE_EXPLANATIONS: Record<keyof MediaFootageSettings, string> = {
  storageQuotaBytes: "How much space this company's uploaded photos and videos may take in total, across all storylines.",
  maxVideoMb: "The largest video file one person can upload, in megabytes.",
  maxPhotoMb: "The largest photo one person can upload, in megabytes.",
  maxVideoSeconds: "The longest video that can be uploaded, in seconds. Each clip in a film is at most 60 seconds; use a longer video by adding it more than once with different trims.",
  cleanupDays: "Uploads that are not used in any film, and AI transition versions nobody picked, are deleted after this many days to free space. The ones you use are always kept.",
  neverSendUploadsToSogni:
    "Sogni runs AI jobs on a shared network of other people's computers. With this on (recommended), your own photos and videos, and pictures taken from them, are never sent to Sogni. Fal.ai is told not to keep them.",
};

export const updateMediaFootageSettingsSchema = z
  .object({
    storageQuotaBytes: z.number().int().min(0).max(MEDIA_FOOTAGE_HARD_LIMITS.storageQuotaBytes).optional(),
    maxVideoMb: z.number().int().min(1).max(MEDIA_FOOTAGE_HARD_LIMITS.maxVideoMb).optional(),
    maxPhotoMb: z.number().int().min(1).max(MEDIA_FOOTAGE_HARD_LIMITS.maxPhotoMb).optional(),
    maxVideoSeconds: z.number().int().min(5).max(MEDIA_FOOTAGE_HARD_LIMITS.maxVideoSeconds).optional(),
    cleanupDays: z.number().int().min(1).max(MEDIA_FOOTAGE_HARD_LIMITS.cleanupDays).optional(),
    neverSendUploadsToSogni: z.boolean().optional(),
  })
  .strict();
export type UpdateMediaFootageSettingsInput = z.infer<typeof updateMediaFootageSettingsSchema>;

/** Reads the stored settings with defaults, clamped to the hard limits. */
export function readMediaFootageSettings(settingsJson: Record<string, unknown> | null | undefined): MediaFootageSettings {
  const s = settingsJson ?? {};
  const int = (key: string, fallback: number, max: number, min = 0) => {
    const v = s[key];
    return typeof v === "number" && Number.isInteger(v) && v >= min ? Math.min(max, v) : fallback;
  };
  const K = MEDIA_FOOTAGE_SETTINGS_KEYS;
  const D = MEDIA_FOOTAGE_DEFAULTS;
  const H = MEDIA_FOOTAGE_HARD_LIMITS;
  return {
    storageQuotaBytes: int(K.storageQuotaBytes, D.storageQuotaBytes, H.storageQuotaBytes),
    maxVideoMb: int(K.maxVideoMb, D.maxVideoMb, H.maxVideoMb, 1),
    maxPhotoMb: int(K.maxPhotoMb, D.maxPhotoMb, H.maxPhotoMb, 1),
    maxVideoSeconds: int(K.maxVideoSeconds, D.maxVideoSeconds, H.maxVideoSeconds, 5),
    cleanupDays: int(K.cleanupDays, D.cleanupDays, H.cleanupDays, 1),
    // On unless an owner/admin explicitly switched it off.
    neverSendUploadsToSogni: s[K.neverSendUploadsToSogni] !== false,
  };
}
