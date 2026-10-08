import type {
  CreateModelDirectoryEntry,
  ImportModelDirectoryCatalogue,
  LocalModelsSyncResult,
  ModelDirectoryCatalogueExport,
  ModelDirectoryCatalogueImportResult,
  ModelDirectoryEntry,
  ModelDirectorySettings,
  ModelDirectoryStarterStatus,
  ModelConverterOp,
  ModelProbeSetResult,
  UpdateModelDirectoryEntry,
  UpdateModelDirectorySettings,
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
  /** Archived setups are left out unless includeArchived is set (Settings > Models "Show archived"). */
  list: (companyId: string, opts: { includeArchived?: boolean } = {}) =>
    api.get<ModelDirectoryEntry[]>(
      `/companies/${companyId}/model-directory${opts.includeArchived ? "?includeArchived=true" : ""}`,
    ),
  create: (companyId: string, body: CreateModelDirectoryEntry) =>
    api.post<ModelDirectoryEntry>(`/companies/${companyId}/model-directory`, body),
  /** Also archives / restores: update(companyId, entryId, { archived: true | false }). */
  update: (companyId: string, entryId: string, body: UpdateModelDirectoryEntry) =>
    api.patch<ModelDirectoryEntry>(`/companies/${companyId}/model-directory/${entryId}`, body),
  archive: (companyId: string, entryId: string, archived = true) =>
    api.patch<ModelDirectoryEntry>(`/companies/${companyId}/model-directory/${entryId}`, { archived }),
  /** The whole catalogue as a file (archived included, backups by name, never a key). */
  exportCatalogue: (companyId: string) =>
    api.get<ModelDirectoryCatalogueExport>(`/companies/${companyId}/model-directory/export`),
  /** Imports a catalogue file; same-name setups are skipped unless onExisting is "update". */
  importCatalogue: (companyId: string, body: ImportModelDirectoryCatalogue) =>
    api.post<ModelDirectoryCatalogueImportResult>(`/companies/${companyId}/model-directory/import`, body),
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
  /** Settings > Models settings (the model PC's graphics memory). */
  getSettings: (companyId: string) =>
    api.get<ModelDirectorySettings>(`/companies/${companyId}/model-directory/settings`),
  updateSettings: (companyId: string, body: UpdateModelDirectorySettings) =>
    api.put<ModelDirectorySettings>(`/companies/${companyId}/model-directory/settings`, body),
  /** Asks the local Ollama at a saved local address which models are installed and marks the setups there. */
  syncLocal: (companyId: string, baseUrl: string) =>
    api.post<LocalModelsSyncResult>(`/companies/${companyId}/model-directory/local-sync`, { baseUrl }),
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
