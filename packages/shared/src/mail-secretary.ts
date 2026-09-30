import { z } from "zod";

/**
 * DUR-4093: the mail secretary. A limited-trust duty run, the same shape as
 * watchers (see watchers.ts) -- code fetches an inbox over IMAP, code checks
 * per-inbox ignore filters, one cheap model call with NO tools classifies
 * what is left, then code routes: ignore, keep for Filip, or delegate to
 * Maja. It is not a conversation and not a new agent type -- an existing
 * quick agent is assigned to an inbox, and that agent's laneATrustLevel
 * (see lane-a-trust.ts) must be "limited" before any tick for that inbox
 * runs at all (DUR-4070 is this feature's prerequisite for exactly that
 * reason).
 *
 * Read-only: the secretary never sends mail, never deletes or flags a
 * message, and never writes back to the mailbox. Every credential is a
 * company secret Filip enters himself (server/src/routes/secrets.ts is
 * board-only) -- never something an agent can create or edit.
 *
 * Practice mode (the default for a new inbox) never actually delegates
 * anything to Maja: the secretary decides exactly as it would for real and
 * records that decision, but the "ready" handoff Maja could read is left
 * empty. Turning practice mode off is the one switch that starts real
 * delegation.
 */

// ─── Filters (per-inbox ignore rules; pure code, no model) ──────────────────

export const MAIL_FILTER_FIELDS = ["from", "subject", "body", "any"] as const;
export type MailFilterField = (typeof MAIL_FILTER_FIELDS)[number];

export const MAIL_FILTER_MATCH_TYPES = ["contains", "domain"] as const;
export type MailFilterMatchType = (typeof MAIL_FILTER_MATCH_TYPES)[number];

export const MAIL_FILTER_FIELD_LABELS: Record<MailFilterField, string> = {
  from: "Who it's from",
  subject: "Subject",
  body: "Message text",
  any: "Anywhere (from, subject or message text)",
};

export const MAIL_FILTER_MATCH_TYPE_LABELS: Record<MailFilterMatchType, string> = {
  contains: "contains this text",
  domain: "is from this domain",
};

const mailFilterFields = {
  label: z.string().trim().min(1, "Give the filter a short name, e.g. \"Nordstrand\".").max(80),
  field: z.enum(MAIL_FILTER_FIELDS),
  matchType: z.enum(MAIL_FILTER_MATCH_TYPES),
  value: z
    .string()
    .trim()
    .min(1, "Enter what to match.")
    .max(200),
  enabled: z.boolean(),
};

export const createMailInboxFilterSchema = z
  .object({
    ...mailFilterFields,
    enabled: mailFilterFields.enabled.default(true),
  })
  .strict();
export type CreateMailInboxFilterInput = z.infer<typeof createMailInboxFilterSchema>;

export const updateMailInboxFilterSchema = z.object({ ...mailFilterFields }).partial().strict();
export type UpdateMailInboxFilterInput = z.infer<typeof updateMailInboxFilterSchema>;

/** A filter's own shape problem, independent of any message -- a domain match must look like a domain. */
export function mailFilterValueProblem(matchType: MailFilterMatchType, value: string): string | null {
  if (matchType !== "domain") return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) {
    return "Enter a domain, e.g. \"nordstrand.no\" (no @, no https://).";
  }
  return null;
}

export interface MailFilterCandidate {
  from: string;
  subject: string;
  body: string;
}

function hostnameOfEmail(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

function fieldsToCheck(field: MailFilterField, candidate: MailFilterCandidate): string[] {
  switch (field) {
    case "from":
      return [candidate.from];
    case "subject":
      return [candidate.subject];
    case "body":
      return [candidate.body];
    case "any":
      return [candidate.from, candidate.subject, candidate.body];
  }
}

/**
 * Pure code, no model: does one filter rule match this message? `domain`
 * matching only ever looks at the from-address's domain, regardless of
 * `field` (matching a domain against a subject or body line is never what an
 * operator means by "everything about acme.com").
 */
export function mailFilterMatches(
  filter: { field: MailFilterField; matchType: MailFilterMatchType; value: string },
  candidate: MailFilterCandidate,
): boolean {
  const value = filter.value.trim().toLowerCase();
  if (!value) return false;
  if (filter.matchType === "domain") {
    return hostnameOfEmail(candidate.from) === value || hostnameOfEmail(candidate.from).endsWith(`.${value}`);
  }
  return fieldsToCheck(filter.field, candidate).some((text) => text.toLowerCase().includes(value));
}

// ─── Inboxes ─────────────────────────────────────────────────────────────────

export const MAIL_INBOX_MIN_CHECK_MINUTES = 5;
export const MAIL_INBOX_MAX_CHECK_MINUTES = 24 * 60;
export const MAIL_INBOX_DEFAULT_CHECK_MINUTES = 10;
/** How many new messages one tick processes per inbox; the rest wait for the next tick. */
export const MAIL_INBOX_TICK_BATCH = 20;
/** A new inbox starts in practice mode and stays there until an operator turns it off. */
export const MAIL_INBOX_DEFAULT_PRACTICE_MODE = true;

const mailInboxFields = {
  name: z.string().trim().min(1, "Give the inbox a name, e.g. \"Filip's inbox\".").max(80),
  agentId: z.string().uuid("Pick the quick agent this secretary duty runs as."),
  imapHost: z.string().trim().min(1, "Enter the IMAP server address.").max(255),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  imapUsername: z.string().trim().min(1, "Enter the mailbox username (usually the email address).").max(320),
  imapMailbox: z.string().trim().min(1).max(200),
  credentialSecretId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  practiceMode: z.boolean(),
  checkEveryMinutes: z
    .number()
    .int()
    .min(MAIL_INBOX_MIN_CHECK_MINUTES, `Check at most every ${MAIL_INBOX_MIN_CHECK_MINUTES} minutes.`)
    .max(MAIL_INBOX_MAX_CHECK_MINUTES, "Check at least once a day."),
};

export const createMailInboxSchema = z
  .object({
    ...mailInboxFields,
    imapPort: mailInboxFields.imapPort.default(993),
    imapSecure: mailInboxFields.imapSecure.default(true),
    imapMailbox: mailInboxFields.imapMailbox.default("INBOX"),
    credentialSecretId: mailInboxFields.credentialSecretId.optional().default(null),
    enabled: mailInboxFields.enabled.default(true),
    practiceMode: mailInboxFields.practiceMode.default(MAIL_INBOX_DEFAULT_PRACTICE_MODE),
    checkEveryMinutes: mailInboxFields.checkEveryMinutes.default(MAIL_INBOX_DEFAULT_CHECK_MINUTES),
  })
  .strict();
export type CreateMailInboxInput = z.infer<typeof createMailInboxSchema>;

export const updateMailInboxSchema = z.object({ ...mailInboxFields }).partial().strict();
export type UpdateMailInboxInput = z.infer<typeof updateMailInboxSchema>;

// ─── Triage decisions ────────────────────────────────────────────────────────

export const MAIL_ITEM_DECISIONS = [
  "ignored_by_filter",
  "ignored_by_classifier",
  "kept_for_filip",
  "delegated_to_maja",
  "error",
] as const;
export type MailItemDecision = (typeof MAIL_ITEM_DECISIONS)[number];

export const MAIL_DELEGATION_STATUSES = ["none", "practice_only", "ready", "acknowledged"] as const;
export type MailDelegationStatus = (typeof MAIL_DELEGATION_STATUSES)[number];

export const MAIL_DELEGATION_CATEGORIES = [
  "newsletter_relevant_to_maja",
  "purchase_receipt",
  "booking_confirmation",
  "other",
] as const;
export type MailDelegationCategory = (typeof MAIL_DELEGATION_CATEGORIES)[number];

/** What the one cheap, tool-less model call returns. Code owns everything downstream of this. */
export interface MailClassification {
  /** True = nothing here for Filip or Maja; the secretary would file this away unread. */
  ignore: boolean;
  /** True = pass a framed copy to Maja (newsletter item for her reporting, a receipt, a booking confirmation). */
  delegateToMaja: boolean;
  category: MailDelegationCategory;
  /** One or two plain sentences, shown on the report -- never fed back into another model call. */
  reason: string;
}

export const MAIL_SECRETARY_CLASSIFIER_MODEL = "claude-sonnet-5";
export const MAIL_SECRETARY_CLASSIFIER_MAX_OUTPUT_TOKENS = 300;
/** A message body this long or shorter is classified whole; longer bodies are truncated first. */
export const MAIL_SECRETARY_MAX_BODY_CHARS = 4_000;
/** How much of a delegated message's body Maja actually sees, framed as untrusted content. */
export const MAIL_SECRETARY_DELEGATED_BODY_CHARS = 2_000;
