import { createHmac, randomInt, randomUUID } from "node:crypto";
import { and, asc, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  issues as issuesTable,
  telegramBots,
  telegramChatRequests,
  telegramChatSettings,
  telegramPersonLinks,
} from "@paperclipai/db";
import {
  CHAT_PHOTO_MAX_BYTES,
  chatPhotoFilename,
  sniffChatPhotoType,
  TELEGRAM_CHAT_DAILY_CAP_DEFAULT,
  TELEGRAM_LINK_CODE_ALPHABET,
  TELEGRAM_LINK_CODE_LENGTH,
  type TelegramChatAskImage,
  type TelegramChatAskInput,
  type TelegramChatAskResult,
  type TelegramChatLinkInput,
  type TelegramChatLinkResult,
  type TelegramChatOutboxItem,
  type TelegramChatSettings,
  type TelegramLinkCode,
  type TelegramLinkStatus,
  type UpdateTelegramChatSettingsInput,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { readServerSecret } from "../server-secrets.js";
import { logger } from "../middleware/logger.js";
import { redactKnownLeakedSecretPatterns, redactSensitiveText } from "../redaction.js";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { boardAuthService } from "./board-auth.js";
import { zonedDayStart, zonedParts } from "./data-sources/zoned-time.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import type { LaneARequester, LaneATargetAgent } from "./lane-a.js";
import { getStorageService } from "../storage/index.js";
import type { StorageService } from "../storage/types.js";

/**
 * Hermes parity, slice 1: a linked person asks the company's Telegram bot a
 * question and gets the answer back in the same chat.
 *
 * Who is asking: the Telegram sender's id is mapped to a Paperclip person
 * through telegram_person_links (made with a one-time code from their own
 * profile page). Nobody else gets anything but a "link your account first"
 * sentence. Which company: always the bot's own (the bot row is looked up by
 * id inside the company in the path, and the bridge takes both from the
 * bot's stored config), never anything in the message.
 *
 * What they may see: the question runs as THAT person -- a board actor built
 * from their own active memberships, exactly what the auth middleware builds
 * for their browser session -- so every existing check applies to them and
 * not to the operator whose credential the bridge uses:
 *   - an active membership in the bot's company; an "Employee (light)"
 *     member also needs the "feature:pa_chat" switch, like the web chat;
 *   - the quick agent's own rule (it answers its assigned people + owner);
 *   - "tasks:assign" before a question is handed to the full agent (the same
 *     decision the chat router and the helper make);
 *   - "issue:read" on that task again before its answer is sent back, so a
 *     person who lost access in the meantime gets nothing.
 *
 * How: the company's chosen quick agent answers first (Lane A, with its own
 * read_business_data tool and number grounding). When it cannot -- none
 * chosen, a request that is real work, quick answers unavailable -- the
 * question becomes a task for the chosen full agent; its final answer waits
 * in telegram_chat_requests until the bridge polls it (no inbound port).
 *
 * Limits: a per-person per-day question cap (Oslo day), counted from
 * telegram_chat_requests so it survives a restart; answers are capped in
 * length here and split into Telegram-sized messages by the bridge.
 */

export const TELEGRAM_LINK_CODE_TTL_MS = 15 * 60_000;
export const TELEGRAM_LINK_MAX_FAILED_ATTEMPTS = 5;
export const TELEGRAM_LINK_ATTEMPT_WINDOW_MS = 15 * 60_000;
/** A quick-agent conversation is continued when the person's last question was this recent. */
export const TELEGRAM_CHAT_CONVERSATION_IDLE_MS = 30 * 60_000;
/** A ready answer nobody picked up within a day is not sent late. */
export const TELEGRAM_CHAT_READY_MAX_AGE_MS = 24 * 3_600_000;
/** A task that has not finished after this long stops being watched. */
export const TELEGRAM_CHAT_WAITING_MAX_AGE_MS = 30 * 24 * 3_600_000;
/** Longer answers are cut here (the bridge sends at most four Telegram messages). */
export const TELEGRAM_CHAT_ANSWER_MAX_CHARS = 12_000;
export const TELEGRAM_CHAT_OUTBOX_BATCH = 50;
const LIMIT_DAY_TIMEZONE = "Europe/Oslo";
const ANSWER_SCAN_COMMENTS = 20;
const TASK_TITLE_MAX = 80;

const ANSWERED_TASK_STATUSES = new Set(["done", "cancelled", "in_review", "blocked"]);
const CONVERSATION_ENDED_CODES = new Set(["LANE_A_CONVERSATION_EXPIRED", "LANE_A_TURN_CAP_REACHED"]);
const UNUSABLE_AGENT_STATUSES = new Set(["terminated", "paused", "error", "pending_approval"]);
// Mirrors routes/chat-router.ts: long or work-shaped messages go straight to a task.
const QUICK_MAX_CHARS = 300;
const WORK_KEYWORDS =
  /\b(build|implement|fix|create|deploy|refactor|migrate|generate|develop|integrate|automate|configure|debug|investigate|research|write code|set up)\b/i;

export type TelegramChatLaneA = {
  sendMessage(params: {
    companyId: string;
    targetAgent: LaneATargetAgent;
    requester: LaneARequester;
    actor?: AuthorizationActor;
    message: string;
    conversationId?: string;
    attachmentFileIds?: string[];
  }): Promise<unknown>;
};

export interface TelegramChatServiceDeps {
  /** The quick-answer lane; the route passes laneAService(db). Tests pass a fake. */
  laneA?: TelegramChatLaneA;
  /** Wakes the full agent when a task is handed to it. */
  heartbeat?: IssueAssignmentWakeupDeps;
  now?: () => Date;
  /** Where a photo the person sent is stored; tests pass a fake. */
  storage?: () => StorageService;
}

/**
 * The server's own secret the link-code key is derived from: the same master
 * secret the agent JWTs and document download links are signed with
 * (documents-download-token.ts), so there is no new setting to configure.
 * Null when neither is set; linking is then refused rather than done with a
 * guessable key.
 */
function linkCodeMasterSecret(): string | null {
  return readServerSecret("PAPERCLIP_AGENT_JWT_SECRET")?.trim() || readServerSecret("BETTER_AUTH_SECRET")?.trim() || null;
}

/**
 * HMAC-SHA256 of the normalized code under a key derived from the server's
 * master secret ("telegram-link-code" purpose), so a copy of the database
 * alone is not enough to test guesses against a stored code. Null when the
 * server has no master secret.
 */
export function hashTelegramLinkCode(code: string, masterSecret: string | null = linkCodeMasterSecret()): string | null {
  if (!masterSecret) return null;
  const key = createHmac("sha256", masterSecret).update("telegram-link-code").digest();
  return createHmac("sha256", key).update(normalizeTelegramLinkCode(code)).digest("hex");
}

const LINKING_UNAVAILABLE =
  "Linking Telegram is not available on this server yet: it needs the server's signing secret " +
  "(PAPERCLIP_AGENT_JWT_SECRET or BETTER_AUTH_SECRET). Ask whoever runs Paperclip.";

/** "abcd-2345", " ABCD 2345 " and "ABCD2345" are the same code. */
export function normalizeTelegramLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

export function generateTelegramLinkCode(): string {
  let code = "";
  for (let i = 0; i < TELEGRAM_LINK_CODE_LENGTH; i += 1) {
    code += TELEGRAM_LINK_CODE_ALPHABET[randomInt(TELEGRAM_LINK_CODE_ALPHABET.length)];
  }
  return code;
}

export function shouldTryQuickAnswer(message: string): boolean {
  return message.length <= QUICK_MAX_CHARS && !WORK_KEYWORDS.test(message);
}

function redactOut(text: string): string {
  return redactKnownLeakedSecretPatterns(redactSensitiveText(text));
}

function capAnswer(text: string): string {
  if (text.length <= TELEGRAM_CHAT_ANSWER_MAX_CHARS) return text;
  return `${text.slice(0, TELEGRAM_CHAT_ANSWER_MAX_CHARS - 1).trimEnd()}…`;
}

function taskTitle(message: string): string {
  const firstLine = message.split("\n")[0]?.trim() || message;
  return firstLine.length <= TASK_TITLE_MAX ? firstLine : `${firstLine.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…`;
}

function httpCode(err: HttpError): string | null {
  const details = err.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : null;
  return typeof details?.code === "string" ? details.code : null;
}

type LaneAResultShape = {
  response?: unknown;
  conversationId?: unknown;
  actions?: Array<{
    ok?: unknown;
    tool?: unknown;
    task?: { issueId?: unknown; identifier?: unknown } | null;
    image?: { fileId?: unknown; seed?: unknown } | null;
  } | null>;
};

const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The pictures a quick answer made (Lane A already checked each is a picture in this company). */
function answerImages(result: LaneAResultShape): TelegramChatAskImage[] {
  const images: TelegramChatAskImage[] = [];
  for (const action of result.actions ?? []) {
    const fileId = action?.image?.fileId;
    if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId) || images.some((i) => i.fileId === fileId)) continue;
    const seed = action?.image?.seed;
    images.push({ fileId, seed: typeof seed === "number" && Number.isInteger(seed) ? seed : null });
  }
  return images.slice(0, 4);
}

type PersonContext = {
  userId: string;
  name: string;
  actor: AuthorizationActor;
};

export function telegramChatService(db: Db, deps: TelegramChatServiceDeps = {}) {
  const nowOf = deps.now ?? (() => new Date());
  const access = accessService(db);
  const boardAuth = boardAuthService(db);
  const issues = issueService(db);
  const storage = deps.storage ?? (() => getStorageService());
  const failedLinkAttempts = new Map<string, number[]>();

  /**
   * A photo the person sent, stored in the company's Files (no task) under a
   * "chat-photo-" name, so Media Studio checks it for apparent age before it
   * is sent to any picture service. Only JPEG, PNG or WebP, decided from the
   * bytes. Returns the file id, or a plain sentence for the person.
   */
  async function storePersonPhoto(
    companyId: string,
    userId: string,
    dataBase64: string,
  ): Promise<{ fileId: string } | { refusal: string }> {
    const raw = dataBase64.replace(/\s+/g, "");
    if (!raw || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) return { refusal: "I couldn't read that picture. Please send it again." };
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length === 0) return { refusal: "I couldn't read that picture. Please send it again." };
    if (bytes.length > CHAT_PHOTO_MAX_BYTES) {
      return { refusal: `That picture is larger than ${CHAT_PHOTO_MAX_BYTES / (1024 * 1024)} MB. Please send a smaller one.` };
    }
    const type = sniffChatPhotoType(bytes);
    if (!type) return { refusal: "I can only open JPEG, PNG or WebP pictures. Send it as a photo instead." };
    const stored = await storage().putFile({
      companyId,
      namespace: "company-files",
      originalFilename: chatPhotoFilename(type, nowOf()),
      contentType: type,
      body: bytes,
    });
    const created = await issues.createCompanyFile({
      companyId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: null,
      createdByUserId: userId,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "company_file.created",
      entityType: "company_file",
      entityId: created.id,
      details: { attachmentId: created.id, originalFilename: created.originalFilename, contentType: created.contentType, byteSize: created.byteSize, source: "telegram_chat" },
    }).catch(() => undefined);
    return { fileId: created.id };
  }

  // ─── Settings (owner/admin) ────────────────────────────────────────────────

  function toSettings(companyId: string, row: typeof telegramChatSettings.$inferSelect | undefined): TelegramChatSettings {
    return {
      companyId,
      enabled: row?.enabled ?? false,
      botId: row?.botId ?? null,
      quickAgentId: row?.quickAgentId ?? null,
      fullAgentId: row?.fullAgentId ?? null,
      dailyQuestionsPerPerson: row?.dailyQuestionsPerPerson ?? TELEGRAM_CHAT_DAILY_CAP_DEFAULT,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  async function settingsRow(companyId: string) {
    const [row] = await db.select().from(telegramChatSettings).where(eq(telegramChatSettings.companyId, companyId));
    return row;
  }

  async function getSettings(companyId: string): Promise<TelegramChatSettings> {
    return toSettings(companyId, await settingsRow(companyId));
  }

  async function companyAgent(companyId: string, agentId: string) {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    return row ?? null;
  }

  async function updateSettings(
    companyId: string,
    input: UpdateTelegramChatSettingsInput,
    userId: string | null,
  ): Promise<TelegramChatSettings> {
    if (input.botId) {
      const [bot] = await db
        .select({ id: telegramBots.id })
        .from(telegramBots)
        .where(and(eq(telegramBots.id, input.botId), eq(telegramBots.companyId, companyId)));
      if (!bot) throw unprocessable("That Telegram bot is not connected to this company.");
    }
    if (input.quickAgentId) {
      const agent = await companyAgent(companyId, input.quickAgentId);
      if (!agent) throw unprocessable("That quick agent is not in this company.");
      if (!agent.laneAEnabled) {
        throw unprocessable(`${agent.name} does not have quick answers switched on. Switch them on on its page first, or pick another agent.`);
      }
    }
    if (input.fullAgentId) {
      const agent = await companyAgent(companyId, input.fullAgentId);
      if (!agent) throw unprocessable("That agent is not in this company.");
    }
    if (input.enabled) {
      if (!input.botId) throw unprocessable("Pick the Telegram bot people should write to before switching this on.");
      if (!input.quickAgentId && !input.fullAgentId) {
        throw unprocessable("Pick a quick agent, a full agent, or both, before switching this on.");
      }
    }
    const now = nowOf();
    const values = {
      companyId,
      enabled: input.enabled,
      botId: input.botId,
      quickAgentId: input.quickAgentId,
      fullAgentId: input.fullAgentId,
      dailyQuestionsPerPerson: input.dailyQuestionsPerPerson,
      updatedByUserId: userId,
      updatedAt: now,
    };
    await db
      .insert(telegramChatSettings)
      .values(values)
      .onConflictDoUpdate({ target: telegramChatSettings.companyId, set: values });
    return getSettings(companyId);
  }

  /** The bot (if any) that answers linked people for this company right now. */
  async function peopleBotId(companyId: string): Promise<string | null> {
    const row = await settingsRow(companyId);
    return row?.enabled && row.botId ? row.botId : null;
  }

  // ─── The person's own link (profile page) ─────────────────────────────────

  async function linkRow(userId: string) {
    const [row] = await db.select().from(telegramPersonLinks).where(eq(telegramPersonLinks.userId, userId));
    return row;
  }

  async function linkStatus(userId: string): Promise<TelegramLinkStatus> {
    const row = await linkRow(userId);
    const now = nowOf();
    const pending = row?.linkCodeHash && row.linkCodeExpiresAt && row.linkCodeExpiresAt > now ? row.linkCodeExpiresAt : null;
    return {
      linked: Boolean(row?.telegramUserId),
      telegramUsername: row?.telegramUserId ? (row.telegramUsername ?? null) : null,
      linkedAt: row?.telegramUserId && row.linkedAt ? row.linkedAt.toISOString() : null,
      pendingCodeExpiresAt: pending ? pending.toISOString() : null,
    };
  }

  /** A fresh one-time code; any earlier code stops working. An existing link stays until the code is used. */
  async function createLinkCode(userId: string): Promise<TelegramLinkCode> {
    const code = generateTelegramLinkCode();
    const now = nowOf();
    const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
    const hash = hashTelegramLinkCode(code);
    if (!hash) throw new HttpError(503, LINKING_UNAVAILABLE, { code: "TELEGRAM_LINK_UNAVAILABLE" });
    const set = { linkCodeHash: hash, linkCodeExpiresAt: expiresAt, updatedAt: now };
    await db
      .insert(telegramPersonLinks)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: telegramPersonLinks.userId, set });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async function unlink(userId: string): Promise<TelegramLinkStatus> {
    await db
      .update(telegramPersonLinks)
      .set({
        telegramUserId: null,
        telegramUsername: null,
        linkedAt: null,
        linkCodeHash: null,
        linkCodeExpiresAt: null,
        updatedAt: nowOf(),
      })
      .where(eq(telegramPersonLinks.userId, userId));
    return linkStatus(userId);
  }

  // ─── Bridge: /link CODE ────────────────────────────────────────────────────

  async function loadBot(companyId: string, botId: string) {
    const [bot] = await db
      .select()
      .from(telegramBots)
      .where(and(eq(telegramBots.id, botId), eq(telegramBots.companyId, companyId)));
    if (!bot || !bot.enabled) throw notFound("That Telegram bot was not found.");
    return bot;
  }

  async function companyName(companyId: string): Promise<string> {
    const [row] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    return row?.name ?? "this company";
  }

  function tooManyLinkAttempts(telegramUserId: string, now: number): boolean {
    const recent = (failedLinkAttempts.get(telegramUserId) ?? []).filter((at) => now - at < TELEGRAM_LINK_ATTEMPT_WINDOW_MS);
    failedLinkAttempts.set(telegramUserId, recent);
    return recent.length >= TELEGRAM_LINK_MAX_FAILED_ATTEMPTS;
  }

  async function claimLink(companyId: string, input: TelegramChatLinkInput): Promise<TelegramChatLinkResult> {
    const bot = await loadBot(companyId, input.botId);
    if ((await peopleBotId(companyId)) !== bot.id) {
      return { outcome: "not_enabled", reply: "This bot does not answer linked accounts right now." };
    }
    const now = nowOf();
    if (tooManyLinkAttempts(input.telegramUserId, now.getTime())) {
      return {
        outcome: "too_many_attempts",
        reply: "Too many wrong codes. Wait 15 minutes, make a new code on your Paperclip profile page, and try again.",
      };
    }
    const hash = hashTelegramLinkCode(input.code);
    if (!hash) return { outcome: "bad_code", reply: LINKING_UNAVAILABLE };
    const [row] = await db
      .select()
      .from(telegramPersonLinks)
      .where(and(eq(telegramPersonLinks.linkCodeHash, hash), gte(telegramPersonLinks.linkCodeExpiresAt, now)));
    if (!row) {
      failedLinkAttempts.set(input.telegramUserId, [...(failedLinkAttempts.get(input.telegramUserId) ?? []), now.getTime()]);
      return {
        outcome: "bad_code",
        reply: "That code did not work. Codes work once and only for 15 minutes. Make a new one on your Paperclip profile page and send /link followed by the code.",
      };
    }
    // One Telegram account belongs to one person: a link it had to someone
    // else is removed first (the code proves the Paperclip side; the sender
    // id, which only Telegram vouches for, proves the Telegram side).
    await db
      .update(telegramPersonLinks)
      .set({ telegramUserId: null, telegramUsername: null, linkedAt: null, updatedAt: now })
      .where(and(eq(telegramPersonLinks.telegramUserId, input.telegramUserId), sql`${telegramPersonLinks.userId} <> ${row.userId}`));
    await db
      .update(telegramPersonLinks)
      .set({
        telegramUserId: input.telegramUserId,
        telegramUsername: input.telegramUsername?.trim() || null,
        linkedAt: now,
        linkCodeHash: null,
        linkCodeExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(telegramPersonLinks.userId, row.userId));
    failedLinkAttempts.delete(input.telegramUserId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: row.userId,
      action: "telegram.person_linked",
      entityType: "telegram_bot",
      entityId: bot.id,
      details: { botName: bot.name },
    }).catch(() => undefined);
    const person = await personContext(row.userId, companyId);
    const company = await companyName(companyId);
    return {
      outcome: "linked",
      reply: person
        ? `Linked. You can now ask me about ${company} here, for example "How did sales go last week?".`
        : `Linked. But your Paperclip account is not an active member of ${company}, so I cannot answer you yet. Ask the company's owner to add you.`,
    };
  }

  // ─── Who is asking ─────────────────────────────────────────────────────────

  /**
   * The person as a board actor, built from their own active memberships
   * exactly the way the auth middleware builds it for their browser session.
   * Null when they may not use this company through Telegram at all.
   */
  async function personContext(userId: string, companyId: string): Promise<PersonContext | null> {
    const resolved = await boardAuth.resolveBoardAccess(userId);
    if (!resolved.user) return null;
    const membership = resolved.memberships.find((item) => item.companyId === companyId && item.status === "active");
    if (!membership && !resolved.isInstanceAdmin) return null;
    if (membership?.membershipRole === "employee" && !resolved.isInstanceAdmin) {
      if (!(await access.hasPermission(companyId, "user", userId, "feature:pa_chat"))) return null;
    }
    return {
      userId,
      name: resolved.user.name?.trim() || resolved.user.email || "A team member",
      actor: {
        type: "board",
        userId,
        companyIds: resolved.companyIds,
        memberships: resolved.memberships,
        isInstanceAdmin: resolved.isInstanceAdmin,
        source: "session",
      },
    };
  }

  async function personByTelegramUser(telegramUserId: string) {
    const [row] = await db
      .select()
      .from(telegramPersonLinks)
      .where(eq(telegramPersonLinks.telegramUserId, telegramUserId));
    return row ?? null;
  }

  async function questionsToday(companyId: string, userId: string, now: Date): Promise<number> {
    const today = zonedParts(now, LIMIT_DAY_TIMEZONE);
    const dayStart = zonedDayStart(today.year, today.month, today.day, LIMIT_DAY_TIMEZONE);
    const [row] = await db
      .select({ n: count() })
      .from(telegramChatRequests)
      .where(
        and(
          eq(telegramChatRequests.companyId, companyId),
          eq(telegramChatRequests.userId, userId),
          gte(telegramChatRequests.createdAt, dayStart),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async function recentConversation(companyId: string, userId: string, quickAgentId: string, now: Date): Promise<string | undefined> {
    const [row] = await db
      .select({ conversationId: telegramChatRequests.conversationId })
      .from(telegramChatRequests)
      .where(
        and(
          eq(telegramChatRequests.companyId, companyId),
          eq(telegramChatRequests.userId, userId),
          eq(telegramChatRequests.quickAgentId, quickAgentId),
          gte(telegramChatRequests.createdAt, new Date(now.getTime() - TELEGRAM_CHAT_CONVERSATION_IDLE_MS)),
          sql`${telegramChatRequests.conversationId} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${telegramChatRequests.createdAt} desc`)
      .limit(1);
    return row?.conversationId ?? undefined;
  }

  function laneATarget(agent: typeof agents.$inferSelect): LaneATargetAgent {
    // The same fields routes/chat-router.ts passes, so a Telegram question is
    // answered with exactly the settings the web chat uses.
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      laneAEnabled: agent.laneAEnabled,
      laneAInstructions: agent.laneAInstructions ?? null,
      mcpToolIds: (agent.mcpToolIds as string[] | null) ?? [],
      laneAModel: agent.laneAModel ?? null,
      laneAMaxOutputTokens: agent.laneAMaxOutputTokens ?? null,
      laneAProvider: agent.laneAProvider ?? null,
      laneABaseUrl: agent.laneABaseUrl ?? null,
      laneATemperature: agent.laneATemperature ?? null,
      laneAAssignedUserIds: (agent.laneAAssignedUserIds as string[] | null) ?? [],
      laneAProviderRouting: agent.laneAProviderRouting ?? null,
    };
  }

  // ─── Bridge: a question ────────────────────────────────────────────────────

  async function ask(companyId: string, input: TelegramChatAskInput): Promise<TelegramChatAskResult> {
    const bot = await loadBot(companyId, input.botId);
    const settings = await settingsRow(companyId);
    if (!settings?.enabled || settings.botId !== bot.id) {
      return { outcome: "not_enabled", reply: "This bot does not answer linked accounts right now.", requestId: null };
    }
    if (input.chatId !== input.telegramUserId) {
      return { outcome: "refused", reply: "I only answer in a private chat with me.", requestId: null };
    }
    const link = await personByTelegramUser(input.telegramUserId);
    if (!link) {
      return {
        outcome: "not_linked",
        reply:
          "Hi! I only answer people who have linked their Telegram to their Paperclip account. " +
          "To link: open Paperclip, go to your profile, press \"Link Telegram\", and send me /link followed by the code it shows.",
        requestId: null,
      };
    }
    const company = await companyName(companyId);
    const person = await personContext(link.userId, companyId);
    if (!person) {
      return {
        outcome: "no_access",
        reply: `Your Telegram is linked, but your Paperclip account cannot use ${company} this way. Ask the company's owner or an admin to give you access.`,
        requestId: null,
      };
    }
    const now = nowOf();
    const cap = settings.dailyQuestionsPerPerson;
    if ((await questionsToday(companyId, person.userId, now)) >= cap) {
      return {
        outcome: "over_cap",
        reply: `You have asked ${cap} questions today, which is the daily limit for ${company}. It starts again at midnight (Norway time).`,
        requestId: null,
      };
    }

    const quickAgent = settings.quickAgentId ? await companyAgent(companyId, settings.quickAgentId) : null;
    const quickUsable = Boolean(quickAgent && quickAgent.laneAEnabled && !UNUSABLE_AGENT_STATUSES.has(quickAgent.status));
    const notes: string[] = [];

    // Counted (and audited) before anything is spent, so a failure still
    // counts towards the person's daily limit.
    const [request] = await db
      .insert(telegramChatRequests)
      .values({
        companyId,
        botId: bot.id,
        userId: person.userId,
        telegramUserId: input.telegramUserId,
        chatId: input.chatId,
        question: input.message.slice(0, 4_000),
        route: "quick",
        quickAgentId: quickUsable ? quickAgent!.id : null,
        status: "asking",
        createdAt: now,
      })
      .returning();
    const requestId = request!.id;

    // The photo is stored only now: the person is linked, may use this
    // company, and is under the daily limit.
    let pictureFileId: string | null = null;
    if (input.picture) {
      const stored = await storePersonPhoto(companyId, person.userId, input.picture.dataBase64);
      if ("refusal" in stored) {
        await finish(requestId, "failed", { note: "picture refused" });
        return { outcome: "refused", reply: stored.refusal, requestId };
      }
      pictureFileId = stored.fileId;
    }

    if (quickUsable && (pictureFileId !== null || shouldTryQuickAnswer(input.message)) && deps.laneA) {
      const conversationId = input.fresh ? undefined : await recentConversation(companyId, person.userId, quickAgent!.id, now);
      const send = (conversation?: string) =>
        deps.laneA!.sendMessage({
          companyId,
          targetAgent: laneATarget(quickAgent!),
          requester: { userId: person.userId, agentId: null },
          actor: person.actor,
          message: input.message,
          conversationId: conversation,
          ...(pictureFileId ? { attachmentFileIds: [pictureFileId] } : {}),
        });
      let result: LaneAResultShape | null = null;
      try {
        try {
          result = (await send(conversationId)) as LaneAResultShape;
        } catch (err) {
          if (conversationId && err instanceof HttpError && CONVERSATION_ENDED_CODES.has(httpCode(err) ?? "")) {
            result = (await send(undefined)) as LaneAResultShape;
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          // Not this person's to ask (e.g. the quick agent only answers its
          // assigned people). Handing it to the full agent instead would get
          // round that rule, so say so and stop.
          await finish(requestId, "failed", { note: `quick agent refused: ${httpCode(err) ?? err.status}` });
          return { outcome: "refused", reply: redactOut(err.message), requestId };
        }
        logger.warn(
          { companyId, agentId: quickAgent!.id, status: err instanceof HttpError ? err.status : null, code: err instanceof HttpError ? httpCode(err) : null },
          "telegram chat: quick answer failed, handing the question over",
        );
        notes.push("Quick answers aren't available right now, so I've handed this over as a task.");
      }

      if (result) {
        const conversation = typeof result.conversationId === "string" ? result.conversationId : null;
        const answer = capAnswer(redactOut(String(result.response ?? "").trim()))
          || `${quickAgent!.name} gave no answer. Try asking again, or say it a different way.`;
        // A task the quick agent handed to a colleague: its answer comes
        // back here later, like the full agent's.
        const handed = (result.actions ?? []).find(
          (action) => action && action.ok !== false && action.task && typeof action.task.issueId === "string",
        );
        const handedIssueId = handed?.task?.issueId as string | undefined;
        const handedIssue = handedIssueId
          ? await db
              .select({ id: issuesTable.id })
              .from(issuesTable)
              .where(and(eq(issuesTable.id, handedIssueId), eq(issuesTable.companyId, companyId)))
              .then((rows) => rows[0] ?? null)
          : null;
        await db
          .update(telegramChatRequests)
          .set({
            route: "quick",
            conversationId: conversation,
            issueId: handedIssue?.id ?? null,
            status: handedIssue ? "waiting" : "answered",
            readyAt: handedIssue ? null : nowOf(),
          })
          .where(eq(telegramChatRequests.id, requestId));
        const images = answerImages(result);
        return { outcome: "answered", reply: answer, requestId, ...(images.length > 0 ? { images } : {}) };
      }
    }

    return handOver({
      companyId,
      bot,
      settings,
      person,
      input,
      requestId,
      notes,
      quickAgentName: quickUsable ? quickAgent!.name : null,
      pictureFileId,
    });
  }

  async function handOver(params: {
    companyId: string;
    bot: typeof telegramBots.$inferSelect;
    settings: typeof telegramChatSettings.$inferSelect;
    person: PersonContext;
    input: TelegramChatAskInput;
    requestId: string;
    notes: string[];
    quickAgentName: string | null;
    pictureFileId?: string | null;
  }): Promise<TelegramChatAskResult> {
    const { companyId, settings, person, input, requestId, notes } = params;
    const fullAgent = settings.fullAgentId ? await companyAgent(companyId, settings.fullAgentId) : null;
    if (!fullAgent || fullAgent.status === "terminated") {
      await finish(requestId, "failed", { note: "no full agent chosen" });
      return {
        outcome: "refused",
        reply: params.quickAgentName
          ? `${params.quickAgentName} can't take this one, and nobody is set up to take bigger questions from Telegram. Ask in Paperclip instead.`
          : "Nobody is set up to answer questions from Telegram yet. Ask the company's owner to pick an agent in Paperclip.",
        requestId,
      };
    }
    const decision = await access.decide({
      actor: params.person.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: null,
        projectId: null,
        parentIssueId: null,
        assigneeAgentId: fullAgent.id,
        assigneeUserId: null,
      },
      scope: { assigneeAgentId: fullAgent.id },
    });
    if (!decision.allowed) {
      await finish(requestId, "failed", { note: "person may not give tasks to the full agent" });
      return {
        outcome: "refused",
        reply: `This needs ${fullAgent.name}, and your account is not allowed to give it tasks. Ask the company's owner or an admin.`,
        requestId,
      };
    }
    const description = [
      input.message,
      "",
      "---",
      `Asked on Telegram by ${person.name}. When you are done, write your answer as your last comment on this task: ` +
        "it is sent back to them in Telegram as plain text, so keep it short (no tables), and give the period and the source for every number.",
      ...(params.pictureFileId ? [`They sent a picture with the question, saved in the company's Files: file id ${params.pictureFileId}.`] : []),
    ].join("\n");
    const issue = await issues.create(companyId, {
      id: randomUUID(),
      title: taskTitle(input.message),
      description,
      assigneeAgentId: fullAgent.id,
      status: "todo",
      priority: "medium",
      createdByAgentId: null,
      createdByUserId: person.userId,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: person.userId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier, source: "telegram_chat" },
    }).catch(() => undefined);
    if (deps.heartbeat) {
      void queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "telegram_chat.ask",
        requestedByActorType: "user",
        requestedByActorId: person.userId,
      });
    }
    await db
      .update(telegramChatRequests)
      .set({ route: "task", issueId: issue.id, status: "waiting" })
      .where(eq(telegramChatRequests.id, requestId));
    const ident = issue.identifier ?? "a task";
    return {
      outcome: "handed_over",
      reply: [...notes, `I've handed this to ${fullAgent.name} as ${ident}. I'll send the answer here when it's done.`].join("\n\n"),
      requestId,
    };
  }

  async function finish(
    requestId: string,
    status: "failed" | "expired",
    extra: { note?: string; clearAnswer?: boolean; onlyFrom?: "ready" } = {},
  ) {
    await db
      .update(telegramChatRequests)
      .set({ status, note: extra.note ?? null, ...(extra.clearAnswer ? { answerText: null } : {}) })
      .where(
        extra.onlyFrom
          ? and(eq(telegramChatRequests.id, requestId), eq(telegramChatRequests.status, extra.onlyFrom))
          : eq(telegramChatRequests.id, requestId),
      );
  }

  // ─── Bridge: the outbox ────────────────────────────────────────────────────

  /**
   * Turns finished tasks into ready answers (after checking again that the
   * person may still see them), retires stale rows, and returns what the
   * bridge should send now.
   */
  async function outbox(companyId: string): Promise<TelegramChatOutboxItem[]> {
    const now = nowOf();
    await db
      .update(telegramChatRequests)
      .set({ status: "expired" })
      .where(
        and(
          eq(telegramChatRequests.companyId, companyId),
          eq(telegramChatRequests.status, "ready"),
          lt(telegramChatRequests.readyAt, new Date(now.getTime() - TELEGRAM_CHAT_READY_MAX_AGE_MS)),
        ),
      );
    await db
      .update(telegramChatRequests)
      .set({ status: "expired" })
      .where(
        and(
          eq(telegramChatRequests.companyId, companyId),
          inArray(telegramChatRequests.status, ["waiting", "asking"]),
          lt(telegramChatRequests.createdAt, new Date(now.getTime() - TELEGRAM_CHAT_WAITING_MAX_AGE_MS)),
        ),
      );

    const waiting = await db
      .select()
      .from(telegramChatRequests)
      .where(and(eq(telegramChatRequests.companyId, companyId), eq(telegramChatRequests.status, "waiting")))
      .orderBy(asc(telegramChatRequests.createdAt))
      .limit(TELEGRAM_CHAT_OUTBOX_BATCH);
    for (const row of waiting) {
      try {
        await promote(row, now);
      } catch (err) {
        logger.warn({ err, companyId, requestId: row.id }, "telegram chat: could not check a waiting answer");
      }
    }

    const ready = await db
      .select()
      .from(telegramChatRequests)
      .where(and(eq(telegramChatRequests.companyId, companyId), eq(telegramChatRequests.status, "ready")))
      .orderBy(asc(telegramChatRequests.createdAt))
      .limit(TELEGRAM_CHAT_OUTBOX_BATCH);
    const items: TelegramChatOutboxItem[] = [];
    for (const row of ready) {
      // Checked again on every read, not only when the answer was written: a
      // ready answer can wait for the bridge (Paperclip restarting, the bot
      // offline) while the person unlinks, leaves the company or loses
      // access to the task.
      let issue: typeof issuesTable.$inferSelect | null = null;
      let refusal: string | null;
      try {
        issue = row.issueId ? await loadIssue(row.companyId, row.issueId) : null;
        refusal = issue ? await deliveryRefusal(row, issue) : "the task is gone";
      } catch (err) {
        logger.warn({ err, companyId, requestId: row.id }, "telegram chat: could not re-check a ready answer");
        continue; // not sent this pass; checked again on the next
      }
      if (refusal) {
        await finish(row.id, "failed", { note: refusal, clearAnswer: true, onlyFrom: "ready" });
        continue;
      }
      items.push({
        id: row.id,
        botId: row.botId,
        chatId: row.chatId,
        text: row.answerText ?? "",
        taskIdentifier: issue?.identifier ?? null,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return items;
  }

  async function loadIssue(companyId: string, issueId: string) {
    const [issue] = await db
      .select()
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, companyId)));
    return issue ?? null;
  }

  /**
   * Why this answer may not go to this person any more, or null when it may:
   * they must still be linked to the same Telegram account, still be able to
   * use the company, and still be allowed to see the task.
   */
  async function deliveryRefusal(
    row: typeof telegramChatRequests.$inferSelect,
    issue: typeof issuesTable.$inferSelect,
  ): Promise<string | null> {
    const link = await linkRow(row.userId);
    if (!link || link.telegramUserId !== row.telegramUserId) return "the person unlinked this Telegram account";
    const person = await personContext(row.userId, row.companyId);
    if (!person) return "the person may no longer use this company";
    const decision = await access.decide({
      actor: person.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
    return decision.allowed ? null : "the person may no longer see this task";
  }

  async function promote(row: typeof telegramChatRequests.$inferSelect, now: Date) {
    if (!row.issueId) {
      await finish(row.id, "failed", { note: "the task is gone" });
      return;
    }
    const issue = await loadIssue(row.companyId, row.issueId);
    if (!issue) {
      await finish(row.id, "failed", { note: "the task is gone" });
      return;
    }
    if (!ANSWERED_TASK_STATUSES.has(issue.status)) return;

    // Checked again now, not when the question was asked (and again on every
    // outbox read after this, see outbox()).
    const refusal = await deliveryRefusal(row, issue);
    if (refusal) {
      await finish(row.id, "failed", { note: refusal });
      return;
    }

    const comments = (await issues.listComments(issue.id, { order: "desc", limit: ANSWER_SCAN_COMMENTS })) as Array<{
      authorAgentId?: string | null;
      authorType?: string;
      body: string;
      createdAt: string | Date;
      deletedAt?: string | Date | null;
      presentation?: { kind?: string | null } | null;
    }>;
    const answer = comments
      .filter(
        (comment) =>
          (comment.authorType ? comment.authorType === "agent" : Boolean(comment.authorAgentId)) &&
          !comment.deletedAt &&
          comment.presentation?.kind !== "system_notice" &&
          new Date(comment.createdAt).getTime() >= row.createdAt.getTime(),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const ident = issue.identifier ?? "The task";
    let head: string;
    if (issue.status === "done") head = `✅ ${ident} is finished`;
    else if (issue.status === "cancelled") head = `✖️ ${ident} was cancelled`;
    else head = `⏸ ${ident} is waiting and may need someone in Paperclip`;
    const body = answer ? redactOut(answer.body.trim()) : "There is no written answer.";
    await db
      .update(telegramChatRequests)
      .set({ status: "ready", answerText: capAnswer(`${head}\n\n${body}`), readyAt: now })
      .where(and(eq(telegramChatRequests.id, row.id), eq(telegramChatRequests.status, "waiting")));
  }

  async function ack(companyId: string, requestId: string, outcome: "delivered" | "failed") {
    const [row] = await db
      .update(telegramChatRequests)
      .set({ status: outcome, deliveredAt: outcome === "delivered" ? nowOf() : null })
      .where(
        and(
          eq(telegramChatRequests.id, requestId),
          eq(telegramChatRequests.companyId, companyId),
          eq(telegramChatRequests.status, "ready"),
        ),
      )
      .returning({ id: telegramChatRequests.id, status: telegramChatRequests.status });
    if (!row) {
      // Already acknowledged (a retried ack after a lost answer) is fine;
      // anything else is a request this company does not have.
      const [existing] = await db
        .select({ status: telegramChatRequests.status })
        .from(telegramChatRequests)
        .where(and(eq(telegramChatRequests.id, requestId), eq(telegramChatRequests.companyId, companyId)));
      if (!existing) throw notFound("That answer was not found.");
      return { id: requestId, status: existing.status };
    }
    return row;
  }

  return {
    getSettings,
    updateSettings,
    peopleBotId,
    linkStatus,
    createLinkCode,
    unlink,
    claimLink,
    ask,
    outbox,
    ack,
  };
}

export type TelegramChatService = ReturnType<typeof telegramChatService>;
