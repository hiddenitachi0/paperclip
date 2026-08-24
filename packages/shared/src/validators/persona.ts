import { z } from "zod";

// DUR-133 (persona-mcp Ticket B, item 10): who a persona is, layered on top
// of an existing agent. `bio` and `voice` are rendered into PERSONA.md
// (item 11) — kept as separate free-text fields so bio (who she is) and
// voice (how she writes) can be edited and read independently.
export const createPersonaSchema = z
  .object({
    agentId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(100),
    handle: z.string().trim().min(1).max(60).optional(),
    bio: z.string().trim().max(4000).optional(),
    voice: z.string().trim().max(4000).optional(),
    avatarAssetId: z.string().uuid().optional(),
  })
  .strict();

export type CreatePersona = z.infer<typeof createPersonaSchema>;

export const updatePersonaSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    handle: z.string().trim().min(1).max(60).nullable().optional(),
    bio: z.string().trim().max(4000).nullable().optional(),
    voice: z.string().trim().max(4000).nullable().optional(),
    avatarAssetId: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();

export type UpdatePersona = z.infer<typeof updatePersonaSchema>;
