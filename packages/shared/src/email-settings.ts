import { z } from "zod";

/**
 * DUR-4277: the email UI's per-company on/off switch. Mirrors
 * `ProductGrabberSettings` / `updateProductGrabberSettingsSchema`. Absence of a
 * row reads as `{ enabled: false }`; only a company owner/admin may flip it.
 */
export interface EmailSettings {
  enabled: boolean;
}

export const updateEmailSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type UpdateEmailSettingsInput = z.infer<typeof updateEmailSettingsSchema>;
