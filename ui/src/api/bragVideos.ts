import { api } from "./client";

// Launch videos ("brag videos") made from a project's code or website.
// Types follow the brag_jobs / brag_scenes tables. The routes and the result
// fields (videoUrl, posterUrl, shareCopy, failureReason, stillUrl) are the
// contract the server pipeline is expected to provide.

export type BragStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";
export type BragFormat = "landscape" | "vertical" | "square";
export type BragSceneApproval = "pending" | "approved" | "rejected";

export interface BragOptions {
  sourceUrl: string | null;
  tone: string | null;
  format: BragFormat;
  lengthSeconds: number;
  music: boolean;
  note: string | null;
}

export interface BragScene {
  id: string;
  sceneOrder: number;
  description: string | null;
  stillUrl: string | null;
  approvalStatus: BragSceneApproval;
}

export interface BragJob extends BragOptions {
  id: string;
  projectId: string;
  status: BragStatus;
  estimatedCostCents: number;
  actualCostCents: number;
  videoUrl: string | null;
  posterUrl: string | null;
  shareCopy: string | null;
  failureReason: string | null;
  scenes: BragScene[];
  createdAt: string;
  updatedAt: string;
}

export interface BragEstimate {
  estimatedCostCents: number;
}

const base = (companyId: string, projectId: string) =>
  `/companies/${companyId}/projects/${projectId}/brag-jobs`;

export const bragVideosApi = {
  list: (companyId: string, projectId: string) =>
    api.get<BragJob[]>(base(companyId, projectId)),
  estimate: (companyId: string, projectId: string, options: BragOptions) =>
    api.post<BragEstimate>(`${base(companyId, projectId)}/estimate`, options),
  create: (companyId: string, projectId: string, options: BragOptions) =>
    api.post<BragJob>(base(companyId, projectId), options),
  updateScene: (
    companyId: string,
    projectId: string,
    jobId: string,
    sceneId: string,
    patch: { approvalStatus?: BragSceneApproval; description?: string },
  ) =>
    api.patch<BragScene>(`${base(companyId, projectId)}/${jobId}/scenes/${sceneId}`, patch),
  startRender: (companyId: string, projectId: string, jobId: string) =>
    api.post<BragJob>(`${base(companyId, projectId)}/${jobId}/render`, {}),
};
