import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  laneAConversations,
  laneAMessages,
  telegramMessageReactions,
  type LaneAStoredToolCall,
} from "@paperclipai/db";
import { maskSecretLikeText } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { LANE_A_RECAP_ROLE, LANE_A_RECAP_SUMMARY_TOOL } from "./lane-a-continue.js";

/**
 * "Conversations" on a quick agent's page: what the quick agent told people,
 * for review. Read-only (no deletion in this slice).
 *
 * Who sees what (the route decides `viewer.canSeeAll`, this file enforces it):
 *   - Owners and admins (and the local board / instance admins) see every
 *     conversation of this company's quick agent, EXCEPT the content of an
 *     Employee (light) member's chat. DUR-4094 made those private: an owner
 *     may only read one through the logged emergency-access route
 *     (routes/private-access.ts). Here they appear as a row with who/when/how
 *     many messages and nothing from inside the chat, and a text search never
 *     matches them (a match would itself leak what was said).
 *   - Everyone else sees only the conversations they started themselves.
 *
 * Everything is filtered by company and agent in SQL, never after the fact.
 * Displayed text goes through maskSecretLikeText, so a key someone pasted into
 * a chat is not shown back on the review page.
 */

export const CONVERSATION_LOG_DEFAULT_LIMIT = 25;
export const CONVERSATION_LOG_MAX_LIMIT = 100;
export const CONVERSATION_LOG_SEARCH_MAX_LENGTH = 200;
export const CONVERSATION_LOG_SEARCH_MIN_LENGTH = 2;
const FIRST_QUESTION_MAX_CHARS = 160;
const HANDOFF_TOOL = "route_to_agent";
const INTERNAL_TOOLS = new Set(["action_claim_check", LANE_A_RECAP_SUMMARY_TOOL]);

export interface ConversationLogViewer {
  /** The signed-in person; null only for the local implicit board. */
  userId: string | null;
  /** Owner/admin (or local board / instance admin): sees every conversation of the agent. */
  canSeeAll: boolean;
}

export interface ConversationLogFilters {
  /** Only conversations started by this person. */
  userId?: string;
  /** Conversations active on or after this moment. */
  from?: Date;
  /** Conversations started before this moment. */
  to?: Date;
  /** Only conversations where the agent handed work to a colleague. */
  hasHandoffs?: boolean;
  /** Words to find in the messages (case-insensitive substring). */
  q?: string;
}

export interface ConversationLogPerson {
  kind: "user" | "agent";
  id: string;
  name: string;
}

export interface ConversationLogToolUse {
  label: string;
  count: number;
}

export interface ConversationLogRow {
  id: string;
  person: ConversationLogPerson | null;
  /** Where the chat happened, when Paperclip recorded it ("telegram"); null when not recorded. */
  channel: "telegram" | null;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  /** The first thing the person asked, shortened and masked. Null for a private chat. */
  firstQuestion: string | null;
  /** What the quick agent did, in plain words, e.g. "Made a picture" ×2. Empty for a private chat. */
  toolUse: ConversationLogToolUse[];
  handoffCount: number;
  /** An Employee (light) member's chat: the owner sees that it exists, not what was said. */
  private: boolean;
  /** The viewer started this conversation. */
  mine: boolean;
}

export interface ConversationLogPage {
  conversations: ConversationLogRow[];
  nextCursor: string | null;
  /** People who have chats with this agent, for the "person" filter. Only for owners/admins. */
  people: ConversationLogPerson[];
  canSeeAll: boolean;
}

export interface ConversationLogAction {
  tool: string;
  /** Short plain label ("Made a picture", "Handed to Bob"). */
  label: string;
  /** The stored one-line summary of what happened, masked. */
  summary: string;
  ok: boolean;
  image: { contentPath: string; contentType: string } | null;
  task: { issueId: string; identifier: string | null; title: string } | null;
}

export interface ConversationLogMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  actions: ConversationLogAction[];
}

export interface ConversationLogTranscript {
  conversation: ConversationLogRow;
  /** A continued conversation's one-line recap of what it carried on from. */
  continuedFrom: string | null;
  messages: ConversationLogMessage[];
}

/** The plain label an operator reads for one stored tool call. */
export function describeToolCall(call: Pick<LaneAStoredToolCall, "tool" | "summary" | "ok" | "image" | "task">): string {
  if (call.image) return "Made a picture";
  const summary = typeof call.summary === "string" ? call.summary : "";
  switch (call.tool) {
    case HANDOFF_TOOL: {
      if (!call.ok) return "Tried to hand over work";
      const match = /^Handed to (.+?) as task\b/.exec(summary);
      return match ? `Handed to ${match[1]}` : "Handed work to a colleague";
    }
    case "start_job":
      return call.ok ? "Started a job" : "Tried to start a job";
    case "start_research_task":
      return "Started a research task";
    case "read_business_data":
      return "Read business data";
    case "read_company_file":
      return "Read a company file";
    case "search_documents":
    case "get_document":
      return "Read company documents";
    case "web_search":
      return "Searched the web";
    case "read_web_page":
      return "Read a web page";
    case "get_weather":
      return "Checked the weather";
    case "get_time":
      return "Checked the time";
    case "lookup_issue":
      return "Looked up a task";
    case "remember":
      return "Saved a note";
    case "forget":
      return "Removed a note";
    case "search_conversations":
      return "Searched earlier chats";
    case "action_claim_check":
      return "Checked its own claim";
    default: {
      // Add-on tools are stored as "<plugin key>:<tool>" or "<plugin>__<tool>".
      const bare = String(call.tool ?? "tool").split(/[:]|__/).pop() ?? "tool";
      const words = bare.replace(/[-_]+/g, " ").trim().slice(0, 48) || "a tool";
      return call.ok ? `Used ${words}` : `Tried ${words}`;
    }
  }
}

function isHandoff(call: LaneAStoredToolCall | null | undefined): boolean {
  return Boolean(call && call.tool === HANDOFF_TOOL && call.ok);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Opaque cursor: the last row's (last_message_at, id). */
export function encodeConversationCursor(lastMessageAt: Date, id: string): string {
  return Buffer.from(`${lastMessageAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeConversationCursor(cursor: string): { at: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const [iso, id] = raw.split("|");
  const at = new Date(iso ?? "");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(at.getTime())) throw badRequest("Invalid cursor");
  return { at, id };
}

export function laneAConversationLogService(db: Db) {
  /** SQL: the conversation was started by an active Employee (light) member of its company. */
  const privateExpr = sql<boolean>`exists (
    select 1 from ${companyMemberships} cm
    where cm.company_id = ${laneAConversations.companyId}
      and cm.principal_type = 'user'
      and cm.principal_id = ${laneAConversations.requestedByUserId}
      and cm.status = 'active'
      and cm.membership_role = 'employee'
  )`;

  function visibilityCondition(viewer: ConversationLogViewer): SQL | undefined {
    if (viewer.canSeeAll) return undefined;
    // Only your own; a viewer with no user id (should not happen for a member) sees nothing.
    if (!viewer.userId) return sql`false`;
    return eq(laneAConversations.requestedByUserId, viewer.userId);
  }

  async function namesFor(userIds: string[], agentIds: string[]) {
    const [users, agentRows] = await Promise.all([
      userIds.length
        ? db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      agentIds.length
        ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    return {
      users: new Map(users.map((row) => [row.id, row.name])),
      agents: new Map(agentRows.map((row) => [row.id, row.name])),
    };
  }

  type ConversationHead = {
    id: string;
    requestedByUserId: string | null;
    requestedByAgentId: string | null;
    createdAt: Date;
    lastMessageAt: Date;
    isPrivate: boolean;
  };

  /** Builds the list rows (counts, first question, tool use, channel) for a page of conversations. */
  async function buildRows(heads: ConversationHead[], viewer: ConversationLogViewer): Promise<ConversationLogRow[]> {
    if (heads.length === 0) return [];
    const ids = heads.map((head) => head.id);
    const [counts, firstQuestions, toolRows, telegramRows, names] = await Promise.all([
      db
        .select({ conversationId: laneAMessages.conversationId, count: sql<number>`count(*)::int` })
        .from(laneAMessages)
        .where(and(inArray(laneAMessages.conversationId, ids), inArray(laneAMessages.role, ["user", "assistant"])))
        .groupBy(laneAMessages.conversationId),
      db
        .selectDistinctOn([laneAMessages.conversationId], {
          conversationId: laneAMessages.conversationId,
          content: laneAMessages.content,
        })
        .from(laneAMessages)
        .where(and(inArray(laneAMessages.conversationId, ids), eq(laneAMessages.role, "user")))
        .orderBy(laneAMessages.conversationId, asc(laneAMessages.createdAt)),
      db
        .select({ conversationId: laneAMessages.conversationId, toolCalls: laneAMessages.toolCalls })
        .from(laneAMessages)
        .where(
          and(
            inArray(laneAMessages.conversationId, ids),
            eq(laneAMessages.role, "assistant"),
            isNotNull(laneAMessages.toolCalls),
          ),
        ),
      db
        .selectDistinct({ conversationId: telegramMessageReactions.conversationId })
        .from(telegramMessageReactions)
        .where(inArray(telegramMessageReactions.conversationId, ids)),
      namesFor(
        [...new Set(heads.map((head) => head.requestedByUserId).filter((id): id is string => Boolean(id)))],
        [...new Set(heads.map((head) => head.requestedByAgentId).filter((id): id is string => Boolean(id)))],
      ),
    ]);

    const countBy = new Map(counts.map((row) => [row.conversationId, Number(row.count)]));
    const firstBy = new Map(firstQuestions.map((row) => [row.conversationId, row.content]));
    const telegram = new Set(telegramRows.map((row) => row.conversationId));
    const toolsBy = new Map<string, { labels: Map<string, number>; handoffs: number }>();
    for (const row of toolRows) {
      const calls = Array.isArray(row.toolCalls) ? row.toolCalls : [];
      let entry = toolsBy.get(row.conversationId);
      if (!entry) {
        entry = { labels: new Map(), handoffs: 0 };
        toolsBy.set(row.conversationId, entry);
      }
      for (const call of calls) {
        if (!call || typeof call.tool !== "string" || INTERNAL_TOOLS.has(call.tool)) continue;
        const label = describeToolCall(call);
        entry.labels.set(label, (entry.labels.get(label) ?? 0) + 1);
        if (isHandoff(call)) entry.handoffs += 1;
      }
    }

    return heads.map((head) => {
      const mine = Boolean(viewer.userId) && head.requestedByUserId === viewer.userId;
      // Your own chat is never private from you.
      const hidden = head.isPrivate && !mine;
      const tools = toolsBy.get(head.id);
      const first = firstBy.get(head.id);
      let person: ConversationLogPerson | null = null;
      if (head.requestedByUserId) {
        person = { kind: "user", id: head.requestedByUserId, name: names.users.get(head.requestedByUserId) ?? "Unknown person" };
      } else if (head.requestedByAgentId) {
        person = { kind: "agent", id: head.requestedByAgentId, name: names.agents.get(head.requestedByAgentId) ?? "Unknown agent" };
      }
      return {
        id: head.id,
        person,
        channel: telegram.has(head.id) ? "telegram" : null,
        startedAt: head.createdAt.toISOString(),
        lastMessageAt: head.lastMessageAt.toISOString(),
        messageCount: countBy.get(head.id) ?? 0,
        firstQuestion: hidden || !first ? null : truncate(maskSecretLikeText(first), FIRST_QUESTION_MAX_CHARS),
        toolUse: hidden
          ? []
          : [...(tools?.labels.entries() ?? [])]
              .map(([label, count]) => ({ label, count }))
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
        handoffCount: hidden ? 0 : (tools?.handoffs ?? 0),
        private: hidden,
        mine,
      } satisfies ConversationLogRow;
    });
  }

  async function listConversations(params: {
    companyId: string;
    agentId: string;
    viewer: ConversationLogViewer;
    filters?: ConversationLogFilters;
    limit?: number;
    cursor?: string | null;
  }): Promise<ConversationLogPage> {
    const { companyId, agentId, viewer } = params;
    const filters = params.filters ?? {};
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? CONVERSATION_LOG_DEFAULT_LIMIT), 1), CONVERSATION_LOG_MAX_LIMIT);

    const conditions: Array<SQL | undefined> = [
      eq(laneAConversations.companyId, companyId),
      eq(laneAConversations.agentId, agentId),
      visibilityCondition(viewer),
    ];
    if (filters.userId) conditions.push(eq(laneAConversations.requestedByUserId, filters.userId));
    if (filters.from) conditions.push(sql`${laneAConversations.lastMessageAt} >= ${filters.from.toISOString()}`);
    if (filters.to) conditions.push(lt(laneAConversations.createdAt, filters.to));

    const viewerIsOwnerOf = viewer.userId
      ? sql`${laneAConversations.requestedByUserId} = ${viewer.userId}`
      : sql`false`;
    // A private chat's contents never answer a filter, for anyone but its owner.
    const contentReadable = sql`(${viewerIsOwnerOf} or not ${privateExpr})`;

    if (filters.hasHandoffs) {
      conditions.push(sql`exists (
        select 1 from ${laneAMessages} m
        where m.conversation_id = ${laneAConversations.id}
          and m.tool_calls @> ${JSON.stringify([{ tool: HANDOFF_TOOL, ok: true }])}::jsonb
      )`);
      conditions.push(contentReadable);
    }
    const q = filters.q?.trim();
    if (q) {
      if (q.length < CONVERSATION_LOG_SEARCH_MIN_LENGTH || q.length > CONVERSATION_LOG_SEARCH_MAX_LENGTH) {
        throw badRequest(
          `Search for ${CONVERSATION_LOG_SEARCH_MIN_LENGTH} to ${CONVERSATION_LOG_SEARCH_MAX_LENGTH} characters.`,
        );
      }
      const pattern = `%${escapeLike(q)}%`;
      conditions.push(sql`exists (
        select 1 from ${laneAMessages} m
        where m.conversation_id = ${laneAConversations.id}
          and m.role in ('user', 'assistant')
          and m.content ilike ${pattern}
      )`);
      conditions.push(contentReadable);
    }
    if (params.cursor) {
      const { at, id } = decodeConversationCursor(params.cursor);
      conditions.push(
        or(
          lt(laneAConversations.lastMessageAt, at),
          and(eq(laneAConversations.lastMessageAt, at), lt(laneAConversations.id, id)),
        ),
      );
    }

    const heads = await db
      .select({
        id: laneAConversations.id,
        requestedByUserId: laneAConversations.requestedByUserId,
        requestedByAgentId: laneAConversations.requestedByAgentId,
        createdAt: laneAConversations.createdAt,
        lastMessageAt: laneAConversations.lastMessageAt,
        isPrivate: privateExpr,
      })
      .from(laneAConversations)
      .where(and(...conditions))
      .orderBy(desc(laneAConversations.lastMessageAt), desc(laneAConversations.id))
      .limit(limit + 1);

    const page = heads.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = heads.length > limit && last ? encodeConversationCursor(last.lastMessageAt, last.id) : null;

    let people: ConversationLogPerson[] = [];
    if (viewer.canSeeAll) {
      const requesters = await db
        .selectDistinct({ userId: laneAConversations.requestedByUserId })
        .from(laneAConversations)
        .where(
          and(
            eq(laneAConversations.companyId, companyId),
            eq(laneAConversations.agentId, agentId),
            isNotNull(laneAConversations.requestedByUserId),
          ),
        )
        .limit(500);
      const userIds = requesters.map((row) => row.userId).filter((id): id is string => Boolean(id));
      const names = await namesFor(userIds, []);
      people = userIds
        .map((id) => ({ kind: "user" as const, id, name: names.users.get(id) ?? "Unknown person" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      conversations: await buildRows(
        page.map((row) => ({ ...row, isPrivate: Boolean(row.isPrivate) })),
        viewer,
      ),
      nextCursor,
      people,
      canSeeAll: viewer.canSeeAll,
    };
  }

  async function getTranscript(params: {
    companyId: string;
    agentId: string;
    conversationId: string;
    viewer: ConversationLogViewer;
  }): Promise<ConversationLogTranscript> {
    const { companyId, agentId, conversationId, viewer } = params;
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw notFound("Conversation not found");
    const [head] = await db
      .select({
        id: laneAConversations.id,
        requestedByUserId: laneAConversations.requestedByUserId,
        requestedByAgentId: laneAConversations.requestedByAgentId,
        createdAt: laneAConversations.createdAt,
        lastMessageAt: laneAConversations.lastMessageAt,
        isPrivate: privateExpr,
      })
      .from(laneAConversations)
      .where(
        and(
          eq(laneAConversations.id, conversationId),
          eq(laneAConversations.companyId, companyId),
          eq(laneAConversations.agentId, agentId),
          visibilityCondition(viewer),
        ),
      );
    // Someone else's conversation looks the same as no conversation to a member.
    if (!head) throw notFound("Conversation not found");

    const [row] = await buildRows([{ ...head, isPrivate: Boolean(head.isPrivate) }], viewer);
    if (row!.private) {
      throw forbidden(
        `This is ${row!.person?.name ?? "an employee"}'s private chat. An owner or admin can only read it through ` +
          "emergency access, which asks for a reason and is logged.",
        { code: "LANE_A_CONVERSATION_PRIVATE" },
      );
    }

    const rows = await db
      .select()
      .from(laneAMessages)
      .where(and(eq(laneAMessages.conversationId, head.id), eq(laneAMessages.companyId, companyId)))
      .orderBy(asc(laneAMessages.createdAt), asc(laneAMessages.id));
    const recap = rows.find((message) => message.role === LANE_A_RECAP_ROLE);
    const recapSummary = recap
      ? ((recap.toolCalls ?? []).find((call) => call?.tool === LANE_A_RECAP_SUMMARY_TOOL)?.summary ?? "")
      : null;

    return {
      conversation: row!,
      continuedFrom: recapSummary === null ? null : maskSecretLikeText(recapSummary),
      messages: rows
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          id: message.id,
          role: message.role as "user" | "assistant",
          content: maskSecretLikeText(message.content),
          createdAt: message.createdAt.toISOString(),
          actions: (Array.isArray(message.toolCalls) ? message.toolCalls : [])
            .filter((call): call is LaneAStoredToolCall => Boolean(call) && typeof call.tool === "string")
            .map((call) => ({
              tool: call.tool,
              label: describeToolCall(call),
              summary: maskSecretLikeText(typeof call.summary === "string" ? call.summary : ""),
              ok: Boolean(call.ok),
              image:
                call.image && typeof call.image.contentPath === "string" && call.image.contentPath.startsWith("/")
                  ? { contentPath: call.image.contentPath, contentType: call.image.contentType }
                  : null,
              task: call.task
                ? {
                    issueId: call.task.issueId,
                    identifier: call.task.identifier ?? null,
                    title: maskSecretLikeText(call.task.title ?? ""),
                  }
                : null,
            })),
        })),
    };
  }

  return { listConversations, getTranscript };
}
