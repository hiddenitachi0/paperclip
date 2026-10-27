import { randomUUID } from "node:crypto";
import type { Express } from "express";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentMemories,
  agents,
  approvals,
  assets,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  crmContacts,
  documents,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  jobs,
  labels,
  modelDirectoryEntries,
  personas,
  pipelines,
  projects,
  reportScripts,
  routines,
  videoStorylines,
  watchers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boardAuthService } from "../services/board-auth.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { companyServiceTokenService } from "../services/company-service-tokens.js";

/**
 * Cross-company isolation, proven over the WHOLE app.
 * Owner-facing write-up: docs/security/cross-company-isolation.md.
 *
 * One Paperclip instance hosts several companies. The promise is that nothing
 * belonging to one company is visible to, or changeable by, another
 * company's people or agents unless someone sets up an explicit, audited
 * link. This file checks that promise without a hand-written list of routes,
 * the same way company-service-token-every-route.test.ts does: it builds the
 * production app with `createApp`, records every route the real server
 * registers, and drives every one of them.
 *
 * Two companies are seeded with one of everything a tenant owns (agents,
 * issues, comments, documents, a secret, approvals, routines, skills, costs,
 * activity, memories, storylines, model-catalogue entries, ...). Every text
 * field company B ("Nordstrand") owns carries a unique canary string, and B's
 * secret has a unique value. Company A ("Durkan") is the would-be intruder:
 * its owner's board API key, its agent's API key and its service token are
 * fired at every route.
 *
 * SWEEP 1 -- reach into B. Every route, every one of A's credentials, twice:
 *   - "B-path":        every id in the URL (company and resources) is B's.
 *   - "A-path+B-ids":  the company param is A's own -- so the ordinary
 *                      membership check PASSES -- but every resource id in the
 *                      URL is B's. This is the classic tenant hole: a route
 *                      that checks the company in the URL and then loads the
 *                      resource by id alone.
 *
 * SWEEP 2 -- link A's records to B's. Every POST/PUT/PATCH route that A can
 * successfully call on its OWN records is called again with exactly one
 * reference field in the body swapped for B's id (assigneeAgentId,
 * projectId, goalIds, parentId, labelIds, secretId, ... one at a time, so a
 * route that validates one field cannot hide a route that ignores another).
 *
 * Asserted, generically, over both sweeps:
 *   a. No response to any of A's credentials contains B's canary or B's
 *      secret value.
 *   b. Every database row, in every table, that mentions B (by any of B's ids
 *      or its canary) is byte-for-byte the same afterwards, and no new row
 *      mentions B -- except refusal audit records (see AUDIT_ROW_ALLOWED).
 *   c. No route answers 2xx to A for a URL whose company is B, except the
 *      instance-wide reads in B_PATH_2XX_ALLOWED.
 *
 * If a probe logs A's credential out (POST /api/cli-auth/revoke-current
 * revokes the key it is called with; an agent can pause itself), the actor is
 * re-issued a credential and the probe repeated, so coverage after that route
 * is not silently lost. The re-issues are printed.
 */

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-cross-company-isolation-sweep";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest-cross-company-isolation-sweep";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-cross-company-isolation-sweep/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping the cross-company isolation sweep on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Prefix shared by both tenants' markers; sent as ?q= on every GET. */
const SEARCH_PROBE = "ZZQ";
const SEARCH_QUERY = `q=${SEARCH_PROBE}&query=${SEARCH_PROBE}&search=${SEARCH_PROBE}`;

/** A write route slower than this is probed once, not once per reference field. */
const SLOW_ROUTE_MS = 1_500;

/**
 * Routes that may answer 2xx to company A even though the URL names company
 * B. Each one is explained in docs/security/cross-company-isolation.md.
 */
const B_PATH_2XX_ALLOWED: Record<string, string> = {
  // Execution environments are an INSTANCE resource (the table has no
  // company_id); the :companyId in the path is not used. Any member of any
  // company sees the list, with config/env/metadata redacted unless the
  // caller is an instance admin. No company data is involved.
  "GET /api/companies/:companyId/environments": "instance-wide, redacted for non-admins",
  "GET /api/companies/:companyId/environments/capabilities": "static adapter/driver capability list",
};

/**
 * New rows that may mention B after A's sweep: the audit trail of A's REFUSED
 * attempts. Writing "someone from another company tried to read this" into
 * the activity log is the intended behaviour, not a leak -- but a refusal
 * record must never copy B's content into A's own log, which is why a row in
 * A's company that carries B's canary is still a failure.
 */
function auditRowAllowed(table: string, row: Record<string, unknown>, companyA: string, canary: string): boolean {
  const text = JSON.stringify(row);
  if (table === "activity_log") {
    const action = String(row.action ?? "");
    const isRefusal = /_denied$|^security\.cross_company/.test(action);
    if (!isRefusal) return false;
    return !(row.company_id === companyA && text.includes(canary));
  }
  // cross_company_access_log is deliberately NOT allowed: a refused request
  // must never open the all-companies scope (routes/access.ts
  // instanceAdminBeforeBypass), so A's sweep may not add a bypass row naming B.
  return false;
}

type Registration = { owner: unknown; method: string; path: string };
type Mount = { parent: unknown; prefix: string; child: unknown };

/**
 * Records every route registration made while `build()` runs. Same recorder
 * as company-service-token-every-route.test.ts (see the comment there for
 * why it hooks registration rather than walking Express internals).
 */
async function recordRoutesWhileBuilding(build: () => Promise<Express>): Promise<{
  app: Express;
  routes: Array<{ method: string; path: string }>;
}> {
  const routerProto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router())) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const originalRoute = routerProto.route;
  const originalUse = routerProto.use;
  const registrations: Registration[] = [];
  const mounts: Mount[] = [];

  routerProto.route = function patchedRoute(this: unknown, path: unknown) {
    const route = originalRoute.call(this, path) as Record<string, unknown>;
    const owner = this;
    for (const method of HTTP_METHODS) {
      const original = route[method] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== "function") continue;
      route[method] = function patchedMethod(this: unknown, ...args: unknown[]) {
        registrations.push({ owner, method: method.toUpperCase(), path: String(path) });
        return original.apply(this, args);
      };
    }
    return route;
  };
  routerProto.use = function patchedUse(this: unknown, ...args: unknown[]) {
    const [first, ...rest] = args;
    const prefix = typeof first === "string" ? first : "";
    const handlers = typeof first === "string" ? rest : args;
    for (const handler of handlers.flat()) {
      if (typeof handler === "function" && Array.isArray((handler as { stack?: unknown }).stack)) {
        mounts.push({ parent: this, prefix, child: handler });
      }
    }
    return originalUse.apply(this, args);
  };

  let app: Express;
  try {
    app = await build();
  } finally {
    routerProto.route = originalRoute;
    routerProto.use = originalUse;
  }

  const routes: Array<{ method: string; path: string }> = [];
  const seen = new Set<string>();
  const queue: Array<{ router: unknown; prefix: string }> = [
    { router: (app as unknown as { router: unknown }).router, prefix: "" },
  ];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const { router, prefix } = queue.shift()!;
    if (visited.has(router)) continue;
    visited.add(router);
    for (const registration of registrations) {
      if (registration.owner !== router) continue;
      const full = (prefix + registration.path).replace(/\/{2,}/g, "/");
      const key = `${registration.method} ${full}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method: registration.method, path: full });
    }
    for (const mount of mounts) {
      if (mount.parent !== router) continue;
      queue.push({ router: mount.child, prefix: (prefix + mount.prefix).replace(/\/{2,}/g, "/") });
    }
  }
  return { app, routes };
}

type TenantIds = {
  companyId: string;
  userId: string;
  agentId: string;
  issueId: string;
  commentId: string;
  projectId: string;
  goalId: string;
  labelId: string;
  documentId: string;
  documentKey: string;
  secretId: string;
  approvalId: string;
  routineId: string;
  runId: string;
  activityId: string;
  costEventId: string;
  assetId: string;
  skillId: string;
  memoryId: string;
  entryId: string;
  scriptId: string;
  personaId: string;
  contactId: string;
  pipelineId: string;
  storylineId: string;
  watcherId: string;
  jobId: string;
};

/** Which of a tenant's ids a URL parameter should be filled with. */
function idForParam(name: string, segmentBefore: string, t: TenantIds): string {
  if (name === "id") {
    const bySegment: Record<string, string> = {
      issues: t.issueId,
      agents: t.agentId,
      approvals: t.approvalId,
      routines: t.routineId,
      projects: t.projectId,
      secrets: t.secretId,
      jobs: t.jobId,
      goals: t.goalId,
      contacts: t.contactId,
      companies: t.companyId,
      "heartbeat-runs": t.runId,
      labels: t.labelId,
      assets: t.assetId,
      skills: t.skillId,
      documents: t.documentId,
      comments: t.commentId,
      watchers: t.watcherId,
      personas: t.personaId,
      pipelines: t.pipelineId,
      storylines: t.storylineId,
    };
    return bySegment[segmentBefore] ?? randomUUID();
  }
  const byName: Record<string, string> = {
    companyId: t.companyId,
    agentId: t.agentId,
    issueId: t.issueId,
    commentId: t.commentId,
    projectId: t.projectId,
    goalId: t.goalId,
    labelId: t.labelId,
    documentId: t.documentId,
    key: t.documentKey,
    secretId: t.secretId,
    approvalId: t.approvalId,
    routineId: t.routineId,
    runId: t.runId,
    assetId: t.assetId,
    skillId: t.skillId,
    memoryId: t.memoryId,
    entryId: t.entryId,
    scriptId: t.scriptId,
    personaId: t.personaId,
    pipelineId: t.pipelineId,
    storylineId: t.storylineId,
    watcherId: t.watcherId,
    jobId: t.jobId,
    userId: t.userId,
  };
  return byName[name] ?? randomUUID();
}

/** Turn a route pattern into a URL: `companyIdInPath` for the company, `t`'s ids for everything else. */
function concreteUrl(pattern: string, companyIdInPath: string, t: TenantIds): string {
  const withOptionals = pattern
    .replace(/\{\/?\*[A-Za-z0-9_]*\}/g, "/x")
    .replace(/\*[A-Za-z0-9_]*/g, "x")
    .replace(/\{(\/?)(:[A-Za-z0-9_]+)\}/g, "$1$2");
  const segments = withOptionals.split("/");
  return segments
    .map((segment, index) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      if (name === "companyId") return companyIdInPath;
      return encodeURIComponent(idForParam(name, segments[index - 1] ?? "", t));
    })
    .join("/");
}

/**
 * Every body field a route might read as a reference to another record, and
 * which of a tenant's ids it takes. `parentId` appears twice on purpose: it
 * is an issue's parent on issues and a goal's parent on goals.
 */
const REFERENCE_FIELDS: Array<[field: string, pick: (t: TenantIds) => unknown]> = [
  ["agentId", (t) => t.agentId],
  ["assigneeAgentId", (t) => t.agentId],
  ["ownerAgentId", (t) => t.agentId],
  ["reportsTo", (t) => t.agentId],
  ["targetAgentId", (t) => t.agentId],
  ["leadAgentId", (t) => t.agentId],
  ["issueId", (t) => t.issueId],
  ["parentId", (t) => t.issueId],
  ["parentId", (t) => t.goalId],
  ["parentIssueId", (t) => t.issueId],
  ["sourceIssueId", (t) => t.issueId],
  ["issueIds", (t) => [t.issueId]],
  ["blockedByIssueIds", (t) => [t.issueId]],
  ["projectId", (t) => t.projectId],
  ["projectIds", (t) => [t.projectId]],
  ["goalId", (t) => t.goalId],
  ["goalIds", (t) => [t.goalId]],
  ["labelIds", (t) => [t.labelId]],
  ["approvalId", (t) => t.approvalId],
  ["linkedApprovalId", (t) => t.approvalId],
  ["secretId", (t) => t.secretId],
  ["existingSecretId", (t) => t.secretId],
  ["routineId", (t) => t.routineId],
  ["skillId", (t) => t.skillId],
  ["catalogSkillId", (t) => t.skillId],
  ["documentId", (t) => t.documentId],
  ["assetId", (t) => t.assetId],
  ["personaId", (t) => t.personaId],
  ["runId", (t) => t.runId],
  ["sourceRunId", (t) => t.runId],
  ["heartbeatRunId", (t) => t.runId],
  ["commentId", (t) => t.commentId],
  ["sourceCommentId", (t) => t.commentId],
  ["parentCommentId", (t) => t.commentId],
  ["contactId", (t) => t.contactId],
  ["userId", (t) => t.userId],
  ["assigneeUserId", (t) => t.userId],
  ["memoryId", (t) => t.memoryId],
  ["watcherId", (t) => t.watcherId],
  ["storylineId", (t) => t.storylineId],
  ["pipelineId", (t) => t.pipelineId],
  ["jobId", (t) => t.jobId],
];

const PROBE_TEXT = {
  title: "isolation probe",
  name: "isolation probe",
  body: "isolation probe",
  message: "isolation probe",
  input: "isolation probe",
  description: "isolation probe",
};

/** A body with every reference field set from `t` (first value wins for a repeated field). */
function fullReferenceBody(companyId: string, t: TenantIds): Record<string, unknown> {
  const body: Record<string, unknown> = { companyId, ...PROBE_TEXT };
  for (const [field, pick] of REFERENCE_FIELDS) {
    if (!(field in body)) body[field] = pick(t);
  }
  return body;
}

describeEmbeddedPostgres("cross-company isolation over every route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: Express;
  let routes: Array<{ method: string; path: string }> = [];
  let a!: TenantIds;
  let b!: TenantIds;
  // Both tenants' markers start with SEARCH_PROBE, so a search for it from A
  // legitimately finds A's records -- and would find B's too if a search
  // crossed the wall, which the canary check then catches.
  const canary = `${SEARCH_PROBE}NORDSTRAND${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const secretValue = `nordstrand-secret-value-${randomUUID()}`;

  type Actor = {
    label: string;
    token: string;
    /** Re-issue a working credential after a probe logged this actor out. */
    revive: () => Promise<string>;
  };
  const actors: Actor[] = [];
  const revivals: string[] = [];
  const leaks: string[] = [];
  const bPath2xx: string[] = [];
  let beforeRows: Map<string, Set<string>> = new Map();

  function needlePattern(): string {
    const needles = [canary, secretValue, ...Object.values(b).filter((value) => value.length >= 8)];
    return needles.map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  }

  /** Every row, in every table, that mentions B -- as JSON text, per table. */
  async function rowsMentioningB(): Promise<Map<string, Set<string>>> {
    const tables = (await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `)) as unknown as Array<{ table_name: string }>;
    const pattern = needlePattern();
    const out = new Map<string, Set<string>>();
    for (const { table_name } of tables) {
      const rows = (await db.execute(sql.raw(`
        select row_to_json(t)::text as row from "${table_name}" t where t::text ~ '${pattern}'
      `))) as unknown as Array<{ row: string }>;
      if (rows.length > 0) out.set(table_name, new Set(rows.map((row) => row.row)));
    }
    return out;
  }

  async function seedTenant(input: { name: string; marker: string; secretValue: string }): Promise<TenantIds> {
    const now = new Date();
    const m = input.marker;
    const companyId = randomUUID();
    const issuePrefix = `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: input.name,
      description: `Company ${m}`,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: `Owner ${m}`,
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${m}`,
      role: "ceo",
      status: "idle",
      capabilities: `capabilities ${m}`,
      laneAEnabled: true,
    });
    const [goal] = await db.insert(goals).values({ companyId, title: `Goal ${m}` }).returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: `Project ${m}`, description: m, goalId: goal!.id })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: `Issue ${m}`,
        description: `Description ${m}`,
        projectId: project!.id,
        goalId: goal!.id,
        assigneeAgentId: agentId,
        identifier: `${issuePrefix}-1`,
        issueNumber: 1,
      })
      .returning();
    const [comment] = await db
      .insert(issueComments)
      .values({ companyId, issueId: issue!.id, body: `Comment ${m}` })
      .returning();
    const [label] = await db.insert(labels).values({ companyId, name: `Label ${m}`, color: "#ff0000" }).returning();
    const [document] = await db
      .insert(documents)
      .values({ companyId, title: `Doc ${m}`, latestBody: `Body ${m}` })
      .returning();
    await db.insert(issueDocuments).values({ companyId, issueId: issue!.id, documentId: document!.id, key: "plan" });
    const secret = await secretService(db).create(companyId, {
      name: `secret-${m}`.toLowerCase(),
      provider: "local_encrypted",
      value: input.secretValue,
    });
    const [approval] = await db
      .insert(approvals)
      .values({ companyId, type: "hire_agent", payload: { note: m }, requestedByAgentId: agentId })
      .returning();
    const [routine] = await db
      .insert(routines)
      .values({ companyId, title: `Routine ${m}`, description: m, assigneeAgentId: agentId })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "succeeded", resultJson: { summary: m } })
      .returning();
    const [activity] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue!.id,
        details: { title: m },
      })
      .returning();
    const [costEvent] = await db
      .insert(costEvents)
      .values({ companyId, agentId, provider: `provider-${m}`, model: `model-${m}`, costCents: 4242, occurredAt: now })
      .returning();
    const [asset] = await db
      .insert(assets)
      .values({
        companyId,
        provider: "local_disk",
        objectKey: `${companyId}/${m}.png`,
        contentType: "image/png",
        byteSize: 10,
        sha256: "0".repeat(64),
        originalFilename: `${m}.png`,
      })
      .returning();
    const [skill] = await db
      .insert(companySkills)
      .values({
        companyId,
        key: `skill-${m}`.toLowerCase(),
        slug: `skill-${m}`.toLowerCase(),
        name: `Skill ${m}`,
        markdown: `# ${m}`,
      })
      .returning();
    const [memory] = await db
      .insert(agentMemories)
      .values({ companyId, agentId, text: `Memory ${m}`, source: "user" })
      .returning();
    const [entry] = await db
      .insert(modelDirectoryEntries)
      .values({ companyId, name: `Model ${m}`, provider: "openrouter", model: `vendor/${m}` })
      .returning();
    const [script] = await db
      .insert(reportScripts)
      .values({ companyId, key: `script-${m}`.toLowerCase(), name: `Script ${m}` })
      .returning();
    const [persona] = await db.insert(personas).values({ companyId, displayName: `Persona ${m}` }).returning();
    const [contact] = await db
      .insert(crmContacts)
      .values({ companyId, firstName: `First${m}`, lastName: `Last${m}` })
      .returning();
    const [pipeline] = await db
      .insert(pipelines)
      .values({ companyId, key: `pipe-${m}`.toLowerCase(), name: `Pipeline ${m}` })
      .returning();
    const [storyline] = await db.insert(videoStorylines).values({ companyId, title: `Storyline ${m}` }).returning();
    const [watcher] = await db
      .insert(watchers)
      .values({
        companyId,
        agentId,
        name: `Watcher ${m}`,
        source: "crypto",
        symbol: m.slice(0, 12),
        rule: { kind: "above", value: 1 },
      })
      .returning();
    const [job] = await db.insert(jobs).values({ companyId, title: `Job ${m}` }).returning();

    return {
      companyId,
      userId,
      agentId,
      issueId: issue!.id,
      commentId: comment!.id,
      projectId: project!.id,
      goalId: goal!.id,
      labelId: label!.id,
      documentId: document!.id,
      documentKey: "plan",
      secretId: secret.id,
      approvalId: approval!.id,
      routineId: routine!.id,
      runId: run!.id,
      activityId: activity!.id,
      costEventId: costEvent!.id,
      assetId: asset!.id,
      skillId: skill!.id,
      memoryId: memory!.id,
      entryId: entry!.id,
      scriptId: script!.id,
      personaId: persona!.id,
      contactId: contact!.id,
      pipelineId: pipeline!.id,
      storylineId: storyline!.id,
      watcherId: watcher!.id,
      jobId: job!.id,
    };
  }

  /** Is this actor's credential still accepted? (A probe may have logged it out.) */
  async function stillAuthenticated(actor: Actor): Promise<boolean> {
    const response = await request(app)
      .get(`/api/companies/${a.companyId}/issues`)
      .set("authorization", `Bearer ${actor.token}`);
    return response.status !== 401;
  }

  /**
   * Fire one probe and check the response for B's content. Returns the
   * status. Re-issues the actor's credential (once) if the probe found it
   * logged out by an earlier route.
   */
  async function probe(
    actor: Actor,
    method: (typeof HTTP_METHODS)[number],
    url: string,
    body: Record<string, unknown> | null,
    where: string,
  ): Promise<number> {
    const fire = async () => {
      let pending = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url)
        .set("authorization", `Bearer ${actor.token}`);
      if (body) pending = pending.send(body);
      try {
        const response = await pending.timeout({ deadline: 15_000 });
        let text = response.text ?? "";
        if (!text && response.body && typeof response.body === "object") text = JSON.stringify(response.body);
        return { status: response.status, text };
      } catch (err) {
        return { status: (err as { status?: number }).status ?? -1, text: "" };
      }
    };
    let result = await fire();
    if (result.status === 401 && actor.label !== "A service token" && !(await stillAuthenticated(actor))) {
      revivals.push(`${actor.label} re-issued before: ${where}`);
      actor.token = await actor.revive();
      result = await fire();
    }
    if (result.text.includes(canary) || result.text.includes(secretValue)) {
      leaks.push(`${where} -> ${result.status}`);
    }
    return result.status;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-isolation-");
    db = createDb(tempDb.connectionString);

    a = await seedTenant({ name: "Durkan Agency", marker: `${SEARCH_PROBE}DURKAN`, secretValue: `durkan-${randomUUID()}` });
    b = await seedTenant({ name: `Nordstrand ${canary}`, marker: canary, secretValue });

    const boardKey = async () =>
      (await boardAuthService(db).createNamedBoardApiKey({ userId: a.userId, name: "isolation probe" })).token;
    const agentKey = async () => {
      // An earlier probe may have paused or terminated the agent; put it back.
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, a.agentId));
      return ((await agentService(db).createApiKey(a.agentId, "isolation probe")) as { token: string }).token;
    };
    const serviceToken = async () =>
      (
        await companyServiceTokenService(db).createToken({
          companyId: a.companyId,
          name: "isolation probe",
          createdByUserId: null,
          scopes: ["lane_a:transform"],
        })
      ).token;
    // Agent first: the board can revoke or terminate the agent, never the
    // other way round, so this order keeps the most coverage.
    actors.push(
      { label: "A agent API key", token: await agentKey(), revive: agentKey },
      { label: "A board API key (owner of A)", token: await boardKey(), revive: boardKey },
      { label: "A service token", token: await serviceToken(), revive: serviceToken },
    );

    // Storage: A's own objects are fine to touch; B's object keys start with
    // B's company id, and reaching one is a leak.
    const storageGuard = (key: unknown) => {
      if (typeof key === "string" && key.includes(b.companyId)) {
        leaks.push(`object storage reached for company B key ${key}`);
      }
    };
    const storageStub = {
      provider: "local_disk",
      getObjectStream: async (_companyId: string, key: string) => {
        storageGuard(key);
        throw new Error("not found");
      },
      getObject: async (_companyId: string, key: string) => {
        storageGuard(key);
        throw new Error("not found");
      },
      headObject: async (_companyId: string, key: string) => {
        storageGuard(key);
        return { exists: false };
      },
      putObject: async () => {
        throw new Error("storage writes are not exercised by this sweep");
      },
      putFile: async () => {
        throw new Error("storage writes are not exercised by this sweep");
      },
      deleteObject: async (_companyId: string, key: string) => {
        storageGuard(key);
      },
    } as never;

    const { createApp } = await import("../app.js");
    const recorded = await recordRoutesWhileBuilding(
      () =>
        createApp(db, {
          uiMode: "none",
          serverPort: 0,
          storageService: storageStub,
          deploymentMode: "authenticated",
          deploymentExposure: "local",
          allowedHostnames: ["localhost", "127.0.0.1"],
          bindHost: "127.0.0.1",
          authReady: true,
          companyDeletionEnabled: false,
          instanceId: "vitest-cross-company-isolation-sweep",
        } as never) as Promise<Express>,
    );
    app = recorded.app;
    routes = recorded.routes;
    beforeRows = await rowsMentioningB();
  }, 300_000);

  afterAll(async () => {
    const shutdown = (app as unknown as { locals?: { paperclipShutdown?: () => void } })?.locals
      ?.paperclipShutdown;
    shutdown?.();
    await tempDb?.cleanup();
  });

  it("enumerated the real route table and seeded both tenants", () => {
    expect(routes.length).toBeGreaterThan(400);
    const paths = routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain("GET /api/companies/:companyId/issues");
    expect(paths).toContain("GET /api/issues/:id");
    // The canary must actually be in B's data, or assertion (a) is vacuous.
    expect([...beforeRows.values()].reduce((sum, rows) => sum + rows.size, 0)).toBeGreaterThan(25);
  });

  it("sweep 1: A cannot read, list or change B's records on any route", async () => {
    const spreadByActor = new Map<string, Map<number, number>>();
    let probes = 0;
    for (const actor of actors) {
      const spread = new Map<number, number>();
      spreadByActor.set(actor.label, spread);
      for (const route of routes) {
        const method = route.method.toLowerCase() as (typeof HTTP_METHODS)[number];
        if (!HTTP_METHODS.includes(method)) continue;
        const variants = [{ name: "B-path", companyInPath: b.companyId }];
        if (route.path.includes(":companyId")) variants.push({ name: "A-path+B-ids", companyInPath: a.companyId });
        for (const variant of variants) {
          const path = concreteUrl(route.path, variant.companyInPath, b);
          const url = method === "get" ? `${path}${path.includes("?") ? "&" : "?"}${SEARCH_QUERY}` : path;
          const body = method === "get" ? null : fullReferenceBody(variant.companyInPath, b);
          const where = `${actor.label} | ${variant.name} | ${route.method} ${route.path}`;
          const status = await probe(actor, method, url, body, where);
          probes += 1;
          spread.set(status, (spread.get(status) ?? 0) + 1);
          const routeKey = `${route.method} ${route.path}`;
          if (
            variant.name === "B-path" &&
            route.path.includes(":companyId") &&
            status >= 200 &&
            status < 300 &&
            !(routeKey in B_PATH_2XX_ALLOWED)
          ) {
            bPath2xx.push(`${where} -> ${status}`);
          }
        }
      }
    }
    const summary = [...spreadByActor.entries()]
      .map(([label, spread]) =>
        `${label}: ${[...spread.entries()].sort((x, y) => x[0] - y[0]).map(([s, n]) => `${n}x${s}`).join(" / ")}`)
      .join("\n  ");
    process.stderr.write(`isolation sweep 1: ${routes.length} routes, ${probes} probes\n  ${summary}\n`);
    expect(bPath2xx, "routes that answered 2xx to company A for a company-B URL").toEqual([]);
  }, 900_000);

  it("sweep 2: A cannot link its own records to B's (one reference field at a time)", async () => {
    const writeRoutes = routes.filter((route) => ["POST", "PUT", "PATCH"].includes(route.method));
    let probes = 0;
    let routesAccepted = 0;
    const slowSkipped = new Set<string>();
    const acceptedRoutes = new Set<string>();
    for (const actor of actors.filter((candidate) => candidate.label !== "A service token")) {
      for (const route of writeRoutes) {
        const method = route.method.toLowerCase() as (typeof HTTP_METHODS)[number];
        const url = concreteUrl(route.path, a.companyId, a);
        const where = `${actor.label} | ${route.method} ${route.path}`;
        // Find a body A's OWN references make acceptable: everything filled
        // with A's ids, or just the text fields.
        const bases = [fullReferenceBody(a.companyId, a), { companyId: a.companyId, ...PROBE_TEXT }];
        let accepted: Record<string, unknown> | null = null;
        let elapsed = 0;
        for (const base of bases) {
          const started = Date.now();
          const status = await probe(actor, method, url, base, `${where} (A's own refs)`);
          elapsed = Date.now() - started;
          probes += 1;
          if (status >= 200 && status < 300) {
            accepted = base;
            break;
          }
        }
        if (!accepted) continue;
        routesAccepted += 1;
        acceptedRoutes.add(`${route.method} ${route.path}`);
        if (elapsed > SLOW_ROUTE_MS) {
          // e.g. the company export: correct, but seconds per call. Probing it
          // once per reference field would take most of the run; its isolation
          // is argued in the doc instead.
          slowSkipped.add(`${route.method} ${route.path}`);
          continue;
        }
        for (const [field, pick] of REFERENCE_FIELDS) {
          const body = { ...accepted, [field]: pick(b) };
          await probe(actor, method, url, body, `${where} with ${field}=B`);
          probes += 1;
        }
      }
    }
    process.stderr.write(
      `isolation sweep 2: ${writeRoutes.length} write routes, ${routesAccepted} accepted A's own body, ${probes} probes` +
        (slowSkipped.size > 0 ? `; probed once (slow): ${[...slowSkipped].join(", ")}` : "") +
        `\n  write routes A could call on its own records (each re-probed with B's ids):\n    ${[...acceptedRoutes].sort().join("\n    ")}\n`,
    );
    expect(routesAccepted, "sweep 2 must actually reach some write routes").toBeGreaterThan(20);
  }, 900_000);

  it("no response leaked B's content and no row mentioning B changed", async () => {
    if (revivals.length > 0) process.stderr.write(`credential re-issues:\n  ${revivals.join("\n  ")}\n`);
    const after = await rowsMentioningB();
    const problems: string[] = [];
    for (const table of new Set([...beforeRows.keys(), ...after.keys()])) {
      const left = beforeRows.get(table) ?? new Set<string>();
      const right = after.get(table) ?? new Set<string>();
      for (const row of left) {
        if (!right.has(row)) problems.push(`${table}: B row changed or removed: ${row.slice(0, 300)}`);
      }
      for (const row of right) {
        if (left.has(row)) continue;
        if (auditRowAllowed(table, JSON.parse(row) as Record<string, unknown>, a.companyId, canary)) continue;
        problems.push(`${table}: new row mentions B: ${row.slice(0, 400)}`);
      }
    }
    expect.soft(leaks, "responses to company A that contained company B's data").toEqual([]);
    expect.soft(problems, "rows mentioning company B that changed during company A's sweeps").toEqual([]);
  }, 300_000);
});
