import { z } from "zod";

/**
 * Product grabber (DUR-4151/DUR-4169/DUR-4187): fetches product data +
 * images from a vendor site into a staging list a person approves before
 * anything is used. Shared by the server (extraction, validation) and the
 * board UI (the staging list approval view, DUR-4188), so both agree on the
 * same staged-item shape.
 */

export const PRODUCT_GRABBER_STAGING_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProductGrabberStagingStatus = (typeof PRODUCT_GRABBER_STAGING_STATUSES)[number];

/** What the board sees for one grabbed product awaiting (or past) review. */
export interface ProductGrabberStagedItemSummary {
  id: string;
  companyId: string;
  vendor: string;
  sourceUrl: string;
  rawFields: Record<string, unknown>;
  imageUrls: string[];
  status: ProductGrabberStagingStatus;
  approvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductGrabberSettings {
  companyId: string;
  enabled: boolean;
}

export const extractProductGrabberUrlSchema = z.object({
  url: z.string().url(),
});
export type ExtractProductGrabberUrlInput = z.infer<typeof extractProductGrabberUrlSchema>;

export const reviewProductGrabberStagedItemSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});
export type ReviewProductGrabberStagedItemInput = z.infer<typeof reviewProductGrabberStagedItemSchema>;

export const updateProductGrabberSettingsSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateProductGrabberSettingsInput = z.infer<typeof updateProductGrabberSettingsSchema>;
