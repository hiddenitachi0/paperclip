import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import type { BoardChatAction } from "@paperclipai/shared";
import {
  BOARD_CHAT_SAFE_METHODS,
  checkBoardChatPath,
  describeBoardChatWrite,
  stableStringify,
} from "../services/board-chat-policy.js";
import { boardChatEvents, boardChatRunEventName, boardChatService, type BoardChatService } from "../services/board-chat.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "./logger.js";

/**
 * Board chat guard (signed-in servers). Mounted app-wide right after the
 * actor middleware. Only requests the Board chat itself makes in-process
 * (services/board-chat-dispatch.ts) can carry the two Board chat sources;
 * a network request never can.
 *
 *   * "board_chat" (the run's reading tools): may READ the ordinary API of
 *     its one company, lower-case addresses only. Any write that reaches
 *     here is held as a card instead of being made (the tools hold changes
 *     themselves; this is the second wall).
 *   * "board_chat_confirmed" (the change the person approved): may send
 *     exactly the one held request -- same method, address and body.
 *
 * Everyone else passes straight through untouched.
 */

/**
 * Check a change against the policy and, if it may be held, store it as a
 * pending card, log it under the person, and show it in the open chat.
 */
export async function holdBoardChatChange(
  db: Db,
  svc: BoardChatService,
  input: {
    companyId: string;
    userId: string;
    runId: string | null;
    issueId: string | null;
    method: string;
    path: string;
    body: unknown;
  },
): Promise<{ held: true; action: BoardChatAction } | { held: false; message: string; code: string }> {
  const decision = await describeBoardChatWrite({
    method: input.method,
    path: input.path,
    body: input.body,
    companyId: input.companyId,
    lookup: svc.policyLookup,
  });
  if (!decision.allowed) return { held: false, message: decision.message, code: decision.code };
  const action = await svc.createAction({
    companyId: input.companyId,
    runId: input.runId,
    issueId: input.issueId,
    userId: input.userId,
    method: input.method.toUpperCase(),
    path: input.path,
    bodyJson: input.body === null || input.body === undefined ? null : JSON.stringify(input.body),
    summary: decision.summary,
    details: decision.details,
  });
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: input.userId,
    action: "board_chat.action_requested",
    entityType: "board_chat_action",
    entityId: action.id,
    details: { summary: action.summary, boardChatRunId: input.runId, method: input.method.toUpperCase(), path: input.path },
  });
  if (input.runId) boardChatEvents.emit(boardChatRunEventName(input.runId), action);
  return { held: true, action };
}

function requestBody(req: Request): unknown {
  return req.body === undefined ? null : req.body;
}

export function boardChatGuard(db: Db): RequestHandler {
  const svc = boardChatService(db);
  return (req, res, next) => {
    const source = req.actor?.source;
    if (source !== "board_chat" && source !== "board_chat_confirmed") {
      next();
      return;
    }
    const companyId = req.actor.companyIds?.[0];
    const userId = req.actor.userId;
    if (!companyId || !userId || req.actor.companyIds?.length !== 1) {
      res.status(403).json({ error: "This Board chat request is not valid.", code: "BOARD_CHAT_NOT_ALLOWED" });
      return;
    }
    const method = req.method.toUpperCase();
    const url = req.originalUrl ?? req.url;

    void (async () => {
      if (source === "board_chat_confirmed") {
        const action = req.boardChatAction;
        const matches =
          Boolean(action) &&
          action!.id === req.actor.boardChatActionId &&
          action!.companyId === companyId &&
          action!.userId === userId &&
          action!.method === method &&
          action!.path === url &&
          stableStringify(requestBody(req)) === stableStringify(action!.bodyJson === null ? null : JSON.parse(action!.bodyJson)) &&
          checkBoardChatPath(method, url, companyId).allowed;
        if (!matches) {
          logger.error(
            { event: "security.board_chat_replay_mismatch", actionId: req.actor.boardChatActionId, method, url },
            "Refused an approved Board chat change used for a different request than the one approved",
          );
          res.status(403).json({ error: "This approval only allows the exact change that was approved.", code: "BOARD_CHAT_REPLAY_MISMATCH" });
          return;
        }
        next();
        return;
      }

      const pathDecision = checkBoardChatPath(method, url, companyId);
      if (!pathDecision.allowed) {
        res.status(403).json({ error: pathDecision.message, code: pathDecision.code });
        return;
      }
      if (BOARD_CHAT_SAFE_METHODS.has(method)) {
        next();
        return;
      }
      const runId = req.actor.boardChatRunId ?? null;
      const run = runId ? await svc.getRun(runId) : null;
      const result = await holdBoardChatChange(db, svc, {
        companyId,
        userId,
        runId,
        issueId: run?.issueId ?? null,
        method,
        path: url,
        body: requestBody(req),
      });
      if (!result.held) {
        res.status(403).json({ error: result.message, code: result.code });
        return;
      }
      res.status(202).json({ held: true, pendingActionId: result.action.id, summary: result.action.summary });
    })().catch((err) => {
      if (!res.headersSent) next(err);
      else logger.error({ err }, "board chat guard failed after responding");
    });
  };
}
