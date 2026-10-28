import { HttpError } from "../errors.js";

/**
 * Large uploads in flight per company, on this server: storyline footage and
 * music (security review DUR-4745), and (D18 security review F2) videos on a
 * task or in Files once they pass the company's ordinary file limit. Each one
 * takes disk in the media work folder and again in storage while it is
 * copied, so a burst from one company could fill the shared disk. A third one
 * at the same time is asked to wait. The count is shared by all of these
 * uploads, so a company cannot get around it by spreading uploads over
 * different routes.
 */
export const UPLOADS_IN_FLIGHT_PER_COMPANY = 2;

export const UPLOAD_SLOTS_BUSY_MESSAGE = "Other uploads for this company are still going. Wait for them to finish, then try again.";

const uploadsInFlight = new Map<string, number>();

/**
 * Takes one of the company's upload slots. Returns the function that gives it
 * back (safe to call more than once), or null when the company already has
 * the maximum number of uploads going.
 */
export function tryTakeUploadSlot(companyId: string): (() => void) | null {
  const current = uploadsInFlight.get(companyId) ?? 0;
  if (current >= UPLOADS_IN_FLIGHT_PER_COMPANY) return null;
  uploadsInFlight.set(companyId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (uploadsInFlight.get(companyId) ?? 1) - 1;
    if (left <= 0) uploadsInFlight.delete(companyId);
    else uploadsInFlight.set(companyId, left);
  };
}

/** Runs `fn` holding one of the company's upload slots; 429 in plain words when none is free. */
export async function withUploadSlot<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const release = tryTakeUploadSlot(companyId);
  if (!release) throw new HttpError(429, UPLOAD_SLOTS_BUSY_MESSAGE);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** How many of the company's upload slots are taken right now (for tests and diagnostics). */
export function uploadSlotsInUse(companyId: string): number {
  return uploadsInFlight.get(companyId) ?? 0;
}
