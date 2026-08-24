import { z } from "zod";
import { PERSONA_STATUSES } from "../constants.js";

export const personaStatusSchema = z.enum(PERSONA_STATUSES);

export const createPersonaSchema = z.object({
  handle: z.string().trim().min(1).max(100).nullable().optional(),
  status: personaStatusSchema.optional(),
  // No global default -- null means unlimited. Set per persona per DUR-63.
  dailyGenerationCap: z.number().int().positive().nullable().optional(),
});
export type CreatePersonaInput = z.infer<typeof createPersonaSchema>;

export const updatePersonaSchema = createPersonaSchema.partial();
export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;
