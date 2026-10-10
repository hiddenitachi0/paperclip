import { z } from "zod";

/**
 * Franchise migration, phase B: the two-phase cutover when a company moves
 * from one Paperclip to another.
 *
 *   1. On the DESTINATION, after the import, "Verify destination" runs a
 *      read-only check (agents, Claude sign-in, secrets, projects, routines,
 *      data connections) and says in plain words what is missing and how to
 *      fix it.
 *   2. On the SOURCE, "Mark as migrated" pauses the company's agents and
 *      routines and shows "This company has moved to <url>". Nothing is
 *      deleted; "Undo: resume here" puts it back.
 */

export type CompanyMigrationCheckStatus = "ok" | "warning" | "problem";

export type CompanyMigrationCheckSectionKey =
  | "agents"
  | "claude_login"
  | "secrets"
  | "projects"
  | "routines"
  | "data_connections";

export interface CompanyMigrationCheckItem {
  label: string;
  status: CompanyMigrationCheckStatus;
  /** One plain sentence about this item. */
  detail: string;
  /** What to do about it, in plain words; null when nothing needs doing. */
  fixHint: string | null;
}

export interface CompanyMigrationCheckSection {
  key: CompanyMigrationCheckSectionKey;
  title: string;
  status: CompanyMigrationCheckStatus;
  /** One plain sentence summing the section up. */
  summary: string;
  items: CompanyMigrationCheckItem[];
}

export interface CompanyMigrationVerifyReport {
  companyId: string;
  companyName: string;
  checkedAt: string;
  /** Worst status across all sections. */
  status: CompanyMigrationCheckStatus;
  sections: CompanyMigrationCheckSection[];
}

export interface CompanyMigrationState {
  migratedToUrl: string | null;
  migratedAt: string | null;
  migratedByUserId: string | null;
}

export interface CompanyMarkMigratedResult extends CompanyMigrationState {
  companyId: string;
  agentsPaused: number;
  routinesPaused: number;
}

export interface CompanyUndoMigratedResult extends CompanyMigrationState {
  companyId: string;
  agentsResumed: number;
  routinesResumed: number;
}

export function worstMigrationCheckStatus(
  statuses: Iterable<CompanyMigrationCheckStatus>,
): CompanyMigrationCheckStatus {
  let worst: CompanyMigrationCheckStatus = "ok";
  for (const status of statuses) {
    if (status === "problem") return "problem";
    if (status === "warning") worst = "warning";
  }
  return worst;
}

export const COMPANY_MIGRATION_URL_MAX_LENGTH = 2048;

/**
 * The second confirmation for "Mark as migrated": the person types the
 * company's name. Compared trimmed and case-insensitively.
 */
export function companyMigrationNameMatches(typed: string, companyName: string): boolean {
  return typed.trim().toLowerCase() === companyName.trim().toLowerCase() && typed.trim().length > 0;
}

export const markCompanyMigratedSchema = z.object({
  destinationUrl: z
    .string()
    .trim()
    .min(1, "Enter the address of the new Paperclip.")
    .max(COMPANY_MIGRATION_URL_MAX_LENGTH)
    .url("Enter a full web address, starting with https://")
    .refine((value) => /^https?:\/\//i.test(value), "Enter a full web address, starting with https://"),
  confirmCompanyName: z.string().min(1, "Type the company's name to confirm."),
});

export type MarkCompanyMigrated = z.infer<typeof markCompanyMigratedSchema>;
