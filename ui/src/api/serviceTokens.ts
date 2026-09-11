import { api } from "./client";

/**
 * DUR-3977: per-company machine credentials for server-to-server calls.
 * `token` is present ONLY on the create response — the server stores a hash
 * and cannot give it back, so the UI must show it once and then forget it.
 */
export type ServiceTokenSummary = {
  id: string;
  companyId: string;
  name: string;
  /**
   * What this key may reach. Today the only value is "lane_a:transform" — the
   * rewrite call plus the read that lists which quick agents it may name. A
   * key with an empty list reaches nothing.
   */
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
};

export type CreatedServiceToken = ServiceTokenSummary & { token: string };

export const serviceTokensApi = {
  list: (companyId: string) =>
    api.get<ServiceTokenSummary[]>(`/companies/${companyId}/service-tokens`),
  create: (companyId: string, data: { name: string }) =>
    api.post<CreatedServiceToken>(`/companies/${companyId}/service-tokens`, data),
  revoke: (companyId: string, tokenId: string) =>
    api.post<{ ok: true; serviceTokenId: string }>(
      `/companies/${companyId}/service-tokens/${encodeURIComponent(tokenId)}/revoke`,
      {},
    ),
};
