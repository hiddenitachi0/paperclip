import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  MAIL_ITEM_DECISIONS,
  createMailInboxFilterSchema,
  createMailInboxSchema,
  updateMailInboxFilterSchema,
  updateMailInboxSchema,
  type MailItemDecision,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { mailSecretaryService, type MailSecretaryServiceDeps } from "../services/mail-secretary.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Mail secretary: read-only IMAP triage for one or more of an operator's
 * inboxes (see services/mail-secretary.ts for the tick itself).
 *
 * Who may do what: an inbox is set up against a real mailbox, points a quick
 * agent's IMAP credential at whichever agent it delegates relevant mail to
 * (typically Maja), and its items log includes message subjects and body
 * excerpts pulled straight from someone's personal inbox -- more sensitive
 * than a watcher's price-check config. So every route here, including reads,
 * is company owner/admin only (or the local single-user board, or an
 * instance admin), same bar as changing a watcher, just applied to viewing
 * too. Agents are refused on every route: an agent can neither configure an
 * inbox nor read its triage log or a delegated item's content directly --
 * delegation happens by the secretary duty itself handing framed content to
 * the delegate agent's own run, not by that agent calling this API.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name] as string;
  if (!UUID_RE.test(value)) throw notFound(`That ${what} was not found.`);
  return value;
}

function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can see or change the mail secretary. It reads someone's real inbox.");
    }
  }
  assertCompanyAccess(req, companyId);
}

function parseItemsQuery(req: Request): { limit?: number; decision?: MailItemDecision } {
  const out: { limit?: number; decision?: MailItemDecision } = {};
  const limitRaw = req.query.limit;
  if (typeof limitRaw === "string" && limitRaw.trim()) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive whole number.");
    out.limit = limit;
  }
  const decisionRaw = req.query.decision;
  if (typeof decisionRaw === "string" && decisionRaw.trim()) {
    if (!(MAIL_ITEM_DECISIONS as readonly string[]).includes(decisionRaw)) {
      throw badRequest(`decision must be one of: ${MAIL_ITEM_DECISIONS.join(", ")}.`);
    }
    out.decision = decisionRaw as MailItemDecision;
  }
  return out;
}

export function mailSecretaryRoutes(rawDb: Db, deps: MailSecretaryServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = mailSecretaryService(db, deps);

  function ownerOrAdminScope() {
    return companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyOwnerOrAdmin(req, companyId);
      return companyId;
    });
  }

  function actorOf(req: Request) {
    return { userId: req.actor.type === "board" ? req.actor.userId ?? null : null };
  }

  // ─── Inboxes ───────────────────────────────────────────────────────────

  router.get("/companies/:companyId/mail-inboxes", ownerOrAdminScope(), async (req, res) => {
    res.json({ inboxes: await svc.listInboxes(req.params.companyId as string) });
  });

  router.get("/companies/:companyId/mail-inboxes/:inboxId", ownerOrAdminScope(), async (req, res) => {
    res.json(await svc.getInbox(req.params.companyId as string, idParam(req, "inboxId", "mail inbox")));
  });

  router.post(
    "/companies/:companyId/mail-inboxes",
    ownerOrAdminScope(),
    validate(createMailInboxSchema),
    async (req, res) => {
      res.status(201).json(await svc.createInbox(req.params.companyId as string, req.body, actorOf(req)));
    },
  );

  router.patch(
    "/companies/:companyId/mail-inboxes/:inboxId",
    ownerOrAdminScope(),
    validate(updateMailInboxSchema),
    async (req, res) => {
      res.json(
        await svc.updateInbox(
          req.params.companyId as string,
          idParam(req, "inboxId", "mail inbox"),
          req.body,
          actorOf(req),
        ),
      );
    },
  );

  router.delete("/companies/:companyId/mail-inboxes/:inboxId", ownerOrAdminScope(), async (req, res) => {
    await svc.removeInbox(req.params.companyId as string, idParam(req, "inboxId", "mail inbox"), actorOf(req));
    res.status(204).end();
  });

  // ─── Per-inbox ignore filters ─────────────────────────────────────────

  router.get("/companies/:companyId/mail-inboxes/:inboxId/filters", ownerOrAdminScope(), async (req, res) => {
    res.json({ filters: await svc.listFilters(req.params.companyId as string, idParam(req, "inboxId", "mail inbox")) });
  });

  router.post(
    "/companies/:companyId/mail-inboxes/:inboxId/filters",
    ownerOrAdminScope(),
    validate(createMailInboxFilterSchema),
    async (req, res) => {
      res
        .status(201)
        .json(
          await svc.createFilter(
            req.params.companyId as string,
            idParam(req, "inboxId", "mail inbox"),
            req.body,
            actorOf(req),
          ),
        );
    },
  );

  router.patch(
    "/companies/:companyId/mail-inboxes/:inboxId/filters/:filterId",
    ownerOrAdminScope(),
    validate(updateMailInboxFilterSchema),
    async (req, res) => {
      res.json(
        await svc.updateFilter(
          req.params.companyId as string,
          idParam(req, "inboxId", "mail inbox"),
          idParam(req, "filterId", "filter"),
          req.body,
          actorOf(req),
        ),
      );
    },
  );

  router.delete(
    "/companies/:companyId/mail-inboxes/:inboxId/filters/:filterId",
    ownerOrAdminScope(),
    async (req, res) => {
      await svc.removeFilter(
        req.params.companyId as string,
        idParam(req, "inboxId", "mail inbox"),
        idParam(req, "filterId", "filter"),
        actorOf(req),
      );
      res.status(204).end();
    },
  );

  // ─── Triage log (the practice-mode report) ────────────────────────────

  router.get("/companies/:companyId/mail-inboxes/:inboxId/items", ownerOrAdminScope(), async (req, res) => {
    res.json({
      items: await svc.listItems(
        req.params.companyId as string,
        idParam(req, "inboxId", "mail inbox"),
        parseItemsQuery(req),
      ),
    });
  });

  return router;
}
