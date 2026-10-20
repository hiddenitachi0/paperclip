import { EventEmitter } from "node:events";
import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  boardChatActions,
  boardChatCompanySettings,
  boardChatRuns,
  goals,
  issues,
  projects,
} from "@paperclipai/db";
import {
  BOARD_CHAT_ACTION_EXPIRES_AFTER_HOURS,
  BOARD_CHAT_DEFAULT_DAILY_MESSAGE_CAP,
  type BoardChatAction,
  type BoardChatActionStatus,
  type BoardChatSettings,
  type UpdateBoardChatSettingsInput,
} from "@paperclipai/shared";
import { boardAuthService } from "./board-auth.js";
import type { BoardChatPolicyLookup } from "./board-chat-policy.js";

/**
 * Board chat on signed-in Paperclip servers: settings, runs (the daily cap and
 * cost), the person's one-company actor, and held changes ("actions").
 *
 * The model runs inside the Paperclip server and its tools are in-process
 * calls into this server's own routes (board-chat-dispatch.ts). There is no
 * child process and no credential of any kind for the authenticated path.
 */

/** In-process notifications so an open chat stream can show a held change the moment it is held. */
export const boardChatEvents = new EventEmitter();
boardChatEvents.setMaxListeners(100);

export function boardChatRunEventName(runId: string) {
  return `action:${runId}`;
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type ActionRow = typeof boardChatActions.$inferSelect;
type RunRow = typeof boardChatRuns.$inferSelect;

export function toBoardChatAction(row: ActionRow, now = new Date()): BoardChatAction {
  const expired = row.status === "pending" && row.expiresAt.getTime() <= now.getTime();
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId ?? null,
    runId: row.runId ?? null,
    userId: row.userId,
    summary: row.summary,
    details: Array.isArray(row.details) ? row.details : [],
    status: (expired ? "expired" : row.status) as BoardChatActionStatus,
    resultMessage: row.resultMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export type BoardChatActor = Express.Request["actor"];

export function boardChatService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  async function getSettings(companyId: string): Promise<BoardChatSettings> {
    const [row] = await db
      .select()
      .from(boardChatCompanySettings)
      .where(eq(boardChatCompanySettings.companyId, companyId));
    return {
      companyId,
      enabled: row?.enabled ?? false,
      dailyMessageCap: row?.dailyMessageCap ?? BOARD_CHAT_DEFAULT_DAILY_MESSAGE_CAP,
      messagesToday: await countMessagesToday(companyId),
      enabledAt: row?.enabledAt ? row.enabledAt.toISOString() : null,
      enabledByUserId: row?.enabledByUserId ?? null,
    };
  }

  async function updateSettings(
    companyId: string,
    input: UpdateBoardChatSettingsInput,
    userId: string | null,
  ): Promise<BoardChatSettings> {
    const at = now();
    const [existing] = await db
      .select()
      .from(boardChatCompanySettings)
      .where(eq(boardChatCompanySettings.companyId, companyId));
    const turningOn = input.enabled === true && existing?.enabled !== true;
    const values = {
      enabled: input.enabled ?? existing?.enabled ?? false,
      dailyMessageCap: input.dailyMessageCap ?? existing?.dailyMessageCap ?? BOARD_CHAT_DEFAULT_DAILY_MESSAGE_CAP,
      enabledAt: turningOn ? at : existing?.enabledAt ?? null,
      enabledByUserId: turningOn ? userId : existing?.enabledByUserId ?? null,
      updatedByUserId: userId,
      updatedAt: at,
    };
    await db
      .insert(boardChatCompanySettings)
      .values({ companyId, ...values })
      .onConflictDoUpdate({ target: boardChatCompanySettings.companyId, set: values });
    return getSettings(companyId);
  }

  async function countMessagesToday(companyId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(boardChatRuns)
      .where(and(eq(boardChatRuns.companyId, companyId), gte(boardChatRuns.createdAt, startOfUtcDay(now()))));
    return Number(row?.count ?? 0);
  }

  /**
   * Count today's messages and record this one in one transaction, under a
   * per-company lock, so two messages sent at once can never both squeeze
   * under the cap. Returns null when the cap is already used up.
   */
  async function startRunWithinCap(input: {
    companyId: string;
    userId: string;
    issueId: string | null;
    dailyMessageCap: number;
  }): Promise<RunRow | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`board_chat_cap:${input.companyId}`}))`);
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(boardChatRuns)
        .where(and(eq(boardChatRuns.companyId, input.companyId), gte(boardChatRuns.createdAt, startOfUtcDay(now()))));
      if (Number(row?.count ?? 0) >= input.dailyMessageCap) return null;
      const [run] = await tx
        .insert(boardChatRuns)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          issueId: input.issueId,
          status: "running",
          createdAt: now(),
        })
        .returning();
      return run ?? null;
    });
  }

  async function getRun(runId: string): Promise<RunRow | null> {
    const [run] = await db.select().from(boardChatRuns).where(eq(boardChatRuns.id, runId));
    return run ?? null;
  }

  /** Add one model call's usage to the run (called after every call, so a stopped run still has its cost). */
  async function addRunUsage(
    runId: string,
    usage: { provider: string; model: string; inputTokens: number; outputTokens: number; costCents: number },
  ) {
    await db
      .update(boardChatRuns)
      .set({
        provider: usage.provider,
        model: usage.model,
        inputTokens: sql`${boardChatRuns.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${boardChatRuns.outputTokens} + ${usage.outputTokens}`,
        costCents: sql`${boardChatRuns.costCents} + ${usage.costCents}`,
      })
      .where(eq(boardChatRuns.id, runId));
  }

  async function finishRun(runId: string, status: "done" | "failed" | "timed_out") {
    await db.update(boardChatRuns).set({ status, endedAt: now() }).where(eq(boardChatRuns.id, runId));
  }

  /**
   * Who a Board chat run (or an approved change) acts as: the person, in
   * exactly one company, never as instance admin, with their REAL role there.
   * Built from the person's current access every time, so losing the
   * owner/admin role or the company switching Board chat off stops it.
   * Instance admins pass only in companies they belong to (Paperclip's rule
   * for everyone else too). Null = not allowed.
   */
  async function buildActor(input: {
    companyId: string;
    userId: string;
    runId?: string | null;
    actionId?: string | null;
  }): Promise<BoardChatActor | null> {
    const settings = await getSettings(input.companyId);
    if (!settings.enabled) return null;
    const access = await boardAuthService(db).resolveBoardAccess(input.userId);
    if (!access.user) return null;
    const membership = access.memberships.find((row) => row.companyId === input.companyId && row.status === "active");
    if (!membership) return null;
    const role = membership.membershipRole ?? null;
    if (!access.isInstanceAdmin && role !== "owner" && role !== "admin") return null;
    return {
      type: "board",
      userId: input.userId,
      userName: access.user.name ?? null,
      userEmail: access.user.email ?? null,
      companyIds: [input.companyId],
      memberships: [{ companyId: input.companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
      source: input.actionId ? "board_chat_confirmed" : "board_chat",
      boardChatRunId: input.runId ?? undefined,
      boardChatActionId: input.actionId ?? undefined,
    };
  }

  async function createAction(input: {
    companyId: string;
    runId: string | null;
    issueId: string | null;
    userId: string;
    method: string;
    path: string;
    bodyJson: string | null;
    summary: string;
    details: Array<{ label: string; value: string }>;
  }): Promise<BoardChatAction> {
    const at = now();
    const [row] = await db
      .insert(boardChatActions)
      .values({
        ...input,
        status: "pending",
        expiresAt: new Date(at.getTime() + BOARD_CHAT_ACTION_EXPIRES_AFTER_HOURS * 60 * 60 * 1000),
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return toBoardChatAction(row!, at);
  }

  async function getActionRow(actionId: string): Promise<ActionRow | null> {
    const [row] = await db.select().from(boardChatActions).where(eq(boardChatActions.id, actionId));
    return row ?? null;
  }

  async function listActions(companyId: string, opts: { issueId?: string | null; runId?: string | null; limit?: number } = {}) {
    const conditions = [eq(boardChatActions.companyId, companyId)];
    if (opts.issueId) conditions.push(eq(boardChatActions.issueId, opts.issueId));
    if (opts.runId) conditions.push(eq(boardChatActions.runId, opts.runId));
    const rows = await db
      .select()
      .from(boardChatActions)
      .where(and(...conditions))
      .orderBy(desc(boardChatActions.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    const at = now();
    return rows.reverse().map((row) => toBoardChatAction(row, at));
  }

  /** pending -> executing, for the person who asked, once. Null when it was already handled or has expired. */
  async function beginExecute(actionId: string, userId: string): Promise<ActionRow | null> {
    const at = now();
    const [row] = await db
      .update(boardChatActions)
      .set({ status: "executing", decidedByUserId: userId, decidedAt: at, updatedAt: at })
      .where(
        and(
          eq(boardChatActions.id, actionId),
          eq(boardChatActions.userId, userId),
          eq(boardChatActions.status, "pending"),
          gt(boardChatActions.expiresAt, at),
        ),
      )
      .returning();
    return row ?? null;
  }

  async function completeAction(
    actionId: string,
    input: { status: "done" | "failed"; resultStatus: number | null; resultMessage: string },
  ): Promise<BoardChatAction | null> {
    const at = now();
    const [row] = await db
      .update(boardChatActions)
      .set({
        status: input.status,
        resultStatus: input.resultStatus,
        resultMessage: input.resultMessage.slice(0, 2000),
        completedAt: at,
        updatedAt: at,
      })
      .where(eq(boardChatActions.id, actionId))
      .returning();
    return row ? toBoardChatAction(row, at) : null;
  }

  async function cancelAction(actionId: string, userId: string): Promise<BoardChatAction | null> {
    const at = now();
    const [row] = await db
      .update(boardChatActions)
      .set({
        status: "cancelled",
        decidedByUserId: userId,
        decidedAt: at,
        resultMessage: "Cancelled. Nothing was changed.",
        updatedAt: at,
      })
      .where(
        and(
          eq(boardChatActions.id, actionId),
          eq(boardChatActions.userId, userId),
          eq(boardChatActions.status, "pending"),
        ),
      )
      .returning();
    return row ? toBoardChatAction(row, at) : null;
  }

  /** Mark this company's unapproved changes that are past their time as expired. */
  async function expireStale(companyId: string) {
    const at = now();
    await db
      .update(boardChatActions)
      .set({ status: "expired", updatedAt: at, resultMessage: "Nobody approved this in time. Nothing was changed." })
      .where(
        and(
          eq(boardChatActions.companyId, companyId),
          eq(boardChatActions.status, "pending"),
          lt(boardChatActions.expiresAt, at),
        ),
      );
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const policyLookup: BoardChatPolicyLookup = {
    async issue(id) {
      const where = UUID_RE.test(id) ? eq(issues.id, id.toLowerCase()) : eq(issues.identifier, id.toUpperCase());
      const [row] = await db
        .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(where);
      return row ?? null;
    },
    async agent(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db
        .select({ companyId: agents.companyId, name: agents.name })
        .from(agents)
        .where(eq(agents.id, id.toLowerCase()));
      return row ?? null;
    },
    async approval(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db
        .select({ companyId: approvals.companyId, type: approvals.type, payload: approvals.payload })
        .from(approvals)
        .where(eq(approvals.id, id.toLowerCase()));
      return row ?? null;
    },
    async goal(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db.select({ companyId: goals.companyId, title: goals.title }).from(goals).where(eq(goals.id, id.toLowerCase()));
      return row ?? null;
    },
    async project(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db
        .select({ companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.id, id.toLowerCase()));
      return row ?? null;
    },
  };

  return {
    getSettings,
    updateSettings,
    countMessagesToday,
    startRunWithinCap,
    getRun,
    addRunUsage,
    finishRun,
    buildActor,
    createAction,
    getActionRow,
    listActions,
    beginExecute,
    completeAction,
    cancelAction,
    expireStale,
    policyLookup,
  };
}

export type BoardChatService = ReturnType<typeof boardChatService>;
