import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { LANE_A_SETUP_CHECK_MIN_INTERVAL_MS, laneATransformSchema, sendLaneAMessageSchema } from "@paperclipai/shared";
import { badRequest, notFound, tooManyRequests, unauthorized } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyOwnerOrAdmin } from "./model-directory.js";
import { validate } from "../middleware/validate.js";
import { agentService, laneAService, secretService } from "../services/index.js";
import {
  HuggingFaceError,
  filterHuggingFaceModels,
  getHuggingFaceCatalogue,
  type HuggingFaceFetch,
} from "../services/huggingface-catalogue.js";
import { HttpError } from "../errors.js";
import type { LaneAServiceOptions } from "../services/lane-a.js";
import { LANE_A_CONTINUE_SPEC_MAX_LENGTH } from "../services/lane-a-continue.js";
import { redactKnownLeakedSecretPatterns, redactSensitiveText } from "../redaction.js";
import { assertBoard, assertCompanyAccess, assertServiceOrBoard, getActorInfo } from "./authz.js";
import {
  CONVERSATION_LOG_DEFAULT_LIMIT,
  CONVERSATION_LOG_MAX_LIMIT,
  CONVERSATION_LOG_SEARCH_MAX_LENGTH,
  laneAConversationLogService,
  type ConversationLogViewer,
} from "../services/lane-a-conversation-log.js";

/**
 * Lane A routes (DUR-217): `POST /api/lane-a/:agentId/messages`, a direct
 * Anthropic Messages API call scoped to a single opted-in agent persona. No
 * agent runtime, no filesystem, no CLI subprocess — contrast `board-chat.ts`,
 * which spawns a full `claude` CLI subprocess and is therefore restricted to
 * the local-trusted single-operator deployment mode. Lane A is a safe
 * multi-tenant primitive by construction: it can only read the prompt +
 * optional caller-supplied context, call a small allow-list of built-in
 * actions (hand work to a colleague, weather, task lookup — see
 * services/lane-a-tools.ts) plus the agent's own Tools-library grants through
 * a capped synchronous tool-use loop (at most `LANE_A_MAX_TOOL_CALLS` tool
 * calls per message, no approval card), and write text back. Quick agents
 * (round 2) also remember earlier turns of the same conversation.
 */
const conversationQuerySchema = z.object({ companyId: z.string().uuid() });
/** Continue an earlier conversation: the company and, optionally, what to continue ("last 45 minutes", "our meeting today"). */
const continueConversationSchema = z
  .object({
    companyId: z.string().uuid(),
    spec: z.string().trim().max(LANE_A_CONTINUE_SPEC_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * Which company a transform call acts for. For a service token this is the
 * company the token was issued to, read off the stored row — it is the one
 * fact the caller cannot influence. A board user has no token, so they say
 * which of their own companies they mean with ?companyId=, and
 * assertCompanyAccess then checks they actually have access to it.
 */
function resolveTransformCompanyId(req: Parameters<typeof getActorInfo>[0]): string {
  if (req.actor.type === "service") {
    if (!req.actor.companyId) throw unauthorized("Service token is not bound to a company");
    return req.actor.companyId;
  }
  const parsed = conversationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest("companyId is required when calling this as a board user");
  }
  return parsed.data.companyId;
}

/**
 * The Conversations review list's query. Dates are YYYY-MM-DD (UTC days):
 * `from` keeps conversations still active on or after that day, `to` those
 * started on or before it.
 */
const conversationLogQuerySchema = z.object({
  userId: z.string().trim().min(1).max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasHandoffs: z.enum(["true", "false"]).optional(),
  q: z.string().max(CONVERSATION_LOG_SEARCH_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(CONVERSATION_LOG_MAX_LIMIT).optional(),
  cursor: z.string().max(200).optional(),
});

function utcDay(value: string, plusDays = 0): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw badRequest("Invalid date");
  return new Date(date.getTime() + plusDays * 24 * 60 * 60 * 1000);
}

/** "Check this setup": which model to check (the main one, or one saved backup by id). */
const setupCheckSchema = z
  .object({
    companyId: z.string().uuid(),
    target: z.union([z.literal("main"), z.object({ backupId: z.string().trim().min(1).max(100) }).strict()]),
  })
  .strict();

export function laneARoutes(db: Db, options: { laneA?: LaneAServiceOptions; huggingFaceFetch?: HuggingFaceFetch } = {}) {
  const router = Router();
  const agents = agentService(db);
  const laneA = laneAService(db, options.laneA);
  const conversationLog = laneAConversationLogService(db);

  function requesterFor(req: Parameters<typeof getActorInfo>[0]) {
    const actor = getActorInfo(req);
    return actor.actorType === "agent"
      ? { userId: null, agentId: actor.agentId }
      : { userId: actor.actorId, agentId: null };
  }

  /**
   * DUR-4447: the Hugging Face model list for the picker. Board-only and
   * company-scoped: it is fetched with the company's own stored token (never
   * returned, never logged) and cached in-process for about an hour. Shape per
   * model: providers[] of {provider, status, supportsTools,
   * supportsStructuredOutput, contextLength, inputUsdPerMillion,
   * outputUsdPerMillion, firstTokenLatencyMs, throughput}. ?toolsOnly=true
   * keeps only tool-capable hosts; ?liveOnly=true only live ones.
   */
  router.get("/companies/:companyId/lane-a/huggingface/models", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const token = await secretService(db).resolveHuggingFaceToken(companyId, {
      consumerType: "system",
      consumerId: "huggingface-model-list",
    });
    if (!token) {
      throw new HttpError(409, "Add a Hugging Face token under Connections first.", { code: "huggingface_token_missing" });
    }
    try {
      const models = await getHuggingFaceCatalogue(token, options.huggingFaceFetch ? { fetchImpl: options.huggingFaceFetch } : {});
      res.json({
        models: filterHuggingFaceModels(models, {
          toolsOnly: req.query.toolsOnly === "true",
          liveOnly: req.query.liveOnly === "true",
        }),
      });
    } catch (err) {
      if (err instanceof HuggingFaceError) {
        throw new HttpError(err.reason === "rejected" ? 422 : 503, err.message, {
          code: err.reason === "rejected" ? "huggingface_token_rejected" : "huggingface_unreachable",
        });
      }
      throw err;
    }
  });

  router.post("/lane-a/:agentId/messages", validate(sendLaneAMessageSchema), async (req, res) => {
    const targetAgentId = req.params.agentId as string;
    const { companyId, message, context, conversationId } = req.body as {
      companyId: string;
      message: string;
      context?: string;
      conversationId?: string;
    };

    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.sendMessage({
      companyId,
      targetAgent: {
        id: targetAgent.id,
        companyId: targetAgent.companyId,
        name: targetAgent.name,
        role: targetAgent.role,
        laneAEnabled: targetAgent.laneAEnabled,
        laneAInstructions: targetAgent.laneAInstructions ?? null,
        mcpToolIds: (targetAgent.mcpToolIds as string[] | null) ?? [],
        // DUR-3977: the per-agent model and output ceiling have to reach the
        // chat path too. `sendMessage` calls resolveLaneASettings and comments
        // that chat runs on the same model as batch — but it only got what
        // this object carries, so omitting these two silently fell back to the
        // platform default. An operator who picks "Fast and cheap" would have
        // got haiku in batch and sonnet in chat, billed at two different rates
        // for the same agent.
        laneAModel: targetAgent.laneAModel ?? null,
        laneAMaxOutputTokens: targetAgent.laneAMaxOutputTokens ?? null,
        // DUR-3997: which provider answers, and where for OpenRouter / local.
        // The key binding itself is read off the agent row by the service.
        laneAProvider: targetAgent.laneAProvider ?? null,
        laneABaseUrl: targetAgent.laneABaseUrl ?? null,
        // "Creativity" (sampling temperature); null = the model host's default.
        laneATemperature: targetAgent.laneATemperature ?? null,
        // "Thinking" (on / off / model default); null = model default.
        laneAThinking: (targetAgent.laneAThinking as "on" | "off" | null) ?? null,
        // DUR-4070: who besides the company owner may chat with this agent.
        laneAAssignedUserIds: (targetAgent.laneAAssignedUserIds as string[] | null) ?? [],
        // OpenRouter "model hosts"; null = OpenRouter picks.
        laneAProviderRouting: targetAgent.laneAProviderRouting ?? null,
      },
      requester: requesterFor(req),
      actor: req.actor,
      message,
      context,
      conversationId,
    });

    res.json(result);
  });

  /**
   * DUR-3977: the stateless transform call. One product field in, one text
   * out, for a batch caller (Nordstrand's dashboard) rather than a person in
   * a chat panel.
   *
   * Company scoping, in the order it happens:
   *   1. assertServiceOrBoard — a per-company service token, or the operator
   *      themselves. An agent key is refused here: an agent must not be able
   *      to drive this lane.
   *   2. The company is READ OFF the credential (`req.actor.companyId` for a
   *      service token), never taken from the body. There is no companyId
   *      field on this request to spoof.
   *   3. The named agent is loaded and its own `companyId` is compared with
   *      that company. A token for company A naming an agent of company B
   *      gets the same 404 it would get for an agent that does not exist —
   *      the caller learns nothing about the other company's agents.
   */
  router.post("/lane-a/:agentId/transform", validate(laneATransformSchema), async (req, res) => {
    assertServiceOrBoard(req, "lane_a:transform");
    const targetAgentId = req.params.agentId as string;
    const { input, variables, maxOutputChars } = req.body as {
      input: string;
      variables?: Record<string, string | number | boolean | null>;
      maxOutputChars?: number;
    };

    const companyId = resolveTransformCompanyId(req);
    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.transform({
      companyId,
      targetAgent: {
        id: targetAgent.id,
        companyId: targetAgent.companyId,
        name: targetAgent.name,
        role: targetAgent.role,
        laneAEnabled: targetAgent.laneAEnabled,
        laneAInstructions: targetAgent.laneAInstructions ?? null,
        // So the service can refuse a paused agent instead of spending on its
        // behalf — see the pause checks at the top of `transform`.
        status: targetAgent.status ?? null,
        laneAModel: targetAgent.laneAModel ?? null,
        laneAMaxOutputTokens: targetAgent.laneAMaxOutputTokens ?? null,
        laneATransformDailyCallCap: targetAgent.laneATransformDailyCallCap ?? null,
        // DUR-3997: same two fields the chat route passes.
        laneAProvider: targetAgent.laneAProvider ?? null,
        laneABaseUrl: targetAgent.laneABaseUrl ?? null,
        // "Creativity" (sampling temperature); null = the model host's default.
        laneATemperature: targetAgent.laneATemperature ?? null,
        // "Thinking" (on / off / model default); null = model default.
        laneAThinking: (targetAgent.laneAThinking as "on" | "off" | null) ?? null,
        // OpenRouter "model hosts"; null = OpenRouter picks.
        laneAProviderRouting: targetAgent.laneAProviderRouting ?? null,
      },
      input,
      variables,
      maxOutputChars,
    });

    res.json(result);
  });

  /**
   * DUR-3977 addendum: agent discovery, so the caller does not hardcode UUIDs.
   *
   * Registered BEFORE `/lane-a/:agentId/...` would be a real concern if any of
   * those were GETs on a bare `/lane-a/:agentId` — they are not (`/messages`,
   * `/transform`, `/conversations/...` all have a further segment), so
   * `/lane-a/agents` cannot be shadowed. It is still declared here, next to
   * the transform route it belongs with, rather than at the end.
   *
   * Scoping is byte-for-byte the transform route's: the same
   * `assertServiceOrBoard` with the same scope, the same
   * `resolveTransformCompanyId` (company off the credential, never off the
   * request), the same `assertCompanyAccess`. There is no agentId in the path
   * and no companyId a service token can influence, so there is no shape in
   * which this answers with another company's agents.
   */
  router.get("/lane-a/agents", async (req, res) => {
    assertServiceOrBoard(req, "lane_a:transform");
    const companyId = resolveTransformCompanyId(req);
    assertCompanyAccess(req, companyId);

    const result = await laneA.listTransformAgents(companyId);
    res.json(result);
  });

  /**
   * Continue an earlier conversation (Telegram `/cont`, the chat panel's
   * "Continue earlier conversation…"): starts a new conversation that carries
   * the relevant part of this person's recent chat with this quick agent.
   * Board users only; the service reads only the caller's own conversations
   * with this agent in this company (services/lane-a-continue.ts).
   */
  router.post("/lane-a/:agentId/continue", validate(continueConversationSchema), async (req, res) => {
    assertBoard(req);
    const targetAgentId = req.params.agentId as string;
    const { companyId, spec } = req.body as { companyId: string; spec?: string };
    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.continueConversation({
      companyId,
      targetAgent: {
        id: targetAgent.id,
        companyId: targetAgent.companyId,
        name: targetAgent.name,
        role: targetAgent.role,
        laneAEnabled: targetAgent.laneAEnabled,
        laneAModel: targetAgent.laneAModel ?? null,
        laneAMaxOutputTokens: targetAgent.laneAMaxOutputTokens ?? null,
        laneAProvider: targetAgent.laneAProvider ?? null,
        laneABaseUrl: targetAgent.laneABaseUrl ?? null,
        // DUR-4070: who besides the company owner may chat with this agent.
        laneAAssignedUserIds: (targetAgent.laneAAssignedUserIds as string[] | null) ?? [],
      },
      requester: requesterFor(req),
      actor: req.actor,
      spec: spec ?? null,
    });
    // Same scrub the chat router gives a reply: the recap can quote earlier answers.
    res.json({ ...result, recap: redactKnownLeakedSecretPatterns(redactSensitiveText(result.recap)) });
  });

  /**
   * "Check this setup": one real, tiny model call through exactly the path a
   * chat turn would take for the agent's main model or one saved backup, with
   * one harmless test tool. Board only, the company's owner or admin only (it
   * costs a little), at most one per agent every ten seconds. The cost is
   * recorded; no conversation is stored. Answers 200 with plain-English steps
   * whatever the model did; 404 for an unknown agent or backup.
   */
  const lastSetupCheckAt = new Map<string, number>();
  router.post("/agents/:agentId/lane-a/check", validate(setupCheckSchema), async (req, res) => {
    assertBoard(req);
    const targetAgentId = req.params.agentId as string;
    const { companyId, target } = req.body as z.infer<typeof setupCheckSchema>;
    assertCompanyOwnerOrAdmin(req, companyId, "check a quick agent's model");
    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const now = Date.now();
    const last = lastSetupCheckAt.get(targetAgentId);
    if (last !== undefined && now - last < LANE_A_SETUP_CHECK_MIN_INTERVAL_MS) {
      const wait = Math.ceil((LANE_A_SETUP_CHECK_MIN_INTERVAL_MS - (now - last)) / 1000);
      throw tooManyRequests(`Please wait ${wait} second${wait === 1 ? "" : "s"} before checking this agent again.`, {
        code: "LANE_A_SETUP_CHECK_TOO_SOON",
        retryAfterSeconds: wait,
      });
    }
    lastSetupCheckAt.set(targetAgentId, now);
    const result = await laneA.checkSetup({ companyId, agentId: targetAgentId, target, actor: req.actor });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.lane_a_setup_checked",
      entityType: "agent",
      entityId: targetAgentId,
      details: {
        target: target === "main" ? "main" : `backup:${target.backupId}`,
        provider: result.provider,
        model: result.model,
        ok: result.ok,
        toolCalling: result.toolCalling,
        costCents: result.costCents,
      },
    });
    res.json(result);
  });

  /** Telegram `/looks`: the saved looks, from the quick agent's ticked "List saved looks" tool. Board users only. */
  router.get("/lane-a/:agentId/looks", async (req, res) => {
    assertBoard(req);
    const targetAgentId = req.params.agentId as string;
    const parsedQuery = conversationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    const { companyId } = parsedQuery.data;
    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.listLooks({
      companyId,
      targetAgent: {
        id: targetAgent.id,
        name: targetAgent.name,
        laneAEnabled: targetAgent.laneAEnabled,
        // DUR-4070: who besides the company owner may chat with this agent.
        laneAAssignedUserIds: (targetAgent.laneAAssignedUserIds as string[] | null) ?? [],
      },
      requester: requesterFor(req),
      actor: req.actor,
    });
    res.json(result);
  });

  router.get("/lane-a/:agentId/conversations/:conversationId", async (req, res) => {
    const targetAgentId = req.params.agentId as string;
    const conversationId = req.params.conversationId as string;
    const parsedQuery = conversationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    const { companyId } = parsedQuery.data;
    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.getConversation({
      companyId,
      targetAgentId: targetAgent.id,
      conversationId,
      requester: requesterFor(req),
      // DUR-4070: same "assigned people + owner" rule as the chat routes —
      // reading an earlier conversation is otherwise a second way to reach
      // an agent's answers without ever being allowed to talk to it.
      targetAgent: {
        name: targetAgent.name,
        laneAAssignedUserIds: (targetAgent.laneAAssignedUserIds as string[] | null) ?? [],
      },
      actor: req.actor,
    });
    res.json(result);
  });

  /**
   * Conversations review (Lane A gap): what a quick agent told people.
   * Board users only -- an agent key, a delegate token or a service token is
   * refused. Owners and admins (and the local board / instance admins) see
   * every conversation of this company's quick agent; everyone else only
   * their own. An Employee (light) member's chat shows as a private row with
   * no content (DUR-4094: owners read those only through emergency access).
   * An agent of another company, or a conversation of another agent, is a
   * 404. Read-only: deleting and retention are a later slice.
   */
  async function conversationLogTarget(req: Parameters<typeof getActorInfo>[0]) {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!z.string().uuid().safeParse(companyId).success) throw notFound("Company not found");
    const agentId = req.params.agentId as string;
    if (!z.string().uuid().safeParse(agentId).success) throw notFound("Agent not found");
    const targetAgent = await agents.getById(agentId);
    if (!targetAgent || targetAgent.companyId !== companyId) throw notFound("Agent not found");
    let canSeeAll = req.actor.source === "local_implicit" || Boolean(req.actor.isInstanceAdmin);
    if (!canSeeAll) {
      const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
      canSeeAll =
        membership?.status === "active" && (membership.membershipRole === "owner" || membership.membershipRole === "admin");
    }
    const viewer: ConversationLogViewer = { userId: req.actor.userId ?? null, canSeeAll };
    return { companyId, agentId: targetAgent.id, viewer };
  }

  router.get("/companies/:companyId/lane-a/agents/:agentId/conversations", async (req, res) => {
    const { companyId, agentId, viewer } = await conversationLogTarget(req);
    const parsed = conversationLogQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid conversation filters", parsed.error.flatten());
    const query = parsed.data;
    const result = await conversationLog.listConversations({
      companyId,
      agentId,
      viewer,
      filters: {
        userId: query.userId,
        from: query.from ? utcDay(query.from) : undefined,
        to: query.to ? utcDay(query.to, 1) : undefined,
        hasHandoffs: query.hasHandoffs === "true",
        q: query.q,
      },
      limit: query.limit ?? CONVERSATION_LOG_DEFAULT_LIMIT,
      cursor: query.cursor ?? null,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/lane-a/agents/:agentId/conversations/:conversationId", async (req, res) => {
    const { companyId, agentId, viewer } = await conversationLogTarget(req);
    const result = await conversationLog.getTranscript({
      companyId,
      agentId,
      conversationId: req.params.conversationId as string,
      viewer,
    });
    res.json(result);
  });

  return router;
}
