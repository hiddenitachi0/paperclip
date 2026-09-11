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
      };
      /**
       * DUR-3977 default-deny marker. Set by `assertServiceOrBoard` (and only
       * there) to record that THIS route explicitly opted into accepting a
       * company service token. `assertCompanyAccess` refuses a service actor
       * when it is absent, which makes the comment on assertServiceOrBoard
       * true by construction: a service token reaches the routes that named
       * it and nothing else, whatever any of the ~300 other
       * `assertCompanyAccess` call sites do.
       *
       * It lives on the request rather than on the actor because it is a fact
       * about the route, not about the credential.
       */
      serviceRouteOptIn?: true;
    }
  }
}
