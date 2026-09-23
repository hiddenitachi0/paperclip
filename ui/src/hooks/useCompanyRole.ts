import { useQuery } from "@tanstack/react-query";
import { accessApi, type HumanCompanyRole } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

/**
 * DUR-3997: who may add and change connections.
 *
 * The rule Filip decided: the company owner and admins may add or change
 * connections (AI-provider keys, bots, service tokens, data sources);
 * operators and viewers see status only. This hook answers that question for
 * the signed-in user from the same two facts every other page already loads:
 * the session, and the board-access summary with the user's memberships.
 *
 * It is a UI convenience, not a gate. Every write goes to a server route with
 * its own authz, which is what actually refuses a request; this only decides
 * whether to draw the button.
 *
 * On the local single-user board there is no sign-in at all, so there is no
 * role to look up: that person is the operator of the whole box and sees
 * everything.
 */
export interface CompanyRoleInfo {
  /** The user's active role in this company, or null when there is none / it is unknown. */
  role: HumanCompanyRole | "member" | null;
  isInstanceAdmin: boolean;
  /** True on the local board that has no sign-in. */
  localBoard: boolean;
  /** Owner, admin, instance admin or the local board. */
  canManageConnections: boolean;
  /** True while the session or the access summary is still loading. */
  isLoading: boolean;
}

export function companyRoleFromAccess(
  companyId: string | null | undefined,
  access: {
    isInstanceAdmin?: boolean;
    memberships?: Array<{
      companyId: string;
      membershipRole: HumanCompanyRole | "member" | null;
      status: string;
    }>;
  } | null | undefined,
): Pick<CompanyRoleInfo, "role" | "isInstanceAdmin" | "canManageConnections"> {
  const isInstanceAdmin = access?.isInstanceAdmin === true;
  const membership = companyId
    ? (access?.memberships ?? []).find((item) => item.companyId === companyId && item.status === "active")
    : undefined;
  const role = membership?.membershipRole ?? null;
  return {
    role,
    isInstanceAdmin,
    canManageConnections: isInstanceAdmin || role === "owner" || role === "admin",
  };
}

export function useCompanyRole(companyId: string | null | undefined): CompanyRoleInfo {
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const accessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: Boolean(currentUserId),
    retry: false,
  });

  if (sessionQuery.isPending) {
    return { role: null, isInstanceAdmin: false, localBoard: false, canManageConnections: false, isLoading: true };
  }
  if (!currentUserId) {
    // No sign-in on this Paperclip: the local board runs the whole box.
    return { role: null, isInstanceAdmin: true, localBoard: true, canManageConnections: true, isLoading: false };
  }
  if (accessQuery.isPending) {
    return { role: null, isInstanceAdmin: false, localBoard: false, canManageConnections: false, isLoading: true };
  }
  return {
    ...companyRoleFromAccess(companyId, accessQuery.data),
    localBoard: false,
    isLoading: false,
  };
}
