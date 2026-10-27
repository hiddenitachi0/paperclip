import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/**
 * D18 (owner's decision, 27 Oct): long videos must not be stopped by the 25 MB file
 * limit. Video files -- finished storyline films, and videos saved to the
 * company's Files or to a task (made by Media Studio, or uploaded) -- get
 * their own per-file limit: 2 GB by default, set per company in Media
 * Studio's settings, never above the server's ceiling
 * (PAPERCLIP_VIDEO_FILE_MAX_BYTES, 4 GB at most). Every other kind of file
 * keeps the company's ordinary attachment limit.
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

/**
 * Media Studio's per-company settings as the server applies them. A company
 * without the plugin (or without a settings row) gets the defaults.
 */
export async function readCompanyMediaFootageSettings(db: Pick<Db, "select">, companyId: string): Promise<MediaFootageSettings> {
  const [row] = await db
    .select({ settingsJson: pluginCompanySettings.settingsJson })
    .from(pluginCompanySettings)
    .innerJoin(plugins, eq(plugins.id, pluginCompanySettings.pluginId))
    .where(and(eq(plugins.pluginKey, MEDIA_STUDIO_PLUGIN_KEY), eq(pluginCompanySettings.companyId, companyId)))
    .limit(1);
  return applyInstanceVideoCeiling(readMediaFootageSettings((row?.settingsJson ?? null) as Record<string, unknown> | null));
}

/** One company's per-file limit for video files, in bytes. */
export async function companyVideoFileMaxBytes(db: Pick<Db, "select">, companyId: string): Promise<number> {
  const settings = await readCompanyMediaFootageSettings(db, companyId);
  return normalizeVideoFileMaxBytes(settings.maxVideoFileMb * MB);
}

export interface CompanyFileLimits {
  /** Every file that is not a video (unchanged by D18). */
  attachmentMaxBytes: number;
  /** Video files: finished films, Media Studio videos, uploaded videos. */
  videoFileMaxBytes: number;
}

/** Both per-file limits for a company: its ordinary attachment limit and its video limit. */
export async function companyFileLimits(
  db: Pick<Db, "select">,
  companyId: string,
  company: { attachmentMaxBytes?: number | null } | null | undefined,
): Promise<CompanyFileLimits> {
  return {
    attachmentMaxBytes: normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes),
    videoFileMaxBytes: await companyVideoFileMaxBytes(db, companyId),
  };
}
