import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
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
import { hashBearerToken, boardAuthService } from "./board-auth.js";
import { logger } from "../middleware/logger.js";
import type { BoardChatPolicyLookup } from "./board-chat-policy.js";

/**
 * Board chat on signed-in Paperclip servers: settings, runs, the short-lived
 * per-run credential, and held changes ("actions").
 *
 * THE CREDENTIAL CHAIN (no long-lived or server-wide key is ever used)
 * --------------------------------------------------------------------
 *   1. When a person sends a message, `startRun` stores a run row and returns
 *      a ONE-TIME bootstrap code (only its hash is stored).
 *   2. The run's Paperclip connector (the only tool the model has) swaps the
 *      code for the run credential, once, within a minute. A second swap with
 *      the same code means someone else saw it: the credential is revoked and
 *      the run fails closed.
 *   3. The run credential authenticates as THAT person, with access to THAT
 *      company only, no instance-admin powers, and only while the run is
 *      running (it dies when the run ends, and after a few minutes at most).
 *      Every write it sends is held as an action, not made.
 *   4. Approve mints a third, single-use credential bound to that one held
 *      change; the server replays exactly the held request with it, and the
 *      request is checked against the stored copy before it reaches the route.
 */

export const BOARD_CHAT_TOKEN_PREFIX = {
  bootstrap: "pcp_bcboot_",
  run: "pcp_bcrun_",
  exec: "pcp_bcexec_",
} as const;

/** How long a run credential can live at most (the CLI itself is stopped after two minutes). */
export const BOARD_CHAT_RUN_TTL_MS = 4 * 60 * 1000;
/** The connector must swap its bootstrap code this soon after the run starts. */
export const BOARD_CHAT_BOOTSTRAP_TTL_MS = 60 * 1000;
/** The single-use Approve credential lives this long. */
export const BOARD_CHAT_EXEC_TTL_MS = 60 * 1000;

function newToken(prefix: string) {
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

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

export type BoardChatActorResolution = Express.Request["actor"] & {
  boardChatRunId?: string;
  boardChatActionId?: string;
};

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

  async function startRun(input: { companyId: string; userId: string; issueId: string | null; model?: string | null }) {
    const bootstrapCode = newToken(BOARD_CHAT_TOKEN_PREFIX.bootstrap);
    const at = now();
    const [run] = await db
      .insert(boardChatRuns)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        issueId: input.issueId,
        status: "running",
        bootstrapCodeHash: hashBearerToken(bootstrapCode),
        expiresAt: new Date(at.getTime() + BOARD_CHAT_RUN_TTL_MS),
        model: input.model ?? null,
        createdAt: at,
      })
      .returning();
    return { run: run!, bootstrapCode };
  }

  /**
   * Swap the one-time bootstrap code for the run credential. Returns null on
   * any failure. A second swap (by anyone) revokes the credential and fails
   * the run, so a copied code can never quietly act alongside the real run.
   */
  async function exchangeBootstrapCode(runId: string, code: string): Promise<string | null> {
    if (typeof code !== "string" || !code.startsWith(BOARD_CHAT_TOKEN_PREFIX.bootstrap)) return null;
    const at = now();
    const [run] = await db
      .select()
      .from(boardChatRuns)
      .where(and(eq(boardChatRuns.id, runId), eq(boardChatRuns.bootstrapCodeHash, hashBearerToken(code))));
    if (!run || run.status !== "running") return null;
    if (run.createdAt.getTime() + BOARD_CHAT_BOOTSTRAP_TTL_MS < at.getTime()) return null;
    if (run.tokenExchangeCount === 0) {
      const token = newToken(BOARD_CHAT_TOKEN_PREFIX.run);
      const [updated] = await db
        .update(boardChatRuns)
        .set({ tokenExchangeCount: 1, tokenHash: hashBearerToken(token) })
        .where(and(eq(boardChatRuns.id, runId), eq(boardChatRuns.tokenExchangeCount, 0)))
        .returning({ id: boardChatRuns.id });
      if (updated) return token;
    }
    await db
      .update(boardChatRuns)
      .set({
        tokenExchangeCount: sql`${boardChatRuns.tokenExchangeCount} + 1`,
        tokenHash: null,
        status: "failed",
        endedAt: at,
      })
      .where(eq(boardChatRuns.id, runId));
    logger.warn(
      { event: "security.board_chat_bootstrap_reused", runId, companyId: run.companyId },
      "A Board chat bootstrap code was used twice; the run credential was revoked",
    );
    return null;
  }

  async function findActiveRunByToken(token: string): Promise<RunRow | null> {
    const [run] = await db
      .select()
      .from(boardChatRuns)
      .where(
        and(
          eq(boardChatRuns.tokenHash, hashBearerToken(token)),
          eq(boardChatRuns.status, "running"),
          gt(boardChatRuns.expiresAt, now()),
        ),
      );
    return run ?? null;
  }

  async function getRun(runId: string): Promise<RunRow | null> {
    const [run] = await db.select().from(boardChatRuns).where(eq(boardChatRuns.id, runId));
    return run ?? null;
  }

  async function finishRun(
    runId: string,
    input: {
      status: "done" | "failed" | "timed_out";
      model?: string | null;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      costCents?: number;
      costMicroUsd?: number | null;
      costEventId?: string | null;
    },
  ) {
    await db
      .update(boardChatRuns)
      .set({
        status: input.status,
        tokenHash: null,
        endedAt: now(),
        ...(input.model !== undefined ? { model: input.model } : {}),
        inputTokens: input.inputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        costCents: input.costCents ?? 0,
        costMicroUsd: input.costMicroUsd ?? null,
        costEventId: input.costEventId ?? null,
      })
      .where(eq(boardChatRuns.id, runId));
  }

  /**
   * Who a run or Approve credential acts as: the person, in exactly one
   * company, never as instance admin. Re-checked on every request from the
   * person's CURRENT access, so losing the owner/admin role (or the company
   * turning Board chat off) stops a run mid-way.
   */
  async function resolveActorForToken(token: string): Promise<{
    actor: BoardChatActorResolution;
    action?: ActionRow;
  } | null> {
    let companyId: string;
    let userId: string;
    let runId: string | undefined;
    let action: ActionRow | undefined;
    if (token.startsWith(BOARD_CHAT_TOKEN_PREFIX.run)) {
      const run = await findActiveRunByToken(token);
      if (!run) return null;
      companyId = run.companyId;
      userId = run.userId;
      runId = run.id;
    } else if (token.startsWith(BOARD_CHAT_TOKEN_PREFIX.exec)) {
      const consumed = await consumeExecToken(token);
      if (!consumed) return null;
      companyId = consumed.companyId;
      userId = consumed.userId;
      action = consumed;
    } else {
      return null;
    }
    const settings = await getSettings(companyId);
    if (!settings.enabled) return null;
    const access = await boardAuthService(db).resolveBoardAccess(userId);
    if (!access.user) return null;
    const membership = access.memberships.find((row) => row.companyId === companyId && row.status === "active");
    const role = membership?.membershipRole ?? null;
    if (!access.isInstanceAdmin && role !== "owner" && role !== "admin") return null;
    return {
      actor: {
        type: "board",
        userId,
        userName: access.user.name ?? null,
        userEmail: access.user.email ?? null,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role ?? "admin", status: "active" }],
        isInstanceAdmin: false,
        source: action ? "board_chat_confirmed" : "board_chat",
        boardChatRunId: runId,
        boardChatActionId: action?.id,
      },
      action,
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

  /** pending -> confirmed, for the person who asked, and mint the single-use Approve credential. */
  async function beginConfirm(actionId: string, userId: string): Promise<{ row: ActionRow; execToken: string } | null> {
    const execToken = newToken(BOARD_CHAT_TOKEN_PREFIX.exec);
    const at = now();
    const [row] = await db
      .update(boardChatActions)
      .set({
        status: "confirmed",
        execTokenHash: hashBearerToken(execToken),
        execTokenExpiresAt: new Date(at.getTime() + BOARD_CHAT_EXEC_TTL_MS),
        decidedByUserId: userId,
        decidedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(boardChatActions.id, actionId),
          eq(boardChatActions.userId, userId),
          eq(boardChatActions.status, "pending"),
          gt(boardChatActions.expiresAt, at),
        ),
      )
      .returning();
    return row ? { row, execToken } : null;
  }

  /** confirmed -> executing. Single use: the credential is wiped as it is used. */
  async function consumeExecToken(token: string): Promise<ActionRow | null> {
    const at = now();
    const [row] = await db
      .update(boardChatActions)
      .set({ status: "executing", execTokenHash: null, updatedAt: at })
      .where(
        and(
          eq(boardChatActions.execTokenHash, hashBearerToken(token)),
          eq(boardChatActions.status, "confirmed"),
          gt(boardChatActions.execTokenExpiresAt, at),
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
        execTokenHash: null,
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

  /** Cancel what a run left pending when its run failed closed (e.g. a reused bootstrap code). */
  async function cancelPendingForRun(runId: string, message: string) {
    await db
      .update(boardChatActions)
      .set({ status: "cancelled", resultMessage: message, updatedAt: now() })
      .where(and(eq(boardChatActions.runId, runId), eq(boardChatActions.status, "pending"), isNull(boardChatActions.decidedAt)));
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const policyLookup: BoardChatPolicyLookup = {
    async issue(id) {
      const where = UUID_RE.test(id) ? eq(issues.id, id) : eq(issues.identifier, id.toUpperCase());
      const [row] = await db
        .select({ companyId: issues.companyId, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(where);
      return row ?? null;
    },
    async agent(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db.select({ companyId: agents.companyId, name: agents.name }).from(agents).where(eq(agents.id, id));
      return row ?? null;
    },
    async approval(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db
        .select({ companyId: approvals.companyId, type: approvals.type, payload: approvals.payload })
        .from(approvals)
        .where(eq(approvals.id, id));
      return row ?? null;
    },
    async goal(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db.select({ companyId: goals.companyId, title: goals.title }).from(goals).where(eq(goals.id, id));
      return row ?? null;
    },
    async project(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db.select({ companyId: projects.companyId, name: projects.name }).from(projects).where(eq(projects.id, id));
      return row ?? null;
    },
  };

  return {
    getSettings,
    updateSettings,
    countMessagesToday,
    startRun,
    exchangeBootstrapCode,
    findActiveRunByToken,
    getRun,
    finishRun,
    resolveActorForToken,
    createAction,
    getActionRow,
    listActions,
    beginConfirm,
    consumeExecToken,
    completeAction,
    cancelAction,
    expireStale,
    cancelPendingForRun,
    policyLookup,
  };
}

export type BoardChatService = ReturnType<typeof boardChatService>;

export function isBoardChatToken(token: string) {
  return token.startsWith(BOARD_CHAT_TOKEN_PREFIX.run) || token.startsWith(BOARD_CHAT_TOKEN_PREFIX.exec);
}
