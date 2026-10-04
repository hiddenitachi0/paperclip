import { z } from "zod";
import {
  COMPANY_STATUSES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "../constants.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();
const attachmentMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES);

const worktreeCleanupRetentionDaysSchema = z.number().int().min(1).max(365).nullable();

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    // DUR-4040: one of the three off-switches the payment-card feature ships
    // behind (alongside an agent's browserAccess level and the
    // PAPERCLIP_BROWSER_DISABLED instance env var). Reaches
    // updateCompanySchema only, not updateCompanyBrandingSchema, so this
    // stays board-only the same way the route already restricts agent
    // actors to branding fields (server/src/routes/companies.ts).
    paymentsEnabled: z.boolean().optional(),
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
    feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
    // DUR-4497: null resets to the server default (7 days).
    worktreeCleanupRetentionDays: worktreeCleanupRetentionDaysSchema.optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;
