import type {
  ActivityEvent,
  Routine,
  RoutineDetail,
  RoutineListItem,
  RoutineRevision,
  RoutineRun,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
} from "@paperclipai/shared";
import { activityApi } from "./activity";
import { api } from "./client";

export interface RoutineTriggerResponse {
  trigger: RoutineTrigger;
  secretMaterial: RoutineTriggerSecretMaterial | null;
}

export interface RotateRoutineTriggerResponse {
  trigger: RoutineTrigger;
  secretMaterial: RoutineTriggerSecretMaterial;
}

export interface RestoreRoutineRevisionSecretMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

export interface RestoreRoutineRevisionResponse {
  routine: Routine;
  revision: RoutineRevision;
  restoredFromRevisionId: string;
  restoredFromRevisionNumber: number;
  secretMaterials: RestoreRoutineRevisionSecretMaterial[];
}

export interface CustomerInboxDelivery {
  id: string;
  channel: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: string | null;
  outcome: string;
  createdAt: string;
  linkedIssueId: string | null;
  issueIdentifier: string | null;
}

export interface CustomerInboxTestMessageResult {
  outcome: string;
  routineRunId: string | null;
  issueId: string | null;
}

export const routinesApi = {
  list: (companyId: string, filters?: { projectId?: string | null }) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    const query = params.toString();
    return api.get<RoutineListItem[]>(`/companies/${companyId}/routines${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Routine>(`/companies/${companyId}/routines`, data),
  get: (id: string) => api.get<RoutineDetail>(`/routines/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<Routine>(`/routines/${id}`, data),
  listRevisions: (id: string) => api.get<RoutineRevision[]>(`/routines/${id}/revisions`),
  restoreRevision: (
    id: string,
    revisionId: string,
    body: { changeSummary?: string | null } = {},
  ) =>
    api.post<RestoreRoutineRevisionResponse>(
      `/routines/${id}/revisions/${revisionId}/restore`,
      body,
    ),
  listRuns: (id: string, limit: number = 50) => api.get<RoutineRunSummary[]>(`/routines/${id}/runs?limit=${limit}`),
  customerInboxDeliveries: (id: string, limit: number = 100) =>
    api.get<CustomerInboxDelivery[]>(`/routines/${id}/customer-inbox-deliveries?limit=${limit}`),
  sendCustomerInboxTestMessage: (id: string, triggerId: string) =>
    api.post<CustomerInboxTestMessageResult>(
      `/routines/${id}/triggers/${triggerId}/customer-inbox-test-message`,
      {},
    ),
  createTrigger: (id: string, data: Record<string, unknown>) =>
    api.post<RoutineTriggerResponse>(`/routines/${id}/triggers`, data),
  updateTrigger: (id: string, data: Record<string, unknown>) =>
    api.patch<RoutineTrigger>(`/routine-triggers/${id}`, data),
  deleteTrigger: (id: string) => api.delete<void>(`/routine-triggers/${id}`),
  rotateTriggerSecret: (id: string) =>
    api.post<RotateRoutineTriggerResponse>(`/routine-triggers/${id}/rotate-secret`, {}),
  run: (id: string, data?: Record<string, unknown>) =>
    api.post<RoutineRun>(`/routines/${id}/run`, data ?? {}),
  activity: async (
    companyId: string,
    routineId: string,
    related?: { triggerIds?: string[]; runIds?: string[] },
  ) => {
    const requests = [
      activityApi.list(companyId, { entityType: "routine", entityId: routineId }),
      ...(related?.triggerIds ?? []).map((triggerId) =>
        activityApi.list(companyId, { entityType: "routine_trigger", entityId: triggerId })),
      ...(related?.runIds ?? []).map((runId) =>
        activityApi.list(companyId, { entityType: "routine_run", entityId: runId })),
    ];
    const events = (await Promise.all(requests)).flat();
    const deduped = new Map(events.map((event) => [event.id, event]));
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  },
};
