import { z } from "zod";
import {
  PERSONA_ACCOUNT_PLATFORMS,
  PERSONA_ACCOUNT_AUTONOMY_MODES,
} from "../constants.js";

export const personaAccountPlatformSchema = z.enum(PERSONA_ACCOUNT_PLATFORMS);
export const personaAccountAutonomyModeSchema = z.enum(PERSONA_ACCOUNT_AUTONOMY_MODES);

// DUR-134 operator decision: aiDisclosureEnabled and dailyPostCap have no
// global default and are required at creation -- no `.optional()`, no
// `.default()`. autonomyMode IS required here too (the API layer forces an
// explicit operator choice); the schema-level default on the DB column is
// defense in depth only, not a substitute for this validator.
export const createPersonaAccountSchema = z.object({
  platform: personaAccountPlatformSchema,
  accountLabel: z.string().trim().min(1).max(200),
  externalAccountId: z.string().trim().min(1).max(200),
  aiDisclosureEnabled: z.boolean(),
  autonomyMode: personaAccountAutonomyModeSchema,
  dailyPostCap: z.number().int().positive(),
  // Optional override of the code default (see persona-accounts.ts service);
  // operators cannot shorten it below the code default via this field --
  // the service clamps up, never down.
  warmupPostsRequired: z.number().int().min(0).optional(),
});
export type CreatePersonaAccountInput = z.infer<typeof createPersonaAccountSchema>;

export const updatePersonaAccountSchema = z.object({
  accountLabel: z.string().trim().min(1).max(200).optional(),
  aiDisclosureEnabled: z.boolean().optional(),
  autonomyMode: personaAccountAutonomyModeSchema.optional(),
  dailyPostCap: z.number().int().positive().optional(),
  publishingPaused: z.boolean().optional(),
});
export type UpdatePersonaAccountInput = z.infer<typeof updatePersonaAccountSchema>;

export const connectPersonaAccountCredentialSchema = z.object({
  secretId: z.string().uuid(),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});
export type ConnectPersonaAccountCredentialInput = z.infer<typeof connectPersonaAccountCredentialSchema>;

export const enqueuePersonaPostSchema = z.object({
  caption: z.string().trim().min(1).max(5000),
  mediaAssetId: z.string().uuid().nullable().optional(),
});
export type EnqueuePersonaPostInput = z.infer<typeof enqueuePersonaPostSchema>;

// DUR-4016: the operator's posting cadence for this account, wired through
// routines/routine_triggers rather than a bare cron column (item 4 of
// DUR-134's own DoD). assigneeAgentId is required -- a schedule with nobody
// to wake can never actually fire (dispatchRoutineRun rejects a routine with
// no assignee), so there is no "figure it out later" state.
export const setPersonaAccountScheduleSchema = z.object({
  assigneeAgentId: z.string().uuid(),
  cronExpression: z.string().trim().min(1),
  timezone: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
});
export type SetPersonaAccountScheduleInput = z.infer<typeof setPersonaAccountScheduleSchema>;

export const updatePersonaPublishingCompanySettingsSchema = z.object({
  publishingPaused: z.boolean(),
});
export type UpdatePersonaPublishingCompanySettingsInput = z.infer<
  typeof updatePersonaPublishingCompanySettingsSchema
>;
