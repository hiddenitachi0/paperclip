import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginCompanySettings, plugins } from "@paperclipai/db";
import {
  MEDIA_FOOTAGE_HARD_LIMITS,
  MEDIA_STUDIO_PLUGIN_KEY,
  readMediaFootageSettings,
  type MediaFootageSettings,
} from "@paperclipai/shared";
import { MAX_VIDEO_FILE_BYTES, normalizeIssueAttachmentMaxBytes, normalizeVideoFileMaxBytes } from "../attachment-types.js";
import { sniffVideoContainer, verifyVideoFile } from "./video-ffmpeg.js";

/**
 * D18 (owner's decision, 27 Oct): long videos must not be stopped by the 25 MB file
 * limit. Media Studio's video files -- finished storyline films and footage
 * uploaded to a storyline -- get their own per-file limit: 2 GB by default,
 * set per company in Media Studio's settings, never above the server's
 * ceiling (PAPERCLIP_VIDEO_FILE_MAX_BYTES, 4 GB at most).
 *
 * Security review of D18 (F1): videos on a task or in the company's Files
 * keep the company's ordinary attachment limit (and the operator's
 * PAPERCLIP_ATTACHMENT_MAX_BYTES ceiling) unless BOTH
 *   - the operator opted in for this server (PAPERCLIP_LARGE_VIDEO_ATTACHMENTS=true), and
 *   - Media Studio is installed and switched on for that company (see readMediaStudioForCompany).
 * Then a video may go up to the company's Media Studio video limit, counted
 * against its Media Studio storage limit (F2). Every other kind of file
 * always keeps the ordinary limit.
 */

const MB = 1024 * 1024;

/**
 * Where large media work files go while they are being made or received
 * (a big video upload spooled to disk, the clips and output of a film being
 * combined): PAPERCLIP_MEDIA_WORK_DIR when set, else the system temp folder.
 * Point it at a folder on the data volume when the temp folder is small.
 */
export async function mediaWorkDir(): Promise<string> {
  const configured = process.env.PAPERCLIP_MEDIA_WORK_DIR?.trim();
  if (!configured) return tmpdir();
  await mkdir(configured, { recursive: true });
  return configured;
}

/** The server's ceiling for one video file, in whole megabytes. */
export function instanceVideoFileMaxMb(): number {
  return Math.floor(MAX_VIDEO_FILE_BYTES / MB);
}

/** The footage settings' upper limits as this server applies them (the video limits under its ceiling). */
export function mediaFootageHardLimits(): typeof MEDIA_FOOTAGE_HARD_LIMITS {
  const ceiling = instanceVideoFileMaxMb();
  return {
    ...MEDIA_FOOTAGE_HARD_LIMITS,
    maxVideoMb: Math.min(MEDIA_FOOTAGE_HARD_LIMITS.maxVideoMb, ceiling),
    maxVideoFileMb: Math.min(MEDIA_FOOTAGE_HARD_LIMITS.maxVideoFileMb, ceiling),
  };
}

/** A company's stored settings, with its video limits brought under the server's ceiling. */
export function applyInstanceVideoCeiling(settings: MediaFootageSettings): MediaFootageSettings {
  const hard = mediaFootageHardLimits();
  return {
    ...settings,
    maxVideoMb: Math.min(settings.maxVideoMb, hard.maxVideoMb),
    maxVideoFileMb: Math.min(settings.maxVideoFileMb, hard.maxVideoFileMb),
  };
}

/** Truthy words an operator may use to switch a server option on. */
function envFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * The operator's opt-in (security review of D18, F1): with
 * PAPERCLIP_LARGE_VIDEO_ATTACHMENTS=true, companies with Media Studio switched
 * on may keep videos larger than their ordinary file limit on tasks and in
 * Files. Off when unset: tasks and Files keep the ordinary limit and
 * PAPERCLIP_ATTACHMENT_MAX_BYTES stays the ceiling for every file.
 */
export function largeVideoAttachmentsOptedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS);
}

export interface MediaStudioForCompany {
  /** Media Studio is installed and ready on this server, and switched on for this company. */
  enabled: boolean;
  /** The company's Media Studio settings as the server applies them (the defaults when it has none). */
  settings: MediaFootageSettings;
}

/**
 * Whether Media Studio is installed and switched on for a company, with its
 * settings. "On" needs all of: the plugin is installed and ready on this
 * server (not disabled, failed or uninstalled), and the company has its own
 * Media Studio settings row that is enabled -- the row an owner or admin
 * creates by saving Media Studio's settings or switching storylines on. A
 * company that never set Media Studio up has no row and counts as off here
 * (security review of D18, F1: such a company must keep its ordinary limit,
 * and could not lower a Media Studio limit it cannot open).
 */
export async function readMediaStudioForCompany(db: Pick<Db, "select">, companyId: string): Promise<MediaStudioForCompany> {
  const [row] = await db
    .select({ status: plugins.status, enabled: pluginCompanySettings.enabled, settingsJson: pluginCompanySettings.settingsJson })
    .from(pluginCompanySettings)
    .innerJoin(plugins, eq(plugins.id, pluginCompanySettings.pluginId))
    .where(and(eq(plugins.pluginKey, MEDIA_STUDIO_PLUGIN_KEY), eq(pluginCompanySettings.companyId, companyId)))
    .limit(1);
  const settings = applyInstanceVideoCeiling(readMediaFootageSettings((row?.settingsJson ?? null) as Record<string, unknown> | null));
  return { enabled: Boolean(row && row.status === "ready" && row.enabled === true), settings };
}

/**
 * Media Studio's per-company settings as the server applies them. A company
 * without the plugin (or without a settings row) gets the defaults.
 */
export async function readCompanyMediaFootageSettings(db: Pick<Db, "select">, companyId: string): Promise<MediaFootageSettings> {
  return (await readMediaStudioForCompany(db, companyId)).settings;
}

/**
 * One company's per-file limit for a finished storyline film, in bytes. Films
 * are made only behind Media Studio's storyline switch, so this is a Media
 * Studio video path (it never applies to tasks or Files).
 */
export async function companyVideoFileMaxBytes(db: Pick<Db, "select">, companyId: string): Promise<number> {
  const settings = await readCompanyMediaFootageSettings(db, companyId);
  return normalizeVideoFileMaxBytes(settings.maxVideoFileMb * MB);
}

export interface CompanyFileLimits {
  /** Every file that is not a video, and every video unless large videos are allowed here. */
  attachmentMaxBytes: number;
  /**
   * The most a video file may be. The same as `attachmentMaxBytes` unless
   * large videos are allowed for this company and this caller (see
   * companyFileLimits); never below it.
   */
  videoFileMaxBytes: number;
  /**
   * The company's media storage limit that a video larger than
   * `attachmentMaxBytes` counts against (Media Studio's "Storage limit");
   * null when large videos are not allowed here.
   */
  storageQuotaBytes: number | null;
}

/**
 * Who is saving a file to a task or to Files: a person or agent through the
 * upload routes, or a plugin through the host services. Only Media Studio's
 * own saves count as a Media Studio video path; any other plugin keeps the
 * ordinary limit.
 */
export type CompanyFileCaller = { kind: "upload" } | { kind: "plugin"; pluginKey: string };

/** True when a received file is larger than the ordinary limit, i.e. it only got in as a large video. */
export function isLargeVideoUpload(size: number, limits: CompanyFileLimits): boolean {
  return size > limits.attachmentMaxBytes;
}

/**
 * The per-file limits for a file saved to a task or to the company's Files.
 * Videos get the larger Media Studio limit only when the operator opted in
 * (largeVideoAttachmentsOptedIn), the company has Media Studio switched on
 * (readMediaStudioForCompany) and the caller is the upload routes or Media
 * Studio itself; otherwise every file keeps the ordinary limit.
 */
export async function companyFileLimits(
  db: Pick<Db, "select">,
  companyId: string,
  company: { attachmentMaxBytes?: number | null } | null | undefined,
  caller: CompanyFileCaller,
): Promise<CompanyFileLimits> {
  const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);
  const ordinary: CompanyFileLimits = { attachmentMaxBytes, videoFileMaxBytes: attachmentMaxBytes, storageQuotaBytes: null };
  if (!largeVideoAttachmentsOptedIn()) return ordinary;
  if (caller.kind === "plugin" && caller.pluginKey !== MEDIA_STUDIO_PLUGIN_KEY) return ordinary;
  const mediaStudio = await readMediaStudioForCompany(db, companyId);
  if (!mediaStudio.enabled) return ordinary;
  return {
    attachmentMaxBytes,
    videoFileMaxBytes: Math.max(attachmentMaxBytes, normalizeVideoFileMaxBytes(mediaStudio.settings.maxVideoFileMb * MB)),
    storageQuotaBytes: mediaStudio.settings.storageQuotaBytes,
  };
}

/**
 * verifyVideoFile for a large video held in memory (a Media Studio save
 * through the plugin host): its first bytes are checked first, then it is
 * written to the media work folder (owner-only, a name the server made),
 * checked with ffprobe and removed again.
 */
export async function verifyVideoBuffer(buffer: Buffer, verify: (filePath: string) => Promise<boolean> = verifyVideoFile): Promise<boolean> {
  if (!sniffVideoContainer(buffer.subarray(0, 16))) return false;
  const filePath = join(await mediaWorkDir(), `paperclip-video-check-${randomUUID()}`);
  try {
    await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    return await verify(filePath);
  } catch {
    return false;
  } finally {
    await rm(filePath, { force: true }).catch(() => undefined);
  }
}
