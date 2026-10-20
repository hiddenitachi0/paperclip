import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import {
  BOARD_CHAT_SAFE_METHODS,
  checkBoardChatPath,
  describeBoardChatWrite,
  stableStringify,
} from "../services/board-chat-policy.js";
import { boardChatEvents, boardChatRunEventName, boardChatService } from "../services/board-chat.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "./logger.js";

/**
 * Board chat guard (signed-in servers). Mounted app-wide right after the
 * actor middleware, so it sees every request a Board chat credential makes
 * before any route does.
 *
 *   * A run credential ("board_chat") may READ the ordinary company API of its
 *     one company. Every WRITE it sends is held: stored as a pending change,
 *     shown to the person as a card in the chat, and answered with 202 — the
 *     route never runs. Writes outside the short allowed list, and every
 *     attempt to decide a deploy or merge card, are refused outright.
 *   * The single-use Approve credential ("board_chat_confirmed") may send
 *     exactly the one request it was minted for — same method, same address,
 *     same body — and nothing else.
 *
 * Everyone else passes straight through untouched.
 */

function requestBody(req: Request): unknown {
  return req.body === undefined ? null : req.body;
}

function isJsonOrEmpty(req: Request): boolean {
  const type = req.header("content-type");
  if (!type) return true;
  return /^application\/json\b/i.test(type);
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
    if (!companyId || !userId) {
      res.status(403).json({ error: "This Board chat credential is not valid.", code: "BOARD_CHAT_NOT_ALLOWED" });
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
          action!.method === method &&
          action!.path === url &&
          stableStringify(requestBody(req)) === stableStringify(action!.bodyJson === null ? null : JSON.parse(action!.bodyJson)) &&
          checkBoardChatPath(method, url, companyId).allowed;
        if (!matches) {
          logger.error(
            { event: "security.board_chat_replay_mismatch", actionId: req.actor.boardChatActionId, method, url },
            "Refused a Board chat Approve credential used for a different request than the one approved",
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
      if (!isJsonOrEmpty(req)) {
        res.status(415).json({ error: "Board chat can only send plain changes, not files.", code: "BOARD_CHAT_NOT_ALLOWED" });
        return;
      }
      const body = requestBody(req);
      const decision = await describeBoardChatWrite({
        method,
        path: url,
        body,
        companyId,
        lookup: svc.policyLookup,
      });
      if (!decision.allowed) {
        res.status(403).json({ error: decision.message, code: decision.code });
        return;
      }
      const runId = req.actor.boardChatRunId ?? null;
      const run = runId ? await svc.getRun(runId) : null;
      const action = await svc.createAction({
        companyId,
        runId,
        issueId: run?.issueId ?? null,
        userId,
        method,
        path: url,
        bodyJson: body === null ? null : JSON.stringify(body),
        summary: decision.summary,
        details: decision.details,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "board_chat.action_requested",
        entityType: "board_chat_action",
        entityId: action.id,
        details: { summary: action.summary, boardChatRunId: runId, method, path: url },
      });
      if (runId) boardChatEvents.emit(boardChatRunEventName(runId), action);
      res.status(202).json({
        held: true,
        pendingActionId: action.id,
        summary: action.summary,
        message:
          "Nothing has been changed yet. This change is now waiting as a card in the chat for the person to approve or cancel. " +
          "Tell them in one or two plain sentences what you prepared and why, then stop. Do not send it again.",
      });
    })().catch((err) => {
      if (!res.headersSent) next(err);
      else logger.error({ err }, "board chat guard failed after responding");
    });
  };
}
