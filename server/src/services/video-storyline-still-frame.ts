import { buffer as streamToBuffer } from "node:stream/consumers";
import type { videoShots } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";

/**
 * DUR-4317/DUR-4320: turns an approved shot's stored storyboard still into a
 * data: URI for use as the real render's `startImage` -- see
 * video-storyline-render.ts's beginShotRender/renderPreview (where this wins
 * over the ordinary continuity frame) and video-storyline-stills.ts (which
 * writes the still this reads back). Deliberately its own tiny module,
 * rather than living in either of those two files, so neither one has to
 * import the other -- video-storyline-stills.ts already imports
 * video-storyline-render.ts's loadReferenceImages, and the reverse import
 * would make an ESM import cycle between them.
 *
 * Never throws: a storage read failure here falls back to the existing
 * continuity-frame behavior rather than blocking a render that was already
 * cleared to proceed, same "best effort" posture
 * video-storyline-render.ts's downloadClipFromStorage already has.
 */
export async function loadApprovedStillDataUri(companyId: string, shot: typeof videoShots.$inferSelect): Promise<string | undefined> {
  if (shot.storyboardStatus !== "approved" || !shot.stillObjectKey || !shot.stillProvider || !shot.stillContentType) {
    return undefined;
  }
  try {
    const storage = getStorageService();
    const object = await storage.getObject(companyId, shot.stillObjectKey);
    const bytes = await streamToBuffer(object.stream);
    return `data:${shot.stillContentType};base64,${bytes.toString("base64")}`;
  } catch (err) {
    logger.warn({ err, shotId: shot.id }, "video-storyline-still-frame: could not load an approved still, falling back to the ordinary continuity frame");
    return undefined;
  }
}
