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

// DUR-4037 (Maja browser step 4): the gated booking surface, `book_and_buy`
// agents only. Every booking, including a free one with no deposit, needs
// Filip's approval -- there is no auto-clear input to accept here.

export const browserRequestBookingSchema = z.object({
  /** The agent's own one-line account of what it is booking; always shown to Filip quoted, never as fact. */
  summary: z.string().trim().min(1).max(1000),
  /** Ref of the final confirm/book button from the last snapshot -- the server binds the clearance to this exact element (role + accessible name) plus the current page and price, per the DUR-4045 security review of the booking gate. */
  ref: z.string().trim().min(1).max(200),
});

export const browserConfirmFinalStepSchema = z.object({
  ref: z.string().trim().min(1).max(200),
});

export const browserFillSiteLoginSchema = z.object({
  secretId: z.string().uuid(),
  usernameRef: z.string().trim().min(1).max(200),
  passwordRef: z.string().trim().min(1).max(200),
});

// DUR-4046 (Maja browser step 6): the gated purchase surface, `book_and_buy`
// agents only. Purchases strictly below 500 NOK equivalent auto-clear (still
// gated by caps/splitting checks below); at or above, an approval card, same
// as every other case the server cannot confidently auto-clear (parse
// failure, ambiguous currency, several totals, subscription/trial wording).

export const browserRequestPurchaseSchema = z.object({
  /** The agent's own one-line account of what it is buying; always shown to Filip quoted, never as fact. */
  summary: z.string().trim().min(1).max(1000),
  /** Ref of the final pay/place-order button from the last snapshot -- the server binds the clearance to this exact element, the current page (including its query string), and the parsed total. */
  ref: z.string().trim().min(1).max(200),
  cardId: z.string().uuid(),
});

export const browserFillPaymentDetailsSchema = z.object({
  clearanceId: z.string().uuid(),
  /** Element refs for whichever of these fields exist on the page -- fields not present are simply skipped, never invented. */
  cardNumberRef: z.string().trim().min(1).max(200).optional(),
  expiryRef: z.string().trim().min(1).max(200).optional(),
  expiryMonthRef: z.string().trim().min(1).max(200).optional(),
  expiryYearRef: z.string().trim().min(1).max(200).optional(),
  cvcRef: z.string().trim().min(1).max(200).optional(),
  nameOnCardRef: z.string().trim().min(1).max(200).optional(),
});

export const browserWaitForOutcomeSchema = z.object({
  ms: z.number().int().min(0).max(30_000).optional(),
});

export const browserReportOutcomeSchema = z.object({
  /** The agent's own claim, quoted in the receipt/notice text -- never trusted as fact. The server re-derives the actual outcome itself (classifyPurchaseOutcome) before deciding card consumption. */
  agentNote: z.string().trim().max(1000).optional(),
});
