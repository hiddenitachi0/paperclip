import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { CHAT_ATTACHMENTS_MAX, formatAgentDisplayName } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { redactKnownLeakedSecretPatterns, redactSensitiveText } from "../redaction.js";
import {
  accessService,
  agentService,
  heartbeatService,
  issueService,
  laneAService,
  logActivity,
  secretaryClassifierService,
} from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { buildResearchTaskDescription, inferResearchKind } from "../services/research-tasks.js";
import { findResearchSkillLink } from "../services/research-skill-link.js";
import type { LaneAServiceOptions } from "../services/lane-a.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Chat router (DUR-220): one endpoint the chat surface (DUR-212 simple mode,
 * NOR-194 dashboard module) calls, so the caller never has to know whether a
 * message needs the fast lane (DUR-217) or the agent lane (DUR-219). v1
 * classification is a cheap heuristic (explicit hint from the UI, else
 * message length/keywords) — model-based classification is a v2 refinement
 * per the DUR-157 plan doc's "Router v1 design" section.
 */

// Mirrors sendLaneAMessageSchema's message cap (packages/shared/src/validators/lane-a.ts)
// so an "a"-bound message never fails Lane A's own validation after classification.
const LANE_A_MESSAGE_MAX_LENGTH = 8_000;
// Mirrors laneBSubmitMessageSchema's text cap (server/src/routes/issues.ts).
const CHAT_ROUTER_MESSAGE_MAX_LENGTH = 20_000;
const CHEAP_QUESTION_LENGTH_THRESHOLD = 300;
const WORK_KEYWORDS =
  /\b(build|implement|fix|create|deploy|refactor|migrate|generate|develop|integrate|automate|configure|debug|investigate|research|write code|set up)\b/i;

const chatRouteMessageSchema = z.object({
  companyId: z.string().uuid(),
  message: z.string().trim().min(1).max(CHAT_ROUTER_MESSAGE_MAX_LENGTH),
  context: z.string().max(16_000).optional(),
  conversationId: z.string().uuid().optional(),
  laneHint: z.enum(["a", "b"]).optional(),
  // Pictures sent with the message (a Telegram photo the bridge stored in
  // the company's Files first). Lane A checks each is a picture in this
  // company; a task gets their file ids in its description.
  attachmentFileIds: z.array(z.string().uuid()).min(1).max(CHAT_ATTACHMENTS_MAX).optional(),
}).strict();

// DUR-251/DUR-335: request body for the secretary classifier step Simple
// Mode calls before send. The roster is looked up server-side from
// companyId rather than trusted from the client, so a caller cannot steer
// the classifier toward an agent it should not see.
const chatRouteClassifySchema = z.object({
  companyId: z.string().uuid(),
  message: z.string().trim().min(1).max(CHAT_ROUTER_MESSAGE_MAX_LENGTH),
}).strict();

// Mirrors ui/src/lib/simple-mode.ts's UNAVAILABLE_AGENT_STATUSES — an agent
// in one of these statuses shouldn't be offered as a routing target.
const SECRETARY_UNAVAILABLE_AGENT_STATUSES = new Set(["terminated", "paused", "error"]);

export function classifyLane(input: {
  message: string;
  laneHint?: "a" | "b";
  /** Whether the addressed agent has quick answers switched on. */
  laneAEnabled?: boolean;
  /** The message came with pictures. */
  hasAttachments?: boolean;
}): "a" | "b" {
  if (input.laneHint === "a" && input.message.length <= LANE_A_MESSAGE_MAX_LENGTH) return "a";
  if (input.laneHint === "b") return "b";
  // A picture to change ("alter this image ...") is the quick agent's picture
  // tool's job; words like "make" or "create" in its caption must not turn it
  // into a full task.
  if (input.hasAttachments && input.laneAEnabled !== false && input.message.length <= LANE_A_MESSAGE_MAX_LENGTH) return "a";
  // DUR-3978: without an explicit hint the router is guessing, and it must not
  // guess a lane the addressed agent cannot serve. Before this, a short
  // question to an agent without quick answers was sent to Lane A and refused
  // with 403 ("Lane A is not enabled") — so a caller that trusts the router
  // (the Telegram bridge; simple mode's fallback path) got an error for a
  // message the agent could have taken as a task. An explicit "a" hint is left
  // alone: that caller asked for a quick answer and should be told it can't
  // have one, not be silently billed for a full task run.
  if (input.laneAEnabled === false) return "b";
  if (input.message.length > CHEAP_QUESTION_LENGTH_THRESHOLD) return "b";
  if (WORK_KEYWORDS.test(input.message)) return "b";
  return "a";
}

// Lane B's title-building mirrors buildLaneBMessageTitle in
// server/src/routes/issues.ts (DUR-219) — duplicated rather than imported
// because that router doesn't expose a service boundary for its lane-b
// handlers. Keep in sync if that title format changes.
const LANE_B_TITLE_MAX_LENGTH = 80;
function buildLaneBTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  const source = firstLine || text;
  if (source.length <= LANE_B_TITLE_MAX_LENGTH) return source;
  return `${source.slice(0, LANE_B_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export function chatRouterRoutes(db: Db, options: { laneA?: LaneAServiceOptions } = {}) {
  const router = Router();
  const agents = agentService(db);
  const laneA = laneAService(db, options.laneA);
  const issues = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const secretaryClassifier = secretaryClassifierService();

  // DUR-251/DUR-335: cheap Lane-A-cost classification step Simple Mode calls
  // before send. Replaces the hardcoded CEO-then-first-agent default
  // (ui/src/lib/simple-mode.ts's selectSimpleModeAssignee) as the primary
  // path — that helper becomes a last-resort fallback for when this call
  // errors or the model is unreachable. Does not touch /chat/:agentId/messages'
  // own contract; the UI still calls that endpoint afterward with whatever
  // agentId/laneHint it resolves to (classifier pick or user override).
  router.post("/chat/classify", validate(chatRouteClassifySchema), async (req, res) => {
    const { companyId, message } = req.body as { companyId: string; message: string };
    assertCompanyAccess(req, companyId);

    const companyAgents = await agents.list(companyId);
    const roster = companyAgents
      .filter((agent) => !SECRETARY_UNAVAILABLE_AGENT_STATUSES.has(agent.status))
      // DUR-4000: "Sales agent 1 (Maja)", so "hand this to Maja" routes to the job.
      .map((agent) => ({ id: agent.id, name: formatAgentDisplayName(agent, agent.persona), role: agent.role }));

    const classification = await secretaryClassifier.classify({ message, roster });
    res.json(classification);
  });

  router.post("/chat/:agentId/messages", validate(chatRouteMessageSchema), async (req, res) => {
    const targetAgentId = req.params.agentId as string;
    const { companyId, message, context, conversationId, laneHint, attachmentFileIds } = req.body as {
      companyId: string;
      message: string;
      context?: string;
      conversationId?: string;
      laneHint?: "a" | "b";
      attachmentFileIds?: string[];
    };

    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    const lane = classifyLane({
      message,
      laneHint,
      laneAEnabled: targetAgent.laneAEnabled,
      hasAttachments: Boolean(attachmentFileIds?.length),
    });

    if (lane === "a") {
      const requester = actor.actorType === "agent"
        ? { userId: null, agentId: actor.agentId }
        : { userId: actor.actorId, agentId: null };

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
          // DUR-3977: same two fields the Lane A route passes. Omitting them
          // silently falls back to the platform default inside
          // resolveLaneASettings, so an operator who picks a cheaper model for
          // a quick agent would get it on one chat path and not the other.
          laneAModel: targetAgent.laneAModel ?? null,
          laneAMaxOutputTokens: targetAgent.laneAMaxOutputTokens ?? null,
          // DUR-3997: provider and endpoint; the key binding is read off the
          // agent row by the service, so it cannot be forgotten here.
          laneAProvider: targetAgent.laneAProvider ?? null,
          laneABaseUrl: targetAgent.laneABaseUrl ?? null,
          // "Creativity" (sampling temperature); null = the model host's default.
          laneATemperature: targetAgent.laneATemperature ?? null,
          // DUR-4070: who besides the company owner may chat with this agent.
          // Both the web chat box and the Telegram bridge's `chat send` go
          // through this router (see its module docstring), so omitting this
          // would silently read every assigned person here as "owner only" —
          // refusing someone the operator explicitly assigned, on the exact
          // two paths the ticket asks to cover.
          laneAAssignedUserIds: (targetAgent.laneAAssignedUserIds as string[] | null) ?? [],
          // OpenRouter "model hosts"; null = OpenRouter picks.
          laneAProviderRouting: targetAgent.laneAProviderRouting ?? null,
        },
        requester,
        actor: req.actor,
        message,
        context,
        conversationId,
        ...(attachmentFileIds?.length ? { attachmentFileIds } : {}),
      });

      // DUR-3978: a quick answer can now leave Paperclip (the Telegram bridge
      // relays it into a chat app), and a quick agent's tools can hand it text
      // it should not repeat. Same redaction the server applies to run output.
      const safeResult =
        result && typeof result.response === "string"
          ? { ...result, response: redactKnownLeakedSecretPatterns(redactSensitiveText(result.response)) }
          : result;
      res.json({ lane: "a", result: safeResult, taskRef: null });
      return;
    }

    // Lane B: mirrors POST /api/lane-b/:agentId/messages (DUR-219).
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: null,
        projectId: null,
        parentIssueId: null,
        assigneeAgentId: targetAgentId,
        assigneeUserId: null,
      },
      scope: { assigneeAgentId: targetAgentId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation);

    // A research or planning request that goes straight to a task (long, or
    // "/task" from Telegram) to a quick agent gets the same "how to do it and
    // how to deliver it" notes a quick agent's own hand-over writes, worded
    // as "if this is a research request" since the kind is only guessed.
    const researchKind = targetAgent.laneAEnabled ? inferResearchKind(message) : null;
    const briefText = researchKind
      ? buildResearchTaskDescription({
          kind: researchKind,
          brief: message,
          handedOverBy: null,
          skillLink: await findResearchSkillLink(db, companyId),
          guessed: true,
        })
      : message;
    for (const fileId of attachmentFileIds ?? []) {
      // Another company's file reads exactly like a missing one.
      const file = await issues.getAttachmentById(fileId);
      if (!file || file.companyId !== companyId) {
        res.status(422).json({ error: "An attached picture is not in this company's Files. Send it again." });
        return;
      }
    }
    const description = attachmentFileIds?.length
      ? `${briefText}\n\n---\nThe person sent ${attachmentFileIds.length === 1 ? "a picture" : `${attachmentFileIds.length} pictures`} with this message, saved in the company's Files: ${attachmentFileIds.map((id) => `file id ${id}`).join(", ")}.`
      : briefText;

    const issue = await issues.create(companyId, {
      id: randomUUID(),
      title: buildLaneBTitle(message),
      description,
      assigneeAgentId: targetAgentId,
      status: "todo",
      priority: "medium",
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        source: "chat_router",
      },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "chat_router.submit",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json({
      lane: "b",
      result: null,
      taskRef: {
        issueId: issue.id,
        identifier: issue.identifier,
        status: issue.status,
      },
    });
  });

  return router;
}
