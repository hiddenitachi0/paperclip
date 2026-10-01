import { z } from "zod";

export const CRM_ACTIVITY_TYPES = ["email", "call", "meeting", "note", "task", "other"] as const;
export type CrmActivityType = (typeof CRM_ACTIVITY_TYPES)[number];

export const createCrmContactSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type CreateCrmContact = z.infer<typeof createCrmContactSchema>;

export const updateCrmContactSchema = createCrmContactSchema.partial();
export type UpdateCrmContact = z.infer<typeof updateCrmContactSchema>;

export const createCrmOrganizationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  employeeCount: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
});
export type CreateCrmOrganization = z.infer<typeof createCrmOrganizationSchema>;

export const updateCrmOrganizationSchema = createCrmOrganizationSchema.partial();
export type UpdateCrmOrganization = z.infer<typeof updateCrmOrganizationSchema>;

export const createCrmContactOrgRoleSchema = z.object({
  contactId: z.string().uuid(),
  organizationId: z.string().uuid(),
  role: z.string().min(1),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
});
export type CreateCrmContactOrgRole = z.infer<typeof createCrmContactOrgRoleSchema>;

export const createCrmActivitySchema = z.object({
  contactId: z.string().uuid().optional().nullable(),
  organizationId: z.string().uuid().optional().nullable(),
  type: z.enum(CRM_ACTIVITY_TYPES),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  activityDate: z.coerce.date().optional(),
});
export type CreateCrmActivity = z.infer<typeof createCrmActivitySchema>;

export const createCrmFactSchema = z.object({
  contactId: z.string().uuid().optional().nullable(),
  organizationId: z.string().uuid().optional().nullable(),
  factKey: z.string().min(1),
  value: z.string().min(1),
  sourceUrl: z.string().optional().nullable(),
  sourceMessageId: z.string().optional().nullable(),
  observedAt: z.coerce.date(),
});
export type CreateCrmFact = z.infer<typeof createCrmFactSchema>;
