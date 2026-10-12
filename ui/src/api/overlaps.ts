import { api } from "./client";

// Overlaps: two open tasks that change the same file or claim the same
// migration number. Read-only; the server finds and warns about them.

export type OverlapKind = "file" | "migration_number" | "journal_json" | "stale_behind";

export interface OverlapTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string | null;
  assigneeAgentId: string | null;
  assigneeName: string | null;
}

export interface OverlapSummary {
  id: string;
  kind: OverlapKind;
  detail: Record<string, unknown>;
  firstDetectedAt: string;
  lastSeenAt: string;
  warnedAt: string | null;
  issueA: OverlapTask;
  issueB: OverlapTask;
}

export const overlapsApi = {
  list: (companyId: string) => api.get<OverlapSummary[]>(`/companies/${companyId}/overlaps`),
};
