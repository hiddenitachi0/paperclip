import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { normalizeAgentApiKeyScope, normalizeDelegateTokenScopes, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { companyServiceTokenService } from "../services/company-service-tokens.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { readServerSecret } from "../server-secrets.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// DUR-3992: the run states in which an agent is legitimately making API calls
// on behalf of a run. Mirrors ACTIVE_RUN_STATUSES in services/issues.ts.
const AGENT_KEY_ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DUR-3992: an agent API key is a long-lived credential with no run bound to
 * it, so the only run id available is the plain `x-paperclip-run-id` header,
 * which the caller fully controls. Several checks trust `actor.runId`
 * (checkout ownership/release, the self-review-pass bypass, run budget
 * attribution), so a header naming someone else's run -- or a run that has
 * already finished -- must not be believed. Accept it only when that run
 * exists, belongs to this same agent and company, and is still active.
 *
 * Returns the run id to trust, or undefined to treat the request as having no
 * run. On an unexpected database error it fails open to the pre-DUR-3992
 * behaviour (the header as sent) and logs, so an infrastructure hiccup never
 * blocks an agent's action.
 */
export async function resolveAgentKeyRunId(
  db: Db,
  input: { runIdHeader: string | undefined; agentId: string; companyId: string; keyId: string },
): Promise<string | undefined> {
  const runId = input.runIdHeader?.trim();
  if (!runId) return undefined;
  const logContext = { agentId: input.agentId, companyId: input.companyId, keyId: input.keyId, headerRunId: runId };
  if (!UUID_PATTERN.test(runId)) {
    logger.warn({ ...logContext, reason: "malformed" }, "Ignoring x-paperclip-run-id header on agent API key request");
    return undefined;
  }
  let run: { agentId: string; companyId: string; status: string } | null;
  try {
    run = await db
      .select({ agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  } catch (err) {
    logger.error(
      { ...logContext, err },
      "Could not verify x-paperclip-run-id header on agent API key request; keeping it (fail open)",
    );
    return runId;
  }
  let reason: string | null = null;
  if (!run) reason = "run_not_found";
  else if (run.companyId !== input.companyId) reason = "other_company";
  else if (run.agentId !== input.agentId) reason = "other_agent";
  else if (!(AGENT_KEY_ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) reason = `run_${run.status}`;
  if (reason) {
    logger.warn({ ...logContext, reason }, "Ignoring x-paperclip-run-id header on agent API key request");
    return undefined;
  }
  return runId;
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          req.actor = {
            ...cloudTenantActor,
            runId: runIdHeader ?? undefined,
          };
          next();
          return;
        }

        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            db
              .select({
                companyId: companyMemberships.companyId,
                membershipRole: companyMemberships.membershipRole,
                status: companyMemberships.status,
              })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
          ]);
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            sessionId: session.session?.id,
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    // DUR-128: a delegate token authenticates as the delegate acting under
    // the granting operator's authority -- never as the operator ("board")
    // itself. It only ever satisfies assertBoardOrDelegate on the specific
    // scopes it was minted with; assertBoard (merge/deploy approval, and
    // every other board-only route) keeps rejecting it by construction.
    const delegateToken = await boardAuth.findDelegateTokenByToken(token);
    if (delegateToken) {
      const access = await boardAuth.resolveBoardAccess(delegateToken.userId);
      if (access.user) {
        await boardAuth.touchDelegateToken(delegateToken.id);
        req.actor = {
          type: "board_delegate",
          userId: delegateToken.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: false,
          delegateTokenId: delegateToken.id,
          delegateName: delegateToken.name,
          delegateScopes: normalizeDelegateTokenScopes(delegateToken.scopes),
          runId: runIdHeader || undefined,
          source: "board_delegate_key",
        };
        next();
        return;
      }
    }

    // DUR-3977: a per-company service token. It authenticates AS the company
    // and nothing else — no board access, no agent identity, no instance
    // admin. `companyId` comes off the stored row, never off the request, so
    // a caller cannot name a company it was not issued for. Only routes that
    // explicitly call assertServiceOrBoard (today: the Lane A transform
    // endpoint) accept this actor; assertBoard and assertBoardOrAgent both
    // keep refusing it by construction.
    const serviceToken = await companyServiceTokenService(db).findByToken(token);
    if (serviceToken) {
      await companyServiceTokenService(db).touchToken(serviceToken.id);
      req.actor = {
        type: "service",
        companyId: serviceToken.companyId,
        serviceTokenId: serviceToken.id,
        serviceTokenName: serviceToken.name,
        // Already normalized against SERVICE_TOKEN_SCOPES by the lookup, so
        // an unrecognised scope string on the row is dropped rather than
        // carried onto the request.
        serviceScopes: serviceToken.scopes,
        runId: runIdHeader || undefined,
        source: "company_service_token",
      };
      next();
      return;
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      // DUR-3992: the signed token names the run it was minted for; that is
      // the only run this request may act as. A differing plain header is
      // ignored rather than refused so a stale/buggy client header never
      // blocks real work -- the request simply runs as its signed run.
      const headerRunId = runIdHeader?.trim();
      if (headerRunId && headerRunId !== claims.run_id) {
        logger.warn(
          {
            agentId: claims.sub,
            companyId: claims.company_id,
            tokenRunId: claims.run_id,
            headerRunId,
          },
          "Ignoring x-paperclip-run-id header that differs from the agent JWT run",
        );
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: claims.run_id || undefined,
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    const trustedRunId = await resolveAgentKeyRunId(db, {
      runIdHeader,
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
    });

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      keyScope: normalizeAgentApiKeyScope(key.scopeConfig),
      runId: trustedRunId,
      source: "agent_key",
    };

    next();
  };
}

export async function resolveCloudTenantActor(db: Db, req: Request): Promise<Express.Request["actor"] | null> {
  const expectedToken = readServerSecret("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN")?.trim();
  if (!expectedToken) return null;

  const token = req.header("x-paperclip-cloud-tenant-token")?.trim();
  if (!token || !constantTimeStringEqual(token, expectedToken)) return null;

  const userId = requiredCloudHeader(req, "x-paperclip-cloud-user-id");
  const userEmail = requiredCloudHeader(req, "x-paperclip-cloud-user-email").toLowerCase();
  const stackId = requiredCloudHeader(req, "x-paperclip-cloud-stack-id");
  const stackRole = stackMembershipRole(req.header("x-paperclip-cloud-stack-role"));
  const userName = req.header("x-paperclip-cloud-user-name")?.trim() || userEmail;
  const paperclipCompanyId = req.header("x-paperclip-cloud-paperclip-company-id")?.trim();
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyId || `${stackId} Paperclip`;
  const now = new Date();

  await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email: userEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email: userEmail,
        emailVerified: true,
        updatedAt: now,
      },
    });

  // Earlier cloud_tenant builds granted every tenant user `instance_admin`.
  // Stale rows from those deployments would still elevate this user through
  // the BetterAuth session path, board API keys, and the authorization
  // service's own instanceUserRoles lookup — so actively purge them on every
  // trusted-header authentication instead of merely no longer inserting them.
  await db
    .delete(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));

  await db
    .insert(companies)
    .values({
      id: companyId,
      name: companyName,
      description: `Provisioned by Paperclip Cloud for stack ${stackId}.`,
      status: "active",
      issuePrefix: issuePrefixForCloudStack(stackId),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: companies.id,
    });

  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const membership = await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole,
        updatedAt: now,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? {
      companyId,
      membershipRole,
      status: "active",
    });

  // Without instance-admin elevation, cloud tenant users are authorized purely
  // through company-scoped permission grants — seed the same role defaults the
  // regular membership flows create.
  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: membership.membershipRole,
    grantedByUserId: null,
  });

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId],
    memberships: [{
      companyId,
      membershipRole: membership.membershipRole,
      status: membership.status,
    }],
    isInstanceAdmin: false,
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) {
    throw new Error(`Missing trusted Cloud tenant header ${name}`);
  }
  return value;
}

function stackMembershipRole(value: string | undefined): "owner" | "admin" | "member" | "support" {
  if (value === "owner" || value === "admin" || value === "member" || value === "support") {
    return value;
  }
  throw new Error("Invalid trusted Cloud tenant stack role");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
