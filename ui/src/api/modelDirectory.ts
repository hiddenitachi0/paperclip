import type {
  CreateModelDirectoryEntry,
  ModelDirectoryEntry,
  ModelDirectoryStarterStatus,
  UpdateModelDirectoryEntry,
} from "@paperclipai/shared";
import { api } from "./client";

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
};
