import type { Request } from "express";
import type { DelegateTokenScope, ServiceTokenScope } from "@paperclipai/shared";
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

// DUR-3977: the machine-to-machine lane. A per-company service token may
// reach exactly the routes that opt in here, and nothing else — it is not
// board (so it can never approve, deploy, mint another token, or read another
// company) and it is not an agent (so it carries no agent identity). A board
// user is also allowed through, so an operator can exercise the same route
// from the UI without minting a token first.
//
// Two things make that paragraph true rather than aspirational, and both are
// enforced here:
//
//   1. The token must actually HOLD the named scope. Scopes are stored on the
//      token row (company_service_tokens.scopes) exactly as board_delegate
//      tokens store theirs, so a credential minted for the transform lane
//      cannot reach a future route that asks for a different scope, even
//      after that route is written.
//   2. Reaching this function is what marks the request as service-eligible
//      (`req.serviceRouteOptIn`). `assertCompanyAccess` below refuses a
//      service actor without that marker, so every other route in the API —
//      the ~300 that call assertCompanyAccess and were written years before
//      this actor type existed — stays closed by default. A route that wants
//      the machine lane has to say so, here, on purpose.
export function assertServiceOrBoard(req: Request, requiredScope: ServiceTokenScope) {
  if (req.actor.type === "service") {
    const scopes = req.actor.serviceScopes ?? [];
    if (!scopes.includes(requiredScope)) {
      logger.warn({
        event: "security.service_token_scope_denied",
        actorCompanyId: req.actor.companyId,
        serviceTokenId: req.actor.serviceTokenId ?? null,
        requiredScope,
        method: req.method,
        path: req.originalUrl ?? req.path,
      }, "Refused a service token that does not hold the scope this route requires");
      throw forbidden(`Service token is not scoped for ${requiredScope}`);
    }
    req.serviceRouteOptIn = true;
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("A company service token or board access is required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  // DUR-3977 default-deny. A company service token is the first credential
  // Paperclip has ever issued to a system outside itself, so "which routes can
  // it reach" must be a list someone wrote down, not a side effect of which
  // assert helper a route happened to pick years ago. Without this branch a
  // service token would pass every one of the ~300 assertCompanyAccess call
  // sites for its own company — the company dashboard, issue attachments, and
  // POST /api/chat/classify, which is an uncapped metered Anthropic call.
  //
  // The marker is set by assertServiceOrBoard and nowhere else, so the
  // allowed set is exactly "the routes that named a service-token scope".
  if (req.actor.type === "service" && req.serviceRouteOptIn !== true) {
    logger.error({
      event: "security.service_token_route_denied",
      actorCompanyId: req.actor.companyId,
      serviceTokenId: req.actor.serviceTokenId ?? null,
      targetCompanyId: companyId,
      method: req.method,
      path: req.originalUrl ?? req.path,
    }, "Refused a company service token on a route that does not accept service tokens");
    throw forbidden("This endpoint does not accept company service tokens");
  }
  // A service token authenticates AS one company. Same rule, and the same
  // loud refusal, as an agent key reaching for another company's data — this
  // is the check that keeps the standing cross-company isolation requirement
  // true for the new machine lane.
  if (req.actor.type === "service" && req.actor.companyId !== companyId) {
    logger.error({
      event: "security.cross_company_write_blocked",
      actorType: "service",
      actorCompanyId: req.actor.companyId,
      targetCompanyId: companyId,
      method: req.method,
      path: req.originalUrl ?? req.path,
    }, "Refused a cross-company request: service token does not belong to the target company");
    throw forbidden("Service token cannot access another company");
  }
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
  // DUR-3977: a service token is neither a user nor an agent. Falling through
  // to the user branch below would silently report it as actorId "board",
  // i.e. attribute a machine call to the operator. Refuse instead — a route
  // that accepts service tokens must attribute them deliberately rather than
  // reach for this helper.
  if (req.actor.type === "service") {
    throw forbidden("A company service token has no user or agent identity");
  }
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
