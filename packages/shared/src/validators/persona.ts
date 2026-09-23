import { z } from "zod";
import { PERSONA_STATUSES } from "../constants.js";

export const personaStatusSchema = z.enum(PERSONA_STATUSES);

/**
 * DUR-4000: a persona is a person and these are the person's own fields, on
 * the personas table. Nothing here writes to an agent row any more.
 *
 * Lengths: `voice` fills the same prompt slot as an agent's `tone` (it wins
 * over the tone when attached), so its cap should be tone's 600. It stays at
 * the old 2000 FOR NOW: migration 0175 copies agents.tone verbatim into it,
 * a persona's tone could be up to 2000 (the old persona dialog wrote tone
 * past the agent form's cap), and the untouched Personas dialog re-sends
 * `voice` on every save — a live persona with a 601–2000 character voice
 * could not be edited at all. Step 3 (the screens) truncates/warns in the
 * form and drops this to 600. `backstory` fills the slot agents.personality
 * filled (20,000), and the 0175 backfill copies personality into it, so the
 * old 4000-character "bio" limit would have refused to re-save a persona
 * whose copied text was longer.
 */
const trimmedOrNull = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .nullable()
    .optional();

/**
 * DUR-4000: the persona fields' character caps, shared by this validator and
 * the persona form (ui PersonaFormDialog) so the form's maxLength and counter
 * can never disagree with what the server accepts. `voice` is 2000 for now
 * (see the header note); when it drops to 600 it drops here, in one place.
 */
export const PERSONA_FIELD_MAX_LENGTHS = {
  displayName: 200,
  pronouns: 40,
  handle: 100,
  traits: 2000,
  backstory: 20000,
  voice: 2000,
} as const;

const personaFields = {
  displayName: z.string().trim().min(1, "The persona needs a name.").max(PERSONA_FIELD_MAX_LENGTHS.displayName),
  // Free text: "she/her", "he/him", "they/them", "hen". Never assumed.
  pronouns: trimmedOrNull(PERSONA_FIELD_MAX_LENGTHS.pronouns, "Pronouns are limited to 40 characters."),
  traits: trimmedOrNull(
    PERSONA_FIELD_MAX_LENGTHS.traits,
    "Traits are limited to 2,000 characters — a few words or lines on character.",
  ),
  backstory: trimmedOrNull(PERSONA_FIELD_MAX_LENGTHS.backstory, "The backstory is limited to 20,000 characters."),
  // 2000 for now; 600 (tone's cap) once the step-3 form truncates/warns — see the header note.
  voice: trimmedOrNull(
    PERSONA_FIELD_MAX_LENGTHS.voice,
    "Voice is limited to 2,000 characters — a few sentences on how this person writes, not who they are.",
  ),
  avatarAssetId: z.string().uuid().nullable().optional(),
  handle: z.string().trim().min(1).max(PERSONA_FIELD_MAX_LENGTHS.handle).nullable().optional(),
  status: personaStatusSchema.optional(),
  // DUR-134: the per-persona half of the publishing kill switch. Defaults to
  // false (not paused) at the DB level; settable here so an operator can
  // pause a persona's publishing across every account in the same PATCH
  // that, say, takes it out of rotation for other reasons.
  publishingPaused: z.boolean().optional(),
};

/**
 * `bio` is the pre-DUR-4000 name for the backstory. The persona screens still
 * send it until step 3 ships, so it is accepted and folded into `backstory`
 * (an explicit `backstory` wins). Removed together with the screens.
 */
const legacyBioField = {
  bio: trimmedOrNull(20000, "The backstory is limited to 20,000 characters."),
};

function foldLegacyBio<T extends { bio?: string | null; backstory?: string | null }>(value: T): Omit<T, "bio"> {
  const { bio, ...rest } = value;
  if (rest.backstory === undefined && bio !== undefined) {
    return { ...rest, backstory: bio };
  }
  return rest;
}

export const createPersonaSchema = z
  .object({ ...personaFields, ...legacyBioField })
  .transform(foldLegacyBio);
export type CreatePersonaInput = z.infer<typeof createPersonaSchema>;

export const updatePersonaSchema = z
  .object({ ...personaFields, ...legacyBioField })
  .partial()
  .transform(foldLegacyBio);
export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;

/** Body of the board-only agent PATCH `personaId` field and of the persona picker: attach a person to a job, or detach (null). */
export const attachPersonaSchema = z.object({
  personaId: z.string().uuid().nullable(),
});
export type AttachPersonaInput = z.infer<typeof attachPersonaSchema>;
