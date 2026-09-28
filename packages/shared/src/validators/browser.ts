import { z } from "zod";

// DUR-4013 step 3: request bodies for the browse-and-forms REST surface at
// /api/browser/... . One schema per plain tool from the design; the gated
// tools (request_booking, request_purchase, fill_payment_details,
// confirm_final_step, ...) are a later phase and have no schema here yet.

export const openBrowserSessionSchema = z.object({
  purpose: z.string().trim().min(1).max(500),
  issueId: z.string().trim().min(1).max(200).optional(),
});

export const browserNavigateSchema = z.object({
  url: z.string().trim().min(1).max(2000),
});

export const browserClickSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  why: z.string().trim().min(1).max(500),
});

export const browserTypeSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  text: z.string().max(4000),
});

export const browserSelectSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  value: z.string().max(1000),
});

export const browserCheckSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  checked: z.boolean(),
});

export const browserPressKeySchema = z.object({
  key: z.string().trim().min(1).max(50),
});

export const browserWaitSchema = z.object({
  ms: z.number().int().min(0).max(30_000),
});

export const browserHandOverSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  whatFilipShouldDo: z.string().trim().min(1).max(1000),
});
