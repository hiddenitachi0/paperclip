export {};

import type { AgentApiKeyScope, DelegateTokenScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        // "service" (DUR-3977) is a per-company machine credential: a
        // server-to-server caller that is neither a person nor an agent. It
        // carries `companyId` and nothing else — no board powers, no agent
        // identity — and only the routes that explicitly call
        // assertServiceOrBoard accept it.
        type: "board" | "agent" | "board_delegate" | "service" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        // Present only when source === "session": the better-auth session row
        // id, so a route can tell "this device" apart from the others.
        sessionId?: string;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        source?:
          | "local_implicit"
          | "session"
          | "board_key"
          | "agent_key"
          | "agent_jwt"
          | "cloud_tenant"
          | "board_delegate_key"
          | "company_service_token"
          // Board chat on a signed-in server: a run's short-lived credential
          // ("board_chat", every write is held for the person's approval) and
          // the single-use credential that replays one approved change
          // ("board_chat_confirmed"). Both act as the person in one company.
          | "board_chat"
          | "board_chat_confirmed"
          | "none";
        // Present only when type === "service": which company service token
        // authenticated this request, so the route can record usage. The
        // token VALUE is never carried here or anywhere else after the
        // lookup.
        serviceTokenId?: string;
        serviceTokenName?: string;
        // Present only when type === "service": the scopes on the token's own
        // row, already filtered to SERVICE_TOKEN_SCOPES. A route that accepts
        // a service token names the scope it needs; an empty list reaches
        // nothing.
        serviceScopes?: string[];
        // Present only when type === "board_delegate": the delegate token's
        // own identity, distinct from userId (the operator whose authority
        // it acts under). Never grants board access on its own -- routes must
        // opt in via assertBoardOrDelegate with a specific required scope.
        delegateTokenId?: string;
        delegateName?: string;
        delegateScopes?: DelegateTokenScope[];
        // Present only for the Board chat sources above.
        boardChatRunId?: string;
        boardChatActionId?: string;
      };
      /**
       * DUR-3977 default-deny marker. Set by `assertServiceOrBoard` (and only
       * there) to record that THIS route explicitly opted into accepting a
       * company service token. `assertAuthenticated` — which every other gate
       * calls, including `assertCompanyAccess` — refuses a service actor when
       * it is absent, which makes the comment on assertServiceOrBoard true by
       * construction: a service token reaches the routes that named it and
       * nothing else, whatever any of the ~300 other `assertCompanyAccess`
       * call sites, or the company-less catalogue routes that only call
       * `assertAuthenticated`, happen to do.
       *
       * It lives on the request rather than on the actor because it is a fact
       * about the route, not about the credential.
       */
      serviceRouteOptIn?: true;
      /**
       * DUR-4094 default-deny marker for the "Employee (light)" company
       * role, the same shape as `serviceRouteOptIn` above. Set by
       * `assertLightAllowed` (and only there) once it has confirmed the
       * signed-in board user's role in this company is not `employee`, or
       * that it is and the admin has switched the named feature on for
       * them. `assertCompanyAccess` refuses a board actor whose active
       * membership role is `employee` when this is absent, so every one of
       * the ~300 existing `assertCompanyAccess` call sites stays closed to
       * light employees with no route-by-route audit required.
       */
      lightRouteOptIn?: true;
      /**
       * Board chat: the held change a single-use Approve credential is bound
       * to. Set by the actor middleware when it consumes that credential; the
       * Board chat guard compares the request with it before any route runs.
       */
      boardChatAction?: {
        id: string;
        companyId: string;
        userId: string;
        issueId: string | null;
        method: string;
        path: string;
        bodyJson: string | null;
        summary: string;
      };
    }
  }
}
