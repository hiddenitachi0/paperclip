import { useCompanyRole } from "./useCompanyRole";

/**
 * Contracts are confidential, so the Legal screens are for board members of
 * this company who can change things. Read-only "viewer" members are refused
 * by the server and the link is not drawn for them either. This only decides
 * whether to draw the link; the server is what actually says no.
 *
 * While the role is still loading the answer is "no", so the link never
 * flashes up for someone who then loses it.
 */
export function useCanUseContracts(companyId: string | null | undefined): boolean {
  const role = useCompanyRole(companyId);
  if (role.isLoading) return false;
  if (role.localBoard || role.isInstanceAdmin) return true;
  return role.role !== null && role.role !== "viewer";
}
