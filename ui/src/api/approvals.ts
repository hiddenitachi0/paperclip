import type {
  Approval,
  ApprovalComment,
  Issue,
  PreviewEnvironment,
  PreviewEnvironmentAvailability,
  SecurityReviewState,
} from "@paperclipai/shared";
import { api } from "./client";

/** What the "Preview this before approving" button needs to know. */
export interface ApprovalPreviewView {
  preview: PreviewEnvironment | null;
  availability: PreviewEnvironmentAvailability;
}

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  // `expectedCardRevision` is the deploy card revision the person was looking at
  // (approvalCardRevision(approval) from lib/approval-card-revision); the server refuses a card that has changed since.
  approve: (
    id: string,
    decisionNote?: string,
    approveWithoutSecurityReview?: { reason: string },
    expectedCardRevision?: number,
  ) =>
    api.post<Approval>(`/approvals/${id}/approve`, {
      decisionNote,
      approveWithoutSecurityReview,
      expectedCardRevision,
    }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestSecurityReview: (id: string) =>
    api.post<SecurityReviewState>(`/approvals/${id}/security-review/request`, {}),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
  getPreview: (id: string) => api.get<ApprovalPreviewView>(`/approvals/${id}/preview`),
  startPreview: (id: string) => api.post<ApprovalPreviewView>(`/approvals/${id}/preview`, {}),
  stopPreview: (id: string) => api.delete<ApprovalPreviewView>(`/approvals/${id}/preview`),
};

