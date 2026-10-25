import { z } from "zod";

/**
 * Contract register (Legal Phase 1, DUR-4852 under DUR-4851).
 *
 * Contracts are confidential. Nothing here carries contract text except the
 * explicit `extractedText` field on the contract itself; activity-log
 * payloads and error messages must never include it.
 */

export const CONTRACT_TYPES = [
  "rental_lease",
  "vendor_supplier",
  "customer",
  "employment",
  "nda",
  "service",
  "loan",
  "other",
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_STATUSES = ["draft", "active", "expired", "terminated", "superseded"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_TEXT_STATUSES = ["pending", "extracted", "no_text_layer", "failed"] as const;
export type ContractTextStatus = (typeof CONTRACT_TEXT_STATUSES)[number];

export const CONTRACT_DEADLINE_KINDS = [
  "notice_extend",
  "notice_terminate",
  "expiry",
  "renewal",
  "price_review",
  "payment",
  "reporting",
  "other",
] as const;
export type ContractDeadlineKind = (typeof CONTRACT_DEADLINE_KINDS)[number];

export const CONTRACT_DEADLINE_STATES = ["open", "done", "dismissed", "superseded"] as const;
export type ContractDeadlineState = (typeof CONTRACT_DEADLINE_STATES)[number];

export const CONTRACT_TERM_VALUE_KINDS = [
  "number",
  "text",
  "bool",
  "not_mentioned",
  "explicitly_none",
] as const;
export type ContractTermValueKind = (typeof CONTRACT_TERM_VALUE_KINDS)[number];

/** Notice deadlines get a longer runway than everything else. */
export const NOTICE_DEADLINE_KINDS: readonly ContractDeadlineKind[] = ["notice_extend", "notice_terminate"];

export const DEFAULT_NOTICE_LEAD_TIMES_DAYS: readonly number[] = [60, 30, 7];
export const DEFAULT_LEAD_TIMES_DAYS: readonly number[] = [30, 7];

export function defaultLeadTimesDaysForKind(kind: ContractDeadlineKind): number[] {
  return [...(NOTICE_DEADLINE_KINDS.includes(kind) ? DEFAULT_NOTICE_LEAD_TIMES_DAYS : DEFAULT_LEAD_TIMES_DAYS)];
}

/**
 * Well-known term keys. The register accepts other keys too (free-form), but
 * these are the ones questions across contracts are expected to ask, so the
 * extractor and the aggregation both share one spelling.
 */
export const CONTRACT_TERM_REGISTRY = [
  { key: "free_shipping_threshold", label: "Free shipping threshold", valueKind: "number", unit: "currency" },
  { key: "payment_terms_days", label: "Payment terms (days)", valueKind: "number", unit: "days" },
  { key: "notice_period_days", label: "Notice period (days)", valueKind: "number", unit: "days" },
  { key: "auto_renewal", label: "Automatic renewal", valueKind: "bool", unit: null },
  { key: "liability_cap", label: "Liability cap", valueKind: "number", unit: "currency" },
  { key: "governing_law", label: "Governing law", valueKind: "text", unit: null },
  { key: "minimum_term_months", label: "Minimum term (months)", valueKind: "number", unit: "months" },
  { key: "price_indexation", label: "Price indexation", valueKind: "text", unit: null },
  { key: "termination_for_convenience", label: "Termination for convenience", valueKind: "bool", unit: null },
] as const;
export type ContractTermRegistryKey = (typeof CONTRACT_TERM_REGISTRY)[number]["key"];

export const CONTRACT_TERM_REGISTRY_KEYS: readonly string[] = CONTRACT_TERM_REGISTRY.map((t) => t.key);

/** Free-form keys are lowercase snake_case so `Payment Terms` and `payment_terms` cannot both exist. */
const TERM_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Not a real calendar date");

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const contractTypeSchema = z.enum(CONTRACT_TYPES);
export const contractStatusSchema = z.enum(CONTRACT_STATUSES);
export const contractTextStatusSchema = z.enum(CONTRACT_TEXT_STATUSES);
export const contractDeadlineKindSchema = z.enum(CONTRACT_DEADLINE_KINDS);
export const contractDeadlineStateSchema = z.enum(CONTRACT_DEADLINE_STATES);

export const createContractPartySchema = z
  .object({
    organizationId: z.string().uuid().nullable().optional(),
    role: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .refine((party) => Boolean(party.organizationId) || Boolean(party.name), {
    message: "A party needs an organization from the CRM or a name",
    path: ["name"],
  });
export type CreateContractParty = z.infer<typeof createContractPartySchema>;

export const updateContractPartySchema = z
  .object({
    organizationId: z.string().uuid().nullable().optional(),
    role: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict();
export type UpdateContractParty = z.infer<typeof updateContractPartySchema>;

const contractFields = {
  title: z.string().trim().min(1).max(300),
  type: contractTypeSchema,
  status: contractStatusSchema.optional(),
  assetId: z.string().uuid().nullable().optional(),
  extractedText: z.string().max(5_000_000).nullable().optional(),
  textStatus: contractTextStatusSchema.optional(),
  language: optionalText(40),
  governingLaw: optionalText(200),
  effectiveDate: isoDate.nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  autoRenewal: z.boolean().nullable().optional(),
  noticePeriodDays: z.number().int().min(0).max(36_500).nullable().optional(),
  summary: z.string().max(20_000).nullable().optional(),
  sourceIssueId: z.string().uuid().nullable().optional(),
};

export const createContractSchema = z
  .object({
    ...contractFields,
    parties: z.array(createContractPartySchema).max(50).optional(),
  })
  .strict();
export type CreateContract = z.infer<typeof createContractSchema>;

/**
 * `status: "superseded"` is deliberately not settable here: it is only ever the
 * result of linking a newer version (link-previous-version), which also moves
 * the old version's open deadlines in the same transaction.
 */
export const updateContractSchema = z
  .object({
    ...contractFields,
    status: contractStatusSchema.exclude(["superseded"]).optional(),
  })
  .partial()
  .strict();
export type UpdateContract = z.infer<typeof updateContractSchema>;

export const listContractsQuerySchema = z.object({
  status: contractStatusSchema.optional(),
  type: contractTypeSchema.optional(),
  /** Contracts whose expiry date is on or before this date. */
  expiresBefore: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ListContractsQuery = z.infer<typeof listContractsQuerySchema>;

export const linkPreviousContractVersionSchema = z
  .object({
    previousContractId: z.string().uuid(),
    changeSummary: z.string().trim().min(1).max(5_000),
    /**
     * true: the old version's open deadlines move to this version (an open
     * deadline this version already has for the same kind and date is kept and
     * the old one is marked superseded instead of being duplicated).
     * false: the old version's open deadlines are marked superseded.
     */
    carryDeadlines: z.boolean(),
  })
  .strict();
export type LinkPreviousContractVersion = z.infer<typeof linkPreviousContractVersionSchema>;

const leadTimesDays = z.array(z.number().int().min(0).max(3650)).min(1).max(12);

export const createContractDeadlineSchema = z
  .object({
    kind: contractDeadlineKindSchema,
    dueDate: isoDate,
    leadTimesDays: leadTimesDays.optional(),
    clauseRef: optionalText(200),
    note: z.string().max(5_000).nullable().optional(),
  })
  .strict();
export type CreateContractDeadline = z.infer<typeof createContractDeadlineSchema>;

export const updateContractDeadlineSchema = z
  .object({
    kind: contractDeadlineKindSchema.optional(),
    dueDate: isoDate.optional(),
    leadTimesDays: leadTimesDays.optional(),
    clauseRef: optionalText(200),
    note: z.string().max(5_000).nullable().optional(),
    state: contractDeadlineStateSchema.exclude(["superseded"]).optional(),
  })
  .strict();
export type UpdateContractDeadline = z.infer<typeof updateContractDeadlineSchema>;

export const listContractDeadlinesQuerySchema = z.object({
  state: contractDeadlineStateSchema.optional(),
  /** Deadlines due on or before this date. */
  dueBefore: isoDate.optional(),
  contractId: z.string().uuid().optional(),
});
export type ListContractDeadlinesQuery = z.infer<typeof listContractDeadlinesQuerySchema>;

export const contractTermKeySchema = z
  .string()
  .regex(TERM_KEY_RE, "Use a lowercase key with letters, digits and underscores");

/**
 * One value per (contract, key). The kind says what the contract actually
 * says: a value, "not mentioned", or "explicitly none". The two latter kinds
 * carry no value, and a value kind carries exactly its own value field, so a
 * "not mentioned" can never be read as a zero.
 */
export const upsertContractTermSchema = z
  .object({
    valueKind: z.enum(CONTRACT_TERM_VALUE_KINDS),
    numberValue: z.number().finite().nullable().optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "Use a 3-letter currency code")
      .nullable()
      .optional(),
    textValue: z.string().max(10_000).nullable().optional(),
    boolValue: z.boolean().nullable().optional(),
    clauseRef: optionalText(200),
    pageRef: optionalText(80),
  })
  .strict()
  .superRefine((term, ctx) => {
    const has = {
      number: term.numberValue !== null && term.numberValue !== undefined,
      text: term.textValue !== null && term.textValue !== undefined && term.textValue.trim() !== "",
      bool: term.boolValue !== null && term.boolValue !== undefined,
      currency: term.currency !== null && term.currency !== undefined,
    };
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    switch (term.valueKind) {
      case "number":
        if (!has.number) fail("numberValue", "A number term needs numberValue");
        if (has.text) fail("textValue", "A number term carries no text value");
        if (has.bool) fail("boolValue", "A number term carries no bool value");
        break;
      case "text":
        if (!has.text) fail("textValue", "A text term needs textValue");
        if (has.number) fail("numberValue", "A text term carries no number value");
        if (has.bool) fail("boolValue", "A text term carries no bool value");
        if (has.currency) fail("currency", "A text term carries no currency");
        break;
      case "bool":
        if (!has.bool) fail("boolValue", "A bool term needs boolValue");
        if (has.number) fail("numberValue", "A bool term carries no number value");
        if (has.text) fail("textValue", "A bool term carries no text value");
        if (has.currency) fail("currency", "A bool term carries no currency");
        break;
      case "not_mentioned":
      case "explicitly_none":
        if (has.number) fail("numberValue", `A ${term.valueKind} term carries no value`);
        if (has.text) fail("textValue", `A ${term.valueKind} term carries no value`);
        if (has.bool) fail("boolValue", `A ${term.valueKind} term carries no value`);
        if (has.currency) fail("currency", `A ${term.valueKind} term carries no currency`);
        break;
    }
  });
export type UpsertContractTerm = z.infer<typeof upsertContractTermSchema>;

export const aggregateContractTermQuerySchema = z.object({
  type: contractTypeSchema.optional(),
  /** Comma separated. Default: every status except superseded (old versions never count twice). */
  statuses: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return undefined;
      const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
      const parsed = z.array(contractStatusSchema).safeParse(parts);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "statuses must be a comma separated list of contract statuses" });
        return z.NEVER;
      }
      return parsed.data;
    }),
  partyOrganizationId: z.string().uuid().optional(),
});
export type AggregateContractTermQuery = z.infer<typeof aggregateContractTermQuerySchema>;

// ---------------------------------------------------------------- aggregate result

export interface ContractTermRef {
  contractId: string;
  clauseRef: string | null;
}

export interface ContractTermNumericStats {
  /** null = the values carry no currency (days, months, counts). */
  currency: string | null;
  count: number;
  avg: number;
  min: number;
  max: number;
  contracts: ContractTermRef[];
}

export interface ContractTermAggregate {
  key: string;
  /** The population the counts are over, echoed so the answer says what it covered. */
  filters: { type: ContractType | null; statuses: ContractStatus[]; partyOrganizationId: string | null };
  totalContracts: number;
  /** Numeric stats, one entry per currency. Only real numeric values are ever included. */
  numeric: ContractTermNumericStats[];
  /** A real value is on file (number, text or bool). */
  withValue: { count: number; contracts: ContractTermRef[] };
  /** The contract was read and does not mention the term. */
  notMentioned: { count: number; contracts: ContractTermRef[] };
  /** The contract states there is none (e.g. no liability cap). */
  explicitlyNone: { count: number; contracts: ContractTermRef[] };
  /** Nobody has recorded this term for the contract at all. Unknown, not zero. */
  noTermRecorded: { count: number; contracts: ContractTermRef[] };
  /** A row says "number" but holds no usable number. Reported, never averaged. */
  malformed: { count: number; contracts: ContractTermRef[] };
}
