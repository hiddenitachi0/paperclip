import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { assets } from "./assets.js";
import { issues } from "./issues.js";
import { crmOrganizations } from "./crm_organizations.js";

/**
 * Contract register (Legal Phase 1, DUR-4852 under DUR-4851, migration 0256).
 *
 * Five company-scoped tables. Contracts are confidential: `contracts.extracted_text`
 * is the only column holding contract text and it is never written to the
 * activity log, an error message, or a list response.
 *
 *   contracts                  one row per contract *version*. A newer version
 *                              points at the one it replaces
 *                              (supersedes_contract_id) and carries version_no
 *                              and the "what changed" note, so the version log
 *                              is a walk along the chain. No separate versions table.
 *   contract_parties           who is on the contract: a CRM organisation, or a
 *                              free-text name for a party not in the CRM yet.
 *   contract_deadlines         dates that need an action (notice, renewal, ...).
 *   contract_deadline_reminders  one row per (deadline, lead step) once a
 *                              reminder issue was opened. The unique index makes
 *                              reminders idempotent (Phase 3 relies on it).
 *   contract_terms             one value per (contract, key): the number, text or
 *                              bool the contract states, or an explicit
 *                              "not mentioned" / "explicitly none".
 *
 * Enumerations (type, status, text_status, kind, state, value_kind) are plain
 * text columns validated by the zod schemas in packages/shared/src/contracts.ts,
 * as elsewhere in this schema.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // rental_lease | vendor_supplier | customer | employment | nda | service | loan | other
    type: text("type").notNull(),
    // draft | active | expired | terminated | superseded
    status: text("status").notNull().default("draft"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    extractedText: text("extracted_text"),
    // pending | extracted | no_text_layer | failed
    textStatus: text("text_status").notNull().default("pending"),
    language: text("language"),
    governingLaw: text("governing_law"),
    effectiveDate: date("effective_date", { mode: "string" }),
    expiryDate: date("expiry_date", { mode: "string" }),
    autoRenewal: boolean("auto_renewal"),
    noticePeriodDays: integer("notice_period_days"),
    summary: text("summary"),
    supersedesContractId: uuid("supersedes_contract_id").references((): AnyPgColumn => contracts.id, {
      onDelete: "set null",
    }),
    versionNo: integer("version_no").notNull().default(1),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("contracts_company_status_idx").on(table.companyId, table.status),
    companyTypeIdx: index("contracts_company_type_idx").on(table.companyId, table.type),
    companyExpiryIdx: index("contracts_company_expiry_idx").on(table.companyId, table.expiryDate),
    supersedesIdx: index("contracts_supersedes_idx").on(table.supersedesContractId),
    // A version has at most one successor: the chain stays a line, never a fork.
    supersedesUq: uniqueIndex("contracts_supersedes_uq")
      .on(table.supersedesContractId)
      .where(sql`${table.supersedesContractId} IS NOT NULL`),
  }),
);

export const contractParties = pgTable(
  "contract_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => crmOrganizations.id, { onDelete: "set null" }),
    // landlord | tenant | vendor | customer | ... (free text)
    role: text("role").notNull(),
    // Free-text name for a party not in the CRM yet; also kept if the CRM row is later deleted.
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    contractIdx: index("contract_parties_contract_idx").on(table.contractId),
    companyOrgIdx: index("contract_parties_company_org_idx").on(table.companyId, table.organizationId),
  }),
);

export const contractDeadlines = pgTable(
  "contract_deadlines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    // notice_extend | notice_terminate | expiry | renewal | price_review | payment | reporting | other
    kind: text("kind").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    // Days before due_date at which a reminder is due. Default per kind is set by the service.
    leadTimesDays: integer("lead_times_days").array().notNull(),
    clauseRef: text("clause_ref"),
    // Legal Phase 3: true when the action is the owner's decision (notice,
    // terminate, extend). A reminder for it shows up on the Now page as "Needs
    // you" instead of landing in the Legal agent's queue. Default per kind is set by the service.
    needsOwner: boolean("needs_owner").notNull().default(false),
    // open | done | dismissed | superseded
    state: text("state").notNull().default("open"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    contractIdx: index("contract_deadlines_contract_idx").on(table.contractId),
    companyStateDueIdx: index("contract_deadlines_company_state_due_idx").on(
      table.companyId,
      table.state,
      table.dueDate,
    ),
  }),
);

export const contractDeadlineReminders = pgTable(
  "contract_deadline_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    deadlineId: uuid("deadline_id").notNull().references(() => contractDeadlines.id, { onDelete: "cascade" }),
    leadDays: integer("lead_days").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deadlineLeadUq: uniqueIndex("contract_deadline_reminders_deadline_lead_uq").on(table.deadlineId, table.leadDays),
    companyIdx: index("contract_deadline_reminders_company_idx").on(table.companyId),
  }),
);

export const contractTerms = pgTable(
  "contract_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    // Registry keys live in packages/shared/src/contracts.ts; other keys are allowed.
    key: text("key").notNull(),
    // number | text | bool | not_mentioned | explicitly_none
    valueKind: text("value_kind").notNull(),
    numberValue: numeric("number_value", { precision: 24, scale: 6 }),
    currency: text("currency"),
    textValue: text("text_value"),
    boolValue: boolean("bool_value"),
    clauseRef: text("clause_ref"),
    pageRef: text("page_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    contractKeyUq: uniqueIndex("contract_terms_contract_key_uq").on(table.contractId, table.key),
    companyKeyIdx: index("contract_terms_company_key_idx").on(table.companyId, table.key),
  }),
);

/**
 * Legal Phase 3 (DUR-4855, migration 0257): per-company reminder defaults.
 * One row per company at most; a null array means "use the built-in default".
 * Applies to deadlines created after the change; existing deadlines keep the
 * lead times they were created with.
 */
export const contractSettings = pgTable(
  "contract_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    noticeLeadTimesDays: integer("notice_lead_times_days").array(),
    otherLeadTimesDays: integer("other_lead_times_days").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("contract_settings_company_uq").on(table.companyId),
  }),
);
