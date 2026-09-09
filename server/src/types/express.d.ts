export {};

import type { AgentApiKeyScope, DelegateTokenScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "board_delegate" | "none";
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
          | "none";
        // Present only when type === "board_delegate": the delegate token's
        // own identity, distinct from userId (the operator whose authority
        // it acts under). Never grants board access on its own -- routes must
        // opt in via assertBoardOrDelegate with a specific required scope.
        delegateTokenId?: string;
        delegateName?: string;
        delegateScopes?: DelegateTokenScope[];
      };
    }
  }
}
