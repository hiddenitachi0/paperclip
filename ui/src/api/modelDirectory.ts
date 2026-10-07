import type {
  CreateModelDirectoryEntry,
  ModelDirectoryEntry,
  ModelDirectoryStarterStatus,
  ModelConverterOp,
  ModelProbeSetResult,
  UpdateModelDirectoryEntry,
} from "@paperclipai/shared";
import { api } from "./client";

export type ModelReviewChangeStatus = "applied" | "proposed" | "declined" | "undone";
export interface ModelReviewSettings {
  defaultThinking: "on" | "off" | null;
  defaultTemperature: number | null;
  defaultMaxOutputTokens: number | null;
}
export interface ModelReviewState {
  settings: ModelReviewSettings;
  ops: ModelConverterOp[];
}
export interface ModelReviewChange {
  id: string;
  code: string;
  title: string;
  why: string;
  status: ModelReviewChangeStatus;
  dropsCapability: boolean;
  before: ModelReviewState;
  after: ModelReviewState;
  decidedAt: string | null;
}
export interface ModelReview {
  id: string;
  entryId: string;
  trigger: string;
  createdAt: string;
  report: {
    summary: string;
    scores: { chat: number | null; tools: number | null; pictures: number | null; speed: number | null };
    findings: Array<{ code: string; text: string }>;
    probes: ModelProbeSetResult;
  };
  changes: ModelReviewChange[];
}

/** Saved model setups for a company ("Settings > Models"). Never carries a key. */
export const modelDirectoryApi = {
  list: (companyId: string) => api.get<ModelDirectoryEntry[]>(`/companies/${companyId}/model-directory`),
  create: (companyId: string, body: CreateModelDirectoryEntry) =>
    api.post<ModelDirectoryEntry>(`/companies/${companyId}/model-directory`, body),
  update: (companyId: string, entryId: string, body: UpdateModelDirectoryEntry) =>
    api.patch<ModelDirectoryEntry>(`/companies/${companyId}/model-directory/${entryId}`, body),
  remove: (companyId: string, entryId: string) =>
    api.delete<void>(`/companies/${companyId}/model-directory/${entryId}`),
  duplicate: (companyId: string, entryId: string) =>
    api.post<ModelDirectoryEntry>(`/companies/${companyId}/model-directory/${entryId}/duplicate`, {}),
  listStarters: (companyId: string) =>
    api.get<ModelDirectoryStarterStatus[]>(`/companies/${companyId}/model-directory/starters`),
  addStarters: (companyId: string, starterIds?: string[]) =>
    api.post<ModelDirectoryEntry[]>(
      `/companies/${companyId}/model-directory/starters`,
      starterIds ? { starterIds } : {},
    ),
  listReviews: (companyId: string, entryId: string) =>
    api.get<ModelReview[]>(`/companies/${companyId}/model-directory/${entryId}/reviews`),
  runReview: (companyId: string, entryId: string) =>
    api.post<ModelReview>(`/companies/${companyId}/model-directory/${entryId}/reviews`, {}),
  decideChange: (
    companyId: string,
    entryId: string,
    reviewId: string,
    changeId: string,
    action: "apply" | "decline" | "undo",
  ) =>
    api.post<ModelReview>(
      `/companies/${companyId}/model-directory/${entryId}/reviews/${reviewId}/changes/${changeId}/${action}`,
      {},
    ),
};
