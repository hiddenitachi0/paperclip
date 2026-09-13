import type { ServiceTokenScope } from "@paperclipai/shared";
import { api } from "./client";

export type ServiceTokenScopeValue = ServiceTokenScope;

/**
 * What the "Lag nøkkel" button mints. Written out here rather than spread from
 * the shared allowlist so that adding a scope to the platform cannot widen the
 * key this screen creates without someone editing this line.
 */
export const LANE_A_TRANSFORM_SCOPES: ServiceTokenScopeValue[] = ["lane_a:transform"];

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
  /**
   * `scopes` is required here on purpose. The server has a default, but a
   * default is the wrong place for the UI to get its answer from: when a
   * second scope is added, a create call that says nothing would start minting
   * a wider key than the board user chose. The screen mints exactly what it
   * describes, and nothing else.
   */
  create: (companyId: string, data: { name: string; scopes: ServiceTokenScopeValue[] }) =>
    api.post<CreatedServiceToken>(`/companies/${companyId}/service-tokens`, data),
  revoke: (companyId: string, tokenId: string) =>
    api.post<{ ok: true; serviceTokenId: string }>(
      `/companies/${companyId}/service-tokens/${encodeURIComponent(tokenId)}/revoke`,
      {},
    ),
};
