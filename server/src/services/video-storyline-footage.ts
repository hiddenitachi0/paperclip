import { createHash } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, issueAttachments, videoMediaSpend, videoShots, videoStorylines, videoTransitionTakes, videoUploads } from "@paperclipai/db";
import {
  MEDIA_FOOTAGE_SETTINGS_KEYS,
  MEDIA_STUDIO_PLUGIN_KEY,
  readMediaFootageSettings,
  type MediaFootageSettings,
  type UpdateMediaFootageSettingsInput,
  type VideoMusicLane,
  type VideoUploadSummary,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { loadCastAgeRefusals, readPluginState } from "./storyline-cast.js";
import { storylineCompanyModel } from "./video-storyline-company-model.js";
import type { HelperServiceOptions } from "./helper.js";
import type { VideoStorylineActor } from "./video-storylines.js";

/**
 * Storyline Simple editor, Phase 2 (design 2.5): the company's own footage.
 *
 * Plain clips that are only stitched never leave the server. Anything taken
 * from an upload -- the photo itself, or a frame of a video -- may be sent to
 * a cloud model or video service ONLY after it passes:
 *   1. the per-company Sogni rule ("Never send uploaded footage to Sogni",
 *      on by default) when the target is Sogni;
 *   2. the age check (Media Studio's existing check, by picture hash, never
 *      milder; a refusal Media Studio already stored for the same picture
 *      counts too), with the "no people" outcome for scenery;
 *   3. when people are shown, both consent ticks on the upload.
 * Fal requests that carry footage are sent with storeIO:false
 * (X-Fal-Store-IO: 0).
 */

type UploadRow = typeof videoUploads.$inferSelect;
type ShotRow = typeof videoShots.$inferSelect;

export type FootageVerdict = "adult" | "no_people" | "under18" | "unclear";

export const NO_READER_MESSAGE =
  "This company has no picture-reading AI set up, so this transition was written from the script only. Add one in Settings so the AI can look at the real clips (Media Studio → Identities → analysis model, or a helper model that can see pictures).";

export const FOOTAGE_NO_CHECKER_MESSAGE =
  "Your own photos and videos are checked for apparent age before they are sent to an AI service, and this company has no AI that can look at pictures yet. Pick one in Media Studio → Identities → analysis model (or a helper model that can see pictures), then try again.";

/** Age-check answer with the "no people" outcome (design 2.5). Unreadable = null (never cached). */
export function parseFrameAgeCheck(text: string): FootageVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (raw.peopleShown === false) return "no_people";
    if (raw.apparentAdult === true && raw.peopleShown !== null) return "adult";
    if (raw.apparentAdult === false) return "under18";
    return "unclear";
  } catch {
    return null;
  }
}

export const FOOTAGE_AGE_CHECK_SYSTEM = [
  "You check a picture before it is sent to an AI video service.",
  "Never say or guess who anyone is. Do not describe the picture.",
  'Answer with exactly this JSON and nothing else: {"peopleShown": true, "apparentAdult": true}',
  "peopleShown: false only when no person (or part of a person) is visible.",
  "apparentAdult: true only when every person shown clearly looks 18 or older; false when anyone looks under 18; null when you are unsure.",
].join("\n");
const FOOTAGE_AGE_CHECK_USER = 'Check this picture. Answer only {"peopleShown": true|false, "apparentAdult": true|false|null}.';

const SEVERITY: Record<FootageVerdict, number> = { adult: 0, no_people: 0, unclear: 1, under18: 2 };

/** The stricter of two verdicts: a stored result never gets milder. */
export function stricterVerdict(a: FootageVerdict | null, b: FootageVerdict | null): FootageVerdict | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The bytes of a data: URI (base64), or null. */
export function dataUriBytes(dataUri: string): Buffer | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(dataUri);
  return match?.[1] ? Buffer.from(match[1], "base64") : null;
}

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * This month's media spend for a company (the monthly cap): AI transition
 * takes plus other paid steps (animate photo). A failed or released item
 * counts only what it really cost.
 */
export async function companyMonthlyMediaSpendCents(executor: Pick<Db, "select">, companyId: string, now: Date): Promise<number> {
  const since = startOfMonthUtc(now);
  const [takes] = await executor
    .select({
      total: sql<number>`coalesce(sum(case when ${videoTransitionTakes.status} = 'failed' then coalesce(${videoTransitionTakes.costCents}, 0) else coalesce(${videoTransitionTakes.costCents}, ${videoTransitionTakes.reservedCents}) end), 0)::int`,
    })
    .from(videoTransitionTakes)
    .where(and(eq(videoTransitionTakes.companyId, companyId), gte(videoTransitionTakes.createdAt, since)));
  const [other] = await executor
    .select({
      total: sql<number>`coalesce(sum(case when ${videoMediaSpend.status} = 'released' then coalesce(${videoMediaSpend.costCents}, 0) when ${videoMediaSpend.status} = 'settled' then coalesce(${videoMediaSpend.costCents}, ${videoMediaSpend.reservedCents}) else ${videoMediaSpend.reservedCents} end), 0)::int`,
    })
    .from(videoMediaSpend)
    .where(and(eq(videoMediaSpend.companyId, companyId), gte(videoMediaSpend.createdAt, since)));
  return Number(takes?.total ?? 0) + Number(other?.total ?? 0);
}

export function uploadByteSize(row: Pick<UploadRow, "rawByteSize" | "workingByteSize" | "previewByteSize" | "posterByteSize">): number {
  return Number(row.rawByteSize) + Number(row.workingByteSize) + Number(row.previewByteSize) + Number(row.posterByteSize);
}

export function toUploadSummary(row: UploadRow, inUse: boolean): VideoUploadSummary {
  return {
    id: row.id,
    kind: row.kind as VideoUploadSummary["kind"],
    status: row.status as VideoUploadSummary["status"],
    fileName: row.originalFilename,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    byteSize: uploadByteSize(row),
    wasHdr: row.wasHdr,
    wasVariableFrameRate: row.wasVariableFrameRate,
    hasAudio: row.hasAudio,
    showsPeople: row.showsPeople,
    consentLikeness: row.consentLikeness,
    consentAdults: row.consentAdults,
    error: row.error,
    inUse,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface FootageDeps {
  now?: () => Date;
  modelOptions?: HelperServiceOptions;
}

export type PictureReader = { entryId: string | null; keySecretId: string | null; label: string; provider: string };

export function videoStorylineFootageService(db: Db, deps: FootageDeps = {}) {
  const registry = pluginRegistryService(db);
  const models = storylineCompanyModel(db, deps.modelOptions);
  const nowOf = () => deps.now?.() ?? new Date();

  async function pluginId(): Promise<string | null> {
    return (await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY))?.id ?? null;
  }

  // ─── Per-company settings ───

  async function getSettings(companyId: string): Promise<MediaFootageSettings> {
    const id = await pluginId();
    if (!id) return readMediaFootageSettings(null);
    const row = await registry.getCompanySettings(id, companyId);
    return readMediaFootageSettings((row?.settingsJson ?? null) as Record<string, unknown> | null);
  }

  async function setSettings(companyId: string, patch: UpdateMediaFootageSettingsInput): Promise<MediaFootageSettings> {
    const id = await pluginId();
    if (!id) throw notFound("The media-studio plugin is not installed.");
    const existing = await registry.getCompanySettings(id, companyId);
    const next: Record<string, unknown> = { ...((existing?.settingsJson ?? {}) as Record<string, unknown>) };
    for (const [field, key] of Object.entries(MEDIA_FOOTAGE_SETTINGS_KEYS) as Array<[keyof MediaFootageSettings, string]>) {
      if (patch[field] !== undefined) next[key] = patch[field];
    }
    await registry.upsertCompanySettings(id, companyId, { settingsJson: next });
    return readMediaFootageSettings(next);
  }

  // ─── The picture-reading model (age check, transition context) ───

  /**
   * Media Studio's picture-reading model, else the helper's default if it can
   * see pictures, else (no helper default) the helper's built-in default
   * under the helper's own key rule, else a plain reason.
   */
  async function pictureReader(companyId: string): Promise<PictureReader | { problem: string }> {
    const id = await pluginId();
    const raw = id ? ((await readPluginState(db, id, companyId, "identitySettings")) as Record<string, unknown> | null) : null;
    const analysis = raw && typeof raw.analysis === "object" && raw.analysis ? (raw.analysis as Record<string, unknown>) : null;
    const entryId = typeof analysis?.entryId === "string" ? analysis.entryId : null;
    if (entryId) {
      const entry = await models.resolveEntry(companyId, entryId);
      if (entry) {
        return { entryId: entry.id, keySecretId: typeof analysis?.keySecretId === "string" ? analysis.keySecretId : null, label: entry.name, provider: entry.provider };
      }
    }
    const helperDefault = await models.canSeePictures(companyId, null);
    if (helperDefault) {
      if (helperDefault.canSee === true) {
        const entry = await models.resolveEntry(companyId, helperDefault.entryId);
        if (entry) return { entryId: entry.id, keySecretId: null, label: entry.name, provider: entry.provider };
      }
      return { problem: NO_READER_MESSAGE };
    }
    const builtIn = await models.builtInDefault(companyId);
    if (builtIn?.canSeePictures) return { entryId: null, keySecretId: null, label: builtIn.label, provider: "anthropic" };
    return { problem: NO_READER_MESSAGE };
  }

  // ─── Uploads ───

  async function getUpload(companyId: string, uploadId: string): Promise<UploadRow> {
    const [row] = await db.select().from(videoUploads).where(and(eq(videoUploads.id, uploadId), eq(videoUploads.companyId, companyId)));
    if (!row) throw notFound("That upload is not in this company.");
    return row;
  }

  async function storageUsedBytes(companyId: string): Promise<number> {
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${videoUploads.rawByteSize} + ${videoUploads.workingByteSize} + ${videoUploads.previewByteSize} + ${videoUploads.posterByteSize}), 0)::bigint`,
      })
      .from(videoUploads)
      .where(eq(videoUploads.companyId, companyId));
    return Number(row?.total ?? 0);
  }

  function shotLabel(shot: Pick<ShotRow, "orderIndex">): string {
    return `Clip ${shot.orderIndex + 1}`;
  }

  /** Plain reason the upload's consent is missing for people shown, else null. */
  function consentProblem(upload: UploadRow, shot: Pick<ShotRow, "orderIndex">, peopleSeen: boolean): string | null {
    if (!(upload.showsPeople || peopleSeen)) return null;
    if (upload.consentLikeness && upload.consentAdults) return null;
    return `${shotLabel(shot)} is your own footage and shows people. Before any of it is sent to an AI service, tick both boxes on that clip: everyone shown agreed to their likeness being used, and everyone shown is an adult.`;
  }

  /** The age-check verdict for one picture of an upload: stored, refused by Media Studio already, or checked now. */
  async function verdictFor(companyId: string, upload: UploadRow, bytes: Buffer, actor: Pick<VideoStorylineActor, "actorType" | "actorId"> | null): Promise<FootageVerdict> {
    const hash = sha256Hex(bytes);
    const stored = (upload.ageChecks ?? {})[hash]?.verdict as FootageVerdict | undefined;
    const refusals = await loadCastAgeRefusals(db, await pluginId(), companyId);
    const pluginRefused: FootageVerdict | null = refusals.hashes.has(hash) ? "unclear" : null;
    if (stored) return stricterVerdict(stored, pluginRefused) ?? stored;
    if (pluginRefused) return pluginRefused;
    const reader = await pictureReader(companyId);
    if ("problem" in reader) throw unprocessable(FOOTAGE_NO_CHECKER_MESSAGE);
    const answer = await models.write(companyId, actor, {
      purpose: "Checking your own footage",
      noModelMessage: FOOTAGE_NO_CHECKER_MESSAGE,
      billingCode: "video_storyline_footage_age_check",
      entryId: reader.entryId,
      keySecretId: reader.keySecretId,
      keyConsumerId: MEDIA_STUDIO_PLUGIN_KEY,
      system: FOOTAGE_AGE_CHECK_SYSTEM,
      user: FOOTAGE_AGE_CHECK_USER,
      images: [{ contentType: "image/jpeg", base64: bytes.toString("base64") }],
      maxTokens: 60,
    });
    const verdict = parseFrameAgeCheck(answer.text);
    if (!verdict) {
      throw unprocessable("The age check's answer could not be read, so nothing was sent. Try again, or pick another picture-reading model in Media Studio.");
    }
    // Never milder: re-read and merge under the row, keyed by picture hash.
    const [current] = await db.select({ ageChecks: videoUploads.ageChecks }).from(videoUploads).where(eq(videoUploads.id, upload.id));
    const merged = { ...(current?.ageChecks ?? {}) };
    const final = stricterVerdict((merged[hash]?.verdict as FootageVerdict | undefined) ?? null, verdict) ?? verdict;
    merged[hash] = { verdict: final, at: nowOf().toISOString(), model: answer.modelLabel ?? reader.label };
    await db.update(videoUploads).set({ ageChecks: merged, updatedAt: nowOf() }).where(eq(videoUploads.id, upload.id));
    upload.ageChecks = merged;
    return final;
  }

  /**
   * The gate before a picture taken from this clip leaves the server.
   * Returns { footage: false } for AI-made clips (nothing to check), else
   * checks the Sogni rule, the age check and consent, throwing a plain 422
   * when any fails. `bytes` is the exact picture that would be sent.
   */
  async function assertMaySend(
    companyId: string,
    shot: Pick<ShotRow, "sourceUploadId" | "orderIndex">,
    target: "fal" | "sogni" | "reader",
    bytes: Buffer,
    actor: Pick<VideoStorylineActor, "actorType" | "actorId"> | null,
  ): Promise<{ footage: boolean }> {
    if (!shot.sourceUploadId) return { footage: false };
    const upload = await getUpload(companyId, shot.sourceUploadId);
    if (target === "sogni" && (await getSettings(companyId)).neverSendUploadsToSogni) {
      throw unprocessable(
        `${shotLabel(shot)} is your own footage, and this company never sends uploaded footage to Sogni (Media Studio settings). Use Fal.ai for this storyline, use a Cut or Smooth blend here, or an owner or admin can change that setting.`,
      );
    }
    const early = consentProblem(upload, shot, false);
    if (early) throw unprocessable(early);
    const verdict = await verdictFor(companyId, upload, bytes, actor);
    if (verdict === "under18" || verdict === "unclear") {
      throw unprocessable(
        `${shotLabel(shot)} did not pass the age check (only pictures clearly of adults, or with no people at all, are ever sent to an AI service), so nothing was sent. Use a Cut or Smooth blend next to it, or use different footage.`,
      );
    }
    const late = consentProblem(upload, shot, verdict === "adult");
    if (late) throw unprocessable(late);
    return { footage: true };
  }

  /** Same rules, as a yes/no for the picture-reading model's transition context (it falls back to the script). */
  async function readerRefusal(companyId: string, shot: Pick<ShotRow, "sourceUploadId" | "orderIndex">): Promise<string | null> {
    if (!shot.sourceUploadId) return null;
    const upload = await db.select().from(videoUploads).where(and(eq(videoUploads.id, shot.sourceUploadId), eq(videoUploads.companyId, companyId)));
    if (!upload[0]) return "The clip's upload is gone, so its frames were not read.";
    return consentProblem(upload[0], shot, false);
  }

  // ─── Music ───

  /** A company file id (issue attachment) or assets id -> the assets row, if it is this company's audio. */
  async function resolveMusicAsset(companyId: string, fileOrAssetId: string): Promise<typeof assets.$inferSelect> {
    const [direct] = await db.select().from(assets).where(and(eq(assets.id, fileOrAssetId), eq(assets.companyId, companyId)));
    let asset = direct ?? null;
    if (!asset) {
      const [viaFile] = await db
        .select({ asset: assets })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(and(eq(issueAttachments.id, fileOrAssetId), eq(issueAttachments.companyId, companyId), eq(assets.companyId, companyId)));
      asset = viaFile?.asset ?? null;
    }
    if (!asset) throw notFound("That music file is not in this company.");
    if (!asset.contentType.toLowerCase().startsWith("audio/")) throw unprocessable("That file is not a sound file. Pick an MP3, WAV, M4A or similar.");
    return asset;
  }

  async function musicLane(companyId: string, storyline: typeof videoStorylines.$inferSelect): Promise<VideoMusicLane> {
    let fileName: string | null = null;
    if (storyline.musicAssetId) {
      const [row] = await db
        .select({ name: assets.originalFilename })
        .from(assets)
        .where(and(eq(assets.id, storyline.musicAssetId), eq(assets.companyId, companyId)));
      fileName = row?.name ?? "Music";
    }
    return {
      musicAssetId: storyline.musicAssetId,
      fileName,
      trimInMs: storyline.musicTrimInMs,
      trimOutMs: storyline.musicTrimOutMs,
      offsetMs: storyline.musicOffsetMs,
      fadeInMs: storyline.musicFadeInMs,
      fadeOutMs: storyline.musicFadeOutMs,
      volumeDb: storyline.musicVolumeDb,
      audioMode: storyline.musicAudioMode === "replace" ? "replace" : "mix",
    };
  }

  async function uploadsFor(companyId: string, storylineId: string): Promise<VideoUploadSummary[]> {
    const rows = await db.select().from(videoUploads).where(and(eq(videoUploads.storylineId, storylineId), eq(videoUploads.companyId, companyId)));
    if (rows.length === 0) return [];
    const used = await db
      .select({ id: videoShots.sourceUploadId })
      .from(videoShots)
      .where(and(eq(videoShots.companyId, companyId), inArray(videoShots.sourceUploadId, rows.map((r) => r.id))));
    const inUse = new Set(used.map((u) => u.id));
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => toUploadSummary(r, inUse.has(r.id)));
  }

  return {
    getSettings,
    setSettings,
    pictureReader,
    getUpload,
    storageUsedBytes,
    assertMaySend,
    readerRefusal,
    resolveMusicAsset,
    musicLane,
    uploadsFor,
    monthlySpentCents: (companyId: string) => companyMonthlyMediaSpendCents(db, companyId, nowOf()),
  };
}
