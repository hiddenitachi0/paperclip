import type {
  BragEstimateInput,
  BragEstimateResult,
  BragFormat,
  BragJobStatus,
  BragSceneApprovalStatus,
  CreateBragJobInput,
  UpdateBragSceneInput,
} from "@paperclipai/shared";
import { api } from "./client";

// Brag video: a short launch video made from a project's code or website.
// Nothing here posts the video anywhere; it is only saved and shown back.

export interface BragJob {
  id: string;
  projectId: string;
  status: BragJobStatus;
  sourceUrl: string | null;
  tone: string | null;
  format: BragFormat;
  lengthSeconds: number;
  music: boolean;
  note: string | null;
  estimatedCostCents: number;
  actualCostCents: number;
  options: { issueId?: string | null; videoFileId?: string; posterFileId?: string; shareCopy?: string };
}

export interface BragScene {
  id: string;
  jobId: string;
  sceneOrder: number;
  description: string | null;
  stillRef: string | null;
  approvalStatus: BragSceneApprovalStatus;
}

export interface BragJobWithScenes {
  job: BragJob;
  scenes: BragScene[];
}

/** The scene still has no attachment/file row of its own, so the UI builds this path straight from the scene id. */
export function bragSceneStillPath(companyId: string, jobId: string, sceneId: string): string {
  return `/api/companies/${companyId}/brag/jobs/${jobId}/scenes/${sceneId}/still/content`;
}

/** The finished video and poster are saved as a normal attachment/company file, so they use the shared content route. */
export function bragFilePath(fileId: string): string {
  return `/api/attachments/${fileId}/content`;
}

export const bragApi = {
  estimate: (companyId: string, input: BragEstimateInput) =>
    api.post<BragEstimateResult>(`/companies/${companyId}/brag/estimate`, input),
  createJob: (companyId: string, input: CreateBragJobInput) =>
    api.post<BragJob>(`/companies/${companyId}/brag/jobs`, input),
  planJob: (companyId: string, jobId: string) =>
    api.post<BragJobWithScenes>(`/companies/${companyId}/brag/jobs/${jobId}/plan`, {}),
  updateScene: (companyId: string, jobId: string, sceneId: string, input: UpdateBragSceneInput) =>
    api.patch<BragScene[]>(`/companies/${companyId}/brag/jobs/${jobId}/scenes/${sceneId}`, input),
  render: (companyId: string, jobId: string) =>
    api.post<BragJobWithScenes>(`/companies/${companyId}/brag/jobs/${jobId}/render`, {}),
};
