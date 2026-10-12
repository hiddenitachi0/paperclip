import { z } from "zod";

/**
 * A storyline's Cast: the characters of the script, each optionally linked
 * to one of the company's saved Media Studio identities (a saved person with
 * face/body pictures, kept on Media Studio's Identities tab). A linked cast
 * member keeps the same face and body in every storyboard picture and every
 * video clip they appear in.
 *
 * Stored inside video_storylines.picture_settings (jsonb) next to the picture
 * service/model/look, so no new column is needed:
 *   picture_settings.cast      VideoStorylineCastMember[]
 *   picture_settings.shotCast  { [shotId]: castMemberId[] }  -- a person's own
 *                              pick of who is in a shot; a shot without an
 *                              entry uses the names found in its description.
 * The API returns both as `cast` on the storyline, never inside
 * `pictureSettings` (which only holds providerId/model/lookId).
 */

export const VIDEO_STORYLINE_MAX_CAST = 20;
export const VIDEO_CAST_NAME_MAX_LENGTH = 60;
export const VIDEO_CAST_DESCRIPTION_MAX_LENGTH = 500;

export interface VideoStorylineCastMember {
  /** Stable id within the storyline ("c1", "c2", ...). */
  id: string;
  /** The name the script uses ("Maja"). */
  name: string;
  /** Another name the script may use ("Maja Berg", "Mum"). */
  nickname: string | null;
  /** The script's description of the character, if it had one. */
  description: string | null;
  /** The company's Media Studio identity this character is, or null (not linked). */
  identityId: string | null;
}

export interface VideoStorylineCast {
  members: VideoStorylineCastMember[];
  /** Shots where a person picked the cast by hand: shot id -> cast member ids (may be empty: nobody). */
  shotCast: Record<string, string[]>;
}

const castId = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, "A cast id is letters, digits, dashes or underscores.");

export const videoStorylineCastMemberSchema = z
  .object({
    id: castId.optional(),
    name: z.string().trim().min(1, "Give the character a name.").max(VIDEO_CAST_NAME_MAX_LENGTH),
    nickname: z.string().trim().max(VIDEO_CAST_NAME_MAX_LENGTH).nullable().optional(),
    description: z.string().trim().max(VIDEO_CAST_DESCRIPTION_MAX_LENGTH).nullable().optional(),
    identityId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

/** PUT .../video-storylines/:id/cast -- replaces the cast list (shot picks of removed members are dropped). */
export const updateVideoStorylineCastSchema = z
  .object({
    members: z.array(videoStorylineCastMemberSchema).max(VIDEO_STORYLINE_MAX_CAST, `A storyline can have at most ${VIDEO_STORYLINE_MAX_CAST} cast members.`),
  })
  .strict();
export type UpdateVideoStorylineCastInput = z.infer<typeof updateVideoStorylineCastSchema>;

/** PUT .../video-storylines/:id/shots/:shotId/cast -- who is in this shot; null = find them from the shot's description again. */
export const updateVideoShotCastSchema = z
  .object({
    castIds: z.array(castId).max(VIDEO_STORYLINE_MAX_CAST).nullable(),
  })
  .strict();
export type UpdateVideoShotCastInput = z.infer<typeof updateVideoShotCastSchema>;

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** The cast as stored in picture_settings (anything unreadable is dropped). */
export function readVideoStorylineCast(pictureSettings: unknown): VideoStorylineCast {
  const raw = pictureSettings && typeof pictureSettings === "object" && !Array.isArray(pictureSettings) ? (pictureSettings as Record<string, unknown>) : {};
  const members: VideoStorylineCastMember[] = [];
  if (Array.isArray(raw.cast)) {
    for (const item of raw.cast) {
      const m = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const id = str(m?.id, 40);
      const name = str(m?.name, VIDEO_CAST_NAME_MAX_LENGTH);
      if (!m || !id || !name || members.some((x) => x.id === id)) continue;
      members.push({
        id,
        name,
        nickname: str(m.nickname, VIDEO_CAST_NAME_MAX_LENGTH),
        description: str(m.description, VIDEO_CAST_DESCRIPTION_MAX_LENGTH),
        identityId: str(m.identityId, 100),
      });
      if (members.length >= VIDEO_STORYLINE_MAX_CAST) break;
    }
  }
  const ids = new Set(members.map((m) => m.id));
  const shotCast: Record<string, string[]> = {};
  const rawShots = raw.shotCast && typeof raw.shotCast === "object" && !Array.isArray(raw.shotCast) ? (raw.shotCast as Record<string, unknown>) : {};
  for (const [shotId, list] of Object.entries(rawShots)) {
    if (!Array.isArray(list)) continue;
    shotCast[shotId] = Array.from(new Set(list.filter((x): x is string => typeof x === "string" && ids.has(x))));
  }
  return { members, shotCast };
}

/** Gives every member an id (keeping existing ones), names unique (case-insensitive). Throws a plain sentence on a repeated name. */
export function assignVideoCastIds(
  members: ReadonlyArray<{ id?: string; name: string; nickname?: string | null; description?: string | null; identityId?: string | null }>,
): VideoStorylineCastMember[] {
  const used = new Set(members.map((m) => m.id).filter((id): id is string => !!id));
  const names = new Set<string>();
  let next = 1;
  return members.map((m) => {
    const key = m.name.trim().toLowerCase();
    if (names.has(key)) throw new Error(`"${m.name.trim()}" is in the cast twice. Give each character its own name.`);
    names.add(key);
    let id = m.id;
    if (!id) {
      while (used.has(`c${next}`)) next += 1;
      id = `c${next}`;
      used.add(id);
    }
    return {
      id,
      name: m.name.trim(),
      nickname: m.nickname?.trim() || null,
      description: m.description?.trim() || null,
      identityId: m.identityId?.trim() || null,
    };
  });
}

/** Adds the script's characters that are not in the cast yet (by name), unlinked. Existing members are kept as they are. */
export function mergeScriptCharactersIntoCast(
  existing: readonly VideoStorylineCastMember[],
  characters: ReadonlyArray<{ name: string; description: string }>,
): VideoStorylineCastMember[] {
  const known = new Set(existing.flatMap((m) => [m.name.toLowerCase(), ...(m.nickname ? [m.nickname.toLowerCase()] : [])]));
  const added = characters
    .filter((c) => c.name.trim() && !known.has(c.name.trim().toLowerCase()))
    .map((c) => ({ name: c.name.trim().slice(0, VIDEO_CAST_NAME_MAX_LENGTH), description: c.description.trim().slice(0, VIDEO_CAST_DESCRIPTION_MAX_LENGTH) || null }));
  const room = Math.max(0, VIDEO_STORYLINE_MAX_CAST - existing.length);
  return assignVideoCastIds([...existing, ...added.slice(0, room)]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `text` name `name` as a whole word (any case, any spacing)? Names under 2 letters never match. */
export function videoCastNameMentioned(text: string, name: string | null | undefined): boolean {
  const n = name?.trim();
  if (!n || n.length < 2) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(n).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
  return pattern.test(text);
}

/**
 * The cast members a shot's description names: by the member's name or
 * nickname, or by the name/nickname of the identity it is linked to. In
 * cast order.
 */
export function detectVideoShotCast(
  text: string,
  members: readonly VideoStorylineCastMember[],
  identityNames: Readonly<Record<string, { name: string; nickname: string | null }>> = {},
): string[] {
  return members
    .filter((m) => {
      const identity = m.identityId ? identityNames[m.identityId] : undefined;
      return [m.name, m.nickname, identity?.name, identity?.nickname].some((n) => videoCastNameMentioned(text, n));
    })
    .map((m) => m.id);
}

/** Who is in one shot: a person's own pick when there is one, else the names found in its description and camera notes. */
export function videoShotCast(
  shot: { id: string; prompt: string; cameraNotes?: string | null },
  cast: VideoStorylineCast,
  identityNames: Readonly<Record<string, { name: string; nickname: string | null }>> = {},
): { castIds: string[]; picked: boolean } {
  const picked = cast.shotCast[shot.id];
  if (picked) {
    const ids = new Set(cast.members.map((m) => m.id));
    return { castIds: picked.filter((id) => ids.has(id)), picked: true };
  }
  const text = [shot.prompt, shot.cameraNotes ?? ""].join("\n");
  return { castIds: detectVideoShotCast(text, cast.members, identityNames), picked: false };
}
