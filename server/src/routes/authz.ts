import type { Request } from "express";
import type { DelegateTokenScope } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import type { accessService } from "../services/access.js";
import { logger } from "../middleware/logger.js";

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

// DUR-128: recovery-only routes (clear-error, resume, retry-a-stuck-run) may
// opt into accepting a delegate token scoped for that specific action, in
// addition to the operator's own "board" session. Nothing else should call
// this -- approving a merge or a deploy stays assertBoard-only so a delegate
// token can never reach it, regardless of what scopes it holds.
export function assertBoardOrDelegate(req: Request, requiredScope: DelegateTokenScope) {
  if (req.actor.type === "board") return;
  if (req.actor.type === "board_delegate") {
    if (req.actor.delegateScopes?.includes(requiredScope)) return;
    throw forbidden(`Delegate token is not scoped for ${requiredScope}`);
  }
  throw forbidden("Board or delegate access required");
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    logger.error({
      event: "security.cross_company_write_blocked",
      actorType: "agent",
      actorAgentId: req.actor.agentId ?? null,
      actorCompanyId: req.actor.companyId,
      targetCompanyId: companyId,
      method: req.method,
      path: req.originalUrl ?? req.path,
    }, "Refused a cross-company write attempt: agent key does not belong to the target company");
    throw forbidden("Agent key cannot access another company");
  }
  if (
    (req.actor.type === "board" && req.actor.source !== "local_implicit") ||
    req.actor.type === "board_delegate"
  ) {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

// Shared by the agent config routes (PATCH /agents/:id) and the agent
// avatar routes (POST/DELETE .../agents/:agentId/avatar in assets.ts) so
// "who may update this agent's record" is decided in exactly one place.
export async function assertCanUpdateAgent(
  req: Request,
  targetAgent: { id: string; companyId: string },
  access: ReturnType<typeof accessService>,
) {
  assertCompanyAccess(req, targetAgent.companyId);
  const decision = await access.decide({
    actor: req.actor,
    action: "agent_config:update",
    resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
  });
  if (decision.allowed) return;
  throw forbidden(decision.explanation);
}

export function getActorInfo(req: Request): (
  {
    actorType: "agent";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    actorSource: "agent_key" | "agent_jwt";
  }
  | {
    actorType: "user";
    actorId: string;
    agentId: null;
    runId: string | null;
    actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
  }
) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    const actorSource = req.actor.source === "agent_jwt" ? "agent_jwt" : "agent_key";
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      actorSource,
    };
  }

  const actorSource =
    req.actor.source === "local_implicit" ||
      req.actor.source === "board_key" ||
      req.actor.source === "cloud_tenant"
      ? req.actor.source
      : "session";

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
    actorSource,
  };
}
