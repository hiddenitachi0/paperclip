import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { redactKnownLeakedSecretPatterns, redactSensitiveText } from "../redaction.js";
import { accessService, issueService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * DUR-3978: "what did the agent answer?" for a handful of tasks at once.
 *
 * The Telegram bridge turns a chat message into a task and, once that task
 * is finished or waiting for the operator, posts the agent's answer back into
 * the same chat. It polls every few seconds from outside the container, so it
 * asks about all of one company's open chat tasks in a single call rather
 * than one call per task.
 *
 * Company scoping:
 *   - the company is the path parameter, checked by assertCompanyAccess before
 *     company scope is established (companyScopeFromParam);
 *   - an id that belongs to another company is left out of the answer exactly
 *     like an id that does not exist, so a caller learns nothing about it;
 *   - each issue still passes the same issue:read decision GET /issues/:id
 *     makes, so this route can never show more than the issue page would.
 *
 * The answer text goes out through the same secret redaction the server uses
 * for run logs, because it is about to leave Paperclip for a chat app.
 */

export const ISSUE_ANSWERS_MAX_IDS = 50;
/** How many of the newest comments are searched for the agent's latest answer. */
export const ISSUE_ANSWER_SCAN_COMMENT_LIMIT = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AnswerCandidate = {
  authorType: string;
  body: string;
  createdAt: string | Date;
  deletedAt?: string | Date | null;
  presentation?: { kind?: string | null } | null;
};

/**
 * The newest comment an agent wrote that is a real message: not deleted and
 * not presented as a system notice. The server's own notices (for example the
 * "this issue still needs a next step" banner) are stored as authorType
 * "system" and so are already excluded by the author check; the presentation
 * check is a second guard so a notice is never relayed as an answer whoever it
 * is attributed to. Same rule as the simple-mode page's
 * findLatestSimpleModeReply, plus that guard.
 */
export function pickLatestAgentAnswer<T extends AnswerCandidate>(comments: T[] | null | undefined): T | null {
  if (!comments || comments.length === 0) return null;
  const replies = comments
    .filter((c) => c.authorType === "agent" && !c.deletedAt && c.presentation?.kind !== "system_notice")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return replies[0] ?? null;
}

/** Secret redaction for text that is about to leave Paperclip. */
export function redactAnswerText(text: string): string {
  return redactKnownLeakedSecretPatterns(redactSensitiveText(text));
}

function parseIssueIds(raw: unknown): string[] {
  const joined = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "";
  const ids = [
    ...new Set(
      joined
        .split(",")
        .map((part) => part.trim())
        .filter((part) => UUID_RE.test(part))
        .map((part) => part.toLowerCase()),
    ),
  ];
  if (ids.length === 0) throw badRequest("ids must list one or more task ids (UUIDs), comma-separated");
  if (ids.length > ISSUE_ANSWERS_MAX_IDS) {
    throw badRequest(`At most ${ISSUE_ANSWERS_MAX_IDS} task ids per call`);
  }
  return ids;
}

export function issueAnswerRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const issues = issueService(db, { rawDb });
  const access = accessService(db);

  router.get(
    "/companies/:companyId/issue-answers",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ids = parseIssueIds(req.query.ids);

      const results = [];
      for (const id of ids) {
        const issue = await issues.getById(id);
        if (!issue || issue.companyId !== companyId) continue;
        const decision = await access.decide({
          actor: req.actor,
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
        if (!decision.allowed) continue;

        const comments = await issues.listComments(issue.id, {
          order: "desc",
          limit: ISSUE_ANSWER_SCAN_COMMENT_LIMIT,
        });
        const answer = pickLatestAgentAnswer(comments);
        results.push({
          id: issue.id,
          companyId: issue.companyId,
          identifier: issue.identifier ?? null,
          title: issue.title,
          status: issue.status,
          answer: answer
            ? {
                commentId: answer.id,
                authorAgentId: answer.authorAgentId ?? null,
                body: redactAnswerText(answer.body),
                createdAt: answer.createdAt,
              }
            : null,
        });
      }

      res.json({ issues: results });
    },
  );

  return router;
}
