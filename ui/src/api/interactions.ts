import type { IssueThreadInteraction } from "@paperclipai/shared";
import { api } from "./client";

/**
 * A pending issue-thread interaction enriched with the issue it belongs to,
 * for rendering outside the issue thread (e.g. the Needs-you lane on Now).
 * Every kind can only be accepted/rejected by a board actor, so "pending"
 * already means "an unresolved ask directed at the operator" (DUR-30).
 */
export type PendingCompanyInteraction = IssueThreadInteraction & {
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  createdByAgentName: string | null;
};

export const interactionsApi = {
  listPendingForCompany: (companyId: string) =>
    api.get<PendingCompanyInteraction[]>(
      `/companies/${companyId}/interactions?status=pending`,
    ),
};
