import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
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

function classifyLane(input: { message: string; laneHint?: "a" | "b" }): "a" | "b" {
  if (input.laneHint === "a" && input.message.length <= LANE_A_MESSAGE_MAX_LENGTH) return "a";
  if (input.laneHint === "b") return "b";
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

export function chatRouterRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const laneA = laneAService(db);
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
      .map((agent) => ({ id: agent.id, name: agent.name, role: agent.role }));

    const classification = await secretaryClassifier.classify({ message, roster });
    res.json(classification);
  });

  router.post("/chat/:agentId/messages", validate(chatRouteMessageSchema), async (req, res) => {
    const targetAgentId = req.params.agentId as string;
    const { companyId, message, context, conversationId, laneHint } = req.body as {
      companyId: string;
      message: string;
      context?: string;
      conversationId?: string;
      laneHint?: "a" | "b";
    };

    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    const lane = classifyLane({ message, laneHint });

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
          laneAEnabled: targetAgent.laneAEnabled,
        },
        requester,
        message,
        context,
        conversationId,
      });

      res.json({ lane: "a", result, taskRef: null });
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

    const issue = await issues.create(companyId, {
      id: randomUUID(),
      title: buildLaneBTitle(message),
      description: message,
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
