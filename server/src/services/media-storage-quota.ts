import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, videoUploads } from "@paperclipai/db";
import { HttpError } from "../errors.js";

/**
 * One storage limit per company for its media (Media Studio's "Storage
 * limit", `storageQuotaBytes`): storyline uploads, storyline music, and
 * (security review of D18, F2) every video kept on a task or in Files that
 * is larger than the company's ordinary file limit. All checks take the same
 * per-company lock, so two uploads at once cannot both fit the last free
 * space (security review DUR-4745).
 */

/** Where music uploaded for storylines is stored (counted in the company's footage quota). */
export const STORYLINE_MUSIC_NAMESPACE = "video-storylines/music";

/**
 * D18 (security review F2): a video on a task or in Files that is larger than
 * the company's ordinary file limit is stored under this prefix, so it is
 * counted in the company's media storage limit by where it is kept, whatever
 * the ordinary limit is later changed to.
 */
export const LARGE_VIDEO_NAMESPACE = "large-videos";

/** The storage namespace for a large video that would otherwise go to `namespace` (issues/<id>, company-files, files). */
export function largeVideoNamespace(namespace: string): string {
  return `${LARGE_VIDEO_NAMESPACE}/${namespace}`;
}

/**
 * Everything the company's media storage limit counts: its storyline uploads
 * (raw, working, preview, poster), music files uploaded for storylines
 * (security review DUR-4745: music used to sit outside the quota), and large
 * videos kept on tasks or in Files (D18).
 */
export async function companyStorageUsedBytes(executor: Pick<Db, "select">, companyId: string): Promise<number> {
  const [uploads] = await executor
    .select({
      total: sql<number>`coalesce(sum(${videoUploads.rawByteSize} + ${videoUploads.workingByteSize} + ${videoUploads.previewByteSize} + ${videoUploads.posterByteSize}), 0)::bigint`,
    })
    .from(videoUploads)
    .where(eq(videoUploads.companyId, companyId));
  const [files] = await executor
    .select({ total: sql<number>`coalesce(sum(${assets.byteSize}), 0)::bigint` })
    .from(assets)
    .where(
      and(
        eq(assets.companyId, companyId),
        or(
          sql`${assets.objectKey} like ${`${companyId}/${STORYLINE_MUSIC_NAMESPACE}/%`}`,
          sql`${assets.objectKey} like ${`${companyId}/${LARGE_VIDEO_NAMESPACE}/%`}`,
        ),
      ),
    );
  return Number(uploads?.total ?? 0) + Number(files?.total ?? 0);
}

/** Holds the company's media storage lock until the surrounding transaction ends. */
export async function lockCompanyMediaStorage(tx: Pick<Db, "execute">, companyId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video_upload_quota:${companyId}`}, 0))`);
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Refuses (413, in plain words) a large video that would take the company
 * past its media storage limit. Inside a transaction, pass `lock: true` and
 * insert the file's row in the same transaction, so the check and the row
 * cannot be split by another upload; without the lock it is a quick early
 * check before a long file is copied into storage.
 */
export async function assertRoomForLargeVideo(
  executor: Pick<Db, "select" | "execute">,
  companyId: string,
  incomingBytes: number,
  quotaBytes: number,
  opts: { lock: boolean },
): Promise<void> {
  if (opts.lock) await lockCompanyMediaStorage(executor, companyId);
  const usedBytes = await companyStorageUsedBytes(executor, companyId);
  if (usedBytes + incomingBytes > quotaBytes) {
    throw new HttpError(
      413,
      `This video would bring the company's videos and uploads to ${gb(usedBytes + incomingBytes)}, over its ${gb(quotaBytes)} storage limit. ` +
        `Remove large videos or uploads you no longer use, or ask an owner or admin to raise "Storage limit" in Media Studio's settings.`,
    );
  }
}
