import { z } from "zod";
import { PERSONA_STATUSES } from "../constants.js";

export const personaStatusSchema = z.enum(PERSONA_STATUSES);

export const createPersonaSchema = z.object({
  // These three write through to the underlying agent row (name/personality/
  // tone), not the personas table -- DUR-133/DUR-60/DUR-61 already put a
  // name, avatar and voice on every agent, so a persona reuses them rather
  // than duplicating storage.
  displayName: z.string().trim().min(1).max(200).optional(),
  bio: z.string().trim().max(4000).nullable().optional(),
  voice: z.string().trim().max(2000).nullable().optional(),
  avatarAssetId: z.string().uuid().nullable().optional(),
  handle: z.string().trim().min(1).max(100).nullable().optional(),
  status: personaStatusSchema.optional(),
  // No global default -- null means unlimited. Set per persona per DUR-63.
  dailyGenerationCap: z.number().int().positive().nullable().optional(),
});
export type CreatePersonaInput = z.infer<typeof createPersonaSchema>;

export const updatePersonaSchema = createPersonaSchema.partial();
export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;
