import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  MAIL_MESSAGE_FOLDERS,
  MAIL_SEARCH_MAX_QUERY_LENGTH,
  MAIL_SEARCH_MIN_QUERY_LENGTH,
  composeMailDraftSchema,
  createMailAccountSchema,
  mailAccountEmergencyAccessSchema,
  moveMailMessageSchema,
  updateMailAccountSchema,
  updateMailDraftSchema,
  type MailMessageFolder,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { mailAccountsService, type MailAccountActor, type MailAccountServiceDeps } from "../services/mail-accounts.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * DUR-4194: per-person mail accounts -- inbox, compose, send-draft, search,
 * move, archive. See services/mail-accounts.ts for the full access-boundary
 * doc comment; this file only resolves `req.actor` into the typed
 * `MailAccountActor` the service expects and performs the one route-level
 * check the service cannot: a board-vs-agent gate on sendDraft, so an agent
 * credential can never even reach that function (defence in depth on top of
 * the service's own owner-only check).
 *
 * Every route here requires ordinary company membership
 * (assertCompanyAccess) -- there is no owner/admin-only ceiling at the route
 * layer the way mail-secretary.ts has, because the whole point of this
 * feature is that a company owner/admin does NOT get broader access to
 * someone else's mailbox than anyone else. The narrower checks
 * (config/content/send) live in the service and are keyed off the account
 * row's ownerUserId/paAgentId, not off company role.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name] as string;
  if (!UUID_RE.test(value)) throw notFound(`That ${what} was not found.`);
  return value;
}

function actorIsCompanyOwnerOrAdmin(req: Request, companyId: string): boolean {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
  const role = membership?.status === "active" ? membership.membershipRole : null;
  return role === "owner" || role === "admin";
}

function assertCompanyOwnerOrAdmin(req: Request, companyId: string): void {
  assertBoard(req);
  if (!actorIsCompanyOwnerOrAdmin(req, companyId)) {
    throw forbidden("Only a company owner or admin can do this.");
  }
}

function resolveActor(req: Request, companyId: string): MailAccountActor {
  if (req.actor.type === "agent") {
    return { type: "agent", userId: null, agentId: req.actor.agentId ?? null, isCompanyOwnerOrAdmin: false };
  }
  return {
    type: "board",
    userId: req.actor.userId ?? null,
    agentId: null,
    isCompanyOwnerOrAdmin: actorIsCompanyOwnerOrAdmin(req, companyId),
  };
}

function parseFolder(req: Request): MailMessageFolder | undefined {
  const raw = req.query.folder;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (!(MAIL_MESSAGE_FOLDERS as readonly string[]).includes(raw)) {
    throw badRequest(`folder must be one of: ${MAIL_MESSAGE_FOLDERS.join(", ")}.`);
  }
  return raw as MailMessageFolder;
}

function parseLimit(req: Request): number | undefined {
  const raw = req.query.limit;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive whole number.");
  return limit;
}

function parseQuery(req: Request): string {
  const raw = req.query.q;
  if (typeof raw !== "string" || raw.trim().length < MAIL_SEARCH_MIN_QUERY_LENGTH) {
    throw badRequest(`q must be at least ${MAIL_SEARCH_MIN_QUERY_LENGTH} characters.`);
  }
  if (raw.length > MAIL_SEARCH_MAX_QUERY_LENGTH) {
    throw badRequest(`q must be at most ${MAIL_SEARCH_MAX_QUERY_LENGTH} characters.`);
  }
  return raw;
}

export function mailAccountsRoutes(rawDb: Db, deps: MailAccountServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = mailAccountsService(db, deps);

  function memberScope() {
    return companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertBoardOrAgent(req);
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  // ─── Accounts ──────────────────────────────────────────────────────────────

  router.get("/companies/:companyId/mail-accounts", memberScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (req.query.all === "true") {
      assertCompanyOwnerOrAdmin(req, companyId);
      res.json({ accounts: await svc.listAllAccounts(companyId) });
      return;
    }
    res.json({ accounts: await svc.listMyAccounts(companyId, resolveActor(req, companyId)) });
  });

  router.get("/companies/:companyId/mail-accounts/:accountId", memberScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await svc.getAccount(companyId, idParam(req, "accountId", "mail account"), resolveActor(req, companyId)));
  });

  router.post(
    "/companies/:companyId/mail-accounts",
    memberScope(),
    validate(createMailAccountSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      res.status(201).json(await svc.createAccount(companyId, req.body, resolveActor(req, companyId)));
    },
  );

  router.patch(
    "/companies/:companyId/mail-accounts/:accountId",
    memberScope(),
    validate(updateMailAccountSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      res.json(
        await svc.updateAccount(companyId, idParam(req, "accountId", "mail account"), req.body, resolveActor(req, companyId)),
      );
    },
  );

  router.delete("/companies/:companyId/mail-accounts/:accountId", memberScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    await svc.removeAccount(companyId, idParam(req, "accountId", "mail account"), resolveActor(req, companyId));
    res.status(204).end();
  });

  // ─── Inbox / search / one message ──────────────────────────────────────────

  router.get("/companies/:companyId/mail-accounts/:accountId/messages", memberScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = idParam(req, "accountId", "mail account");
    res.json({
      messages: await svc.listMessages(companyId, accountId, resolveActor(req, companyId), {
        folder: parseFolder(req) ?? "inbox",
        limit: parseLimit(req),
      }),
    });
  });

  router.get("/companies/:companyId/mail-accounts/:accountId/search", memberScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = idParam(req, "accountId", "mail account");
    res.json({
      messages: await svc.searchMessages(companyId, accountId, resolveActor(req, companyId), {
        q: parseQuery(req),
        folder: parseFolder(req),
        limit: parseLimit(req),
      }),
    });
  });

  router.get("/companies/:companyId/mail-accounts/:accountId/messages/:messageId", memberScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = idParam(req, "accountId", "mail account");
    const messageId = idParam(req, "messageId", "message");
    res.json(await svc.getMessage(companyId, accountId, messageId, resolveActor(req, companyId)));
  });

  // ─── Move / archive ────────────────────────────────────────────────────────

  router.post(
    "/companies/:companyId/mail-accounts/:accountId/messages/:messageId/move",
    memberScope(),
    validate(moveMailMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const accountId = idParam(req, "accountId", "mail account");
      const messageId = idParam(req, "messageId", "message");
      res.json(
        await svc.moveMessage(companyId, accountId, messageId, req.body.folder, resolveActor(req, companyId)),
      );
    },
  );

  router.post(
    "/companies/:companyId/mail-accounts/:accountId/messages/:messageId/archive",
    memberScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const accountId = idParam(req, "accountId", "mail account");
      const messageId = idParam(req, "messageId", "message");
      res.json(await svc.archiveMessage(companyId, accountId, messageId, resolveActor(req, companyId)));
    },
  );

  // ─── Compose / drafts / send ───────────────────────────────────────────────

  router.post(
    "/companies/:companyId/mail-accounts/:accountId/drafts",
    memberScope(),
    validate(composeMailDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const accountId = idParam(req, "accountId", "mail account");
      res.status(201).json(await svc.createDraft(companyId, accountId, req.body, resolveActor(req, companyId)));
    },
  );

  router.patch(
    "/companies/:companyId/mail-accounts/:accountId/drafts/:draftId",
    memberScope(),
    validate(updateMailDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const accountId = idParam(req, "accountId", "mail account");
      const draftId = idParam(req, "draftId", "draft");
      res.json(await svc.updateDraft(companyId, accountId, draftId, req.body, resolveActor(req, companyId)));
    },
  );

  router.delete(
    "/companies/:companyId/mail-accounts/:accountId/drafts/:draftId",
    memberScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const accountId = idParam(req, "accountId", "mail account");
      const draftId = idParam(req, "draftId", "draft");
      await svc.removeDraft(companyId, accountId, draftId, resolveActor(req, companyId));
      res.status(204).end();
    },
  );

  // DUR-4149: "the PA/secretary only drafts, a human presses Send" -- an
  // agent credential is refused here before it ever reaches the service,
  // on top of the service's own owner-only check.
  router.post(
    "/companies/:companyId/mail-accounts/:accountId/drafts/:draftId/send",
    memberScope(),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const accountId = idParam(req, "accountId", "mail account");
      const draftId = idParam(req, "draftId", "draft");
      res.json(await svc.sendDraft(companyId, accountId, draftId, resolveActor(req, companyId)));
    },
  );

  // ─── Emergency access (break-glass) ────────────────────────────────────────

  router.post(
    "/companies/:companyId/mail-accounts/:accountId/emergency-access",
    memberScope(),
    validate(mailAccountEmergencyAccessSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyOwnerOrAdmin(req, companyId);
      const accountId = idParam(req, "accountId", "mail account");
      const actorInfo = getActorInfo(req);
      res.status(201).json(
        await svc.emergencyReadMessages(companyId, accountId, actorInfo.actorId, req.body.reason, {
          folder: parseFolder(req) ?? "inbox",
          limit: parseLimit(req),
          notify: req.body.notify,
        }),
      );
    },
  );

  return router;
}
