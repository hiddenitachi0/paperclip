import { api } from "./client";

/**
 * DUR-62: the weekly check-up. Both calls are board-only on the server.
 */

export interface CheckupReportSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  createdAt: string | Date;
}

export interface LatestCheckupResponse {
  /** The open report, or null when none is open right now. */
  report: CheckupReportSummary | null;
  /** How many suggestions the report proposed in total. */
  suggestionCount: number;
  /** How many of them still wait for the operator to accept or reject. */
  pendingSuggestionCount: number;
  suggestionsStatus: "pending" | "accepted" | "rejected" | "none";
}

export interface RunCheckupResponse {
  outcome: "created" | "existing" | "dry_run";
  dryRun: boolean;
  reportIssueId: string | null;
  reportIdentifier: string | null;
  /** One plain sentence saying what happened, written for the operator. */
  message: string;
  title: string;
  body: string;
  findingCount: number;
  findings: Array<{ fingerprint: string; severity: string; headline: string; suggestion: string }>;
}

export const checkupsApi = {
  latest: (companyId: string) => api.get<LatestCheckupResponse>(`/companies/${companyId}/checkups/latest`),
  run: (companyId: string, input: { dryRun?: boolean } = {}) =>
    api.post<RunCheckupResponse>(`/companies/${companyId}/checkups/run`, input),
};
