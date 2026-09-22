import type {
  CreateDataConnectionInput,
  DataConnectionCheckResult,
  DataConnectionCredentialInput,
  DataConnectionSummary,
  DataDatasetSourceSummary,
  DataDataset,
  DataReadEventSummary,
  DataTrialCalculationResult,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * DUR-3972 slice S2 / DUR-3997 slice 3: the "Datakilder" screen in company
 * settings.
 *
 * A source's key only ever travels one way: in the body of `create` and of an
 * `update` that replaces it. No response type below has room for it; the
 * server answers with a masked hint (the last four characters).
 *
 * `create` takes the shared discriminated union: the Shopify shape is exactly
 * what it was, and WooCommerce, Fiken and SFTP-file connections are accepted
 * and stored (shown as "kommer snart" until their adapters ship).
 */
export type CreateDataConnectionRequest = {
  [K in CreateDataConnectionInput["kind"]]: Omit<Extract<CreateDataConnectionInput, { kind: K }>, "name" | "port"> & {
    name: string;
    port?: number;
  };
}[CreateDataConnectionInput["kind"]];

export const dataConnectionsApi = {
  list: (companyId: string) =>
    api.get<DataConnectionSummary[]>(`/companies/${companyId}/data-connections`),
  create: (companyId: string, data: CreateDataConnectionRequest) =>
    api.post<DataConnectionSummary>(`/companies/${companyId}/data-connections`, data),
  update: (
    companyId: string,
    connectionId: string,
    data: {
      name?: string;
      dailyLookupCap?: number;
      status?: "active" | "disabled";
      credential?: DataConnectionCredentialInput;
    },
  ) =>
    api.patch<DataConnectionSummary>(
      `/companies/${companyId}/data-connections/${encodeURIComponent(connectionId)}`,
      data,
    ),
  remove: (companyId: string, connectionId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/data-connections/${encodeURIComponent(connectionId)}`),
  test: (companyId: string, connectionId: string) =>
    api.post<DataConnectionCheckResult>(
      `/companies/${companyId}/data-connections/${encodeURIComponent(connectionId)}/test`,
      {},
    ),
  trial: (companyId: string, connectionId: string, data: { periods: string[]; groupBy: "none" | "product_type" }) =>
    api.post<DataTrialCalculationResult>(
      `/companies/${companyId}/data-connections/${encodeURIComponent(connectionId)}/trial`,
      data,
    ),
  listDatasetSources: (companyId: string) =>
    api.get<DataDatasetSourceSummary[]>(`/companies/${companyId}/dataset-sources`),
  setDatasetSource: (companyId: string, dataset: DataDataset, connectionId: string | null) =>
    api.put<{ dataset: DataDataset; source: DataDatasetSourceSummary | null }>(
      `/companies/${companyId}/dataset-sources/${dataset}`,
      { connectionId },
    ),
  listReads: (companyId: string, limit = 20) =>
    api.get<DataReadEventSummary[]>(`/companies/${companyId}/data-reads?limit=${limit}`),
};
