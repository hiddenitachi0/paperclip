import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  MEDIA_BILLING_LABELS,
  MEDIA_CAPABILITY_FAMILIES,
  MEDIA_SETUP_SCORE_ATTRIBUTES,
  MEDIA_SETUP_SCORE_LABELS,
  createMediaLoraSchema,
  createMediaSetupSchema,
  createMediaSetupTrialSchema,
  listMediaSetupsQuerySchema,
  setStorylineMediaSetupsSchema,
  updateMediaLoraSchema,
  updateMediaProjectDefaultsSchema,
  updateMediaSetupSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin, assertCompanyOwnerOrInstanceAdmin } from "./authz.js";
import { badRequest } from "../errors.js";
import { mediaSetupsService, type MediaSetupsActor, type MediaSetupsReader } from "../services/media-setups.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.js";

/**
 * Media Studio film studio, Phase 1: the LoRA library, saved model setups,
 * the setup register and the company's new-project defaults.
 *
 *   - Owners and admins (and instance admins) create, edit, approve, archive
 *     and delete setups and LoRAs, record and remove register tries, and set
 *     the project defaults. Making "mature" the default content rating is the
 *     owner's call (D1).
 *   - Other board members read everything.
 *   - Agents read approved setups only (a draft or archived one is "not
 *     found"), read usable LoRAs, and never write -- except picking an
 *     approved setup for a storyline they may edit.
 * Every route is company-scoped through `companyScopeFromParam` (RLS plus the
 * company check); the service filters every query on the company again.
 */

const EDIT_WHAT = "model setups and the LoRA library";

function actorOf(req: Request): MediaSetupsActor {
  if (req.actor.type === "agent") {
    return { actorType: "agent", actorId: req.actor.agentId ?? "unknown", agentId: req.actor.agentId ?? null };
  }
  return { actorType: "user", actorId: req.actor.userId ?? "board", agentId: null };
}

function readerOf(req: Request): MediaSetupsReader {
  return { agent: req.actor.type === "agent" };
}

export function mediaSetupRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = mediaSetupsService(db);
  const storylineSettings = videoStorylineSettingsService(db);

  function scope(): RequestHandler {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrAgent(req);
      assertCompanyAccess(req, companyId);
    });
  }

  function canEdit(req: Request, companyId: string): boolean {
    if (req.actor.type === "agent") return false;
    try {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, EDIT_WHAT);
      return true;
    } catch {
      return false;
    }
  }

  function assertEditor(req: Request, companyId: string) {
    assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, EDIT_WHAT);
  }

  // ─── Capabilities ─────────────────────────────────────────────────────

  router.get("/companies/:companyId/media/capabilities", scope(), async (_req, res) => {
    res.json({
      families: MEDIA_CAPABILITY_FAMILIES,
      billingLabels: MEDIA_BILLING_LABELS,
      scoreAttributes: MEDIA_SETUP_SCORE_ATTRIBUTES.map((key) => ({ key, label: MEDIA_SETUP_SCORE_LABELS[key] })),
    });
  });

  // ─── Model setups ─────────────────────────────────────────────────────

  router.get("/companies/:companyId/media/setups", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const query = listMediaSetupsQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Unknown filter. Use kind=image|video and includeArchived=true|false.");
    const setups = await svc.listSetups(companyId, readerOf(req), {
      kind: query.data.kind,
      includeArchived: query.data.includeArchived === "true",
    });
    res.json({ setups, canEdit: canEdit(req, companyId) });
  });

  // Registered before .../:setupId so "check" is never read as an id.
  router.post("/companies/:companyId/media/setups/check", validate(createMediaSetupSchema), scope(), async (req, res) => {
    assertBoard(req);
    res.json(await svc.checkSetup(req.params.companyId as string, req.body));
  });

  router.post("/companies/:companyId/media/setups", validate(createMediaSetupSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    res.status(201).json(await svc.createSetup(companyId, req.body, actorOf(req)));
  });

  router.get("/companies/:companyId/media/setups/:setupId", scope(), async (req, res) => {
    res.json(await svc.getSetup(req.params.companyId as string, req.params.setupId as string, readerOf(req)));
  });

  router.patch("/companies/:companyId/media/setups/:setupId", validate(updateMediaSetupSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    res.json(await svc.updateSetup(companyId, req.params.setupId as string, req.body, actorOf(req)));
  });

  router.delete("/companies/:companyId/media/setups/:setupId", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    await svc.deleteSetup(companyId, req.params.setupId as string, actorOf(req));
    res.status(204).end();
  });

  /** What a run would send: provider, exact model, the LoRAs' provider refs and strengths, params, and whether it is usable now. */
  router.get("/companies/:companyId/media/setups/:setupId/resolve", scope(), async (req, res) => {
    res.json(await svc.resolveSetup(req.params.companyId as string, req.params.setupId as string, readerOf(req)));
  });

  // ─── Register (tries and scores) ──────────────────────────────────────

  router.get("/companies/:companyId/media/setups/:setupId/trials", scope(), async (req, res) => {
    assertBoard(req);
    res.json({ trials: await svc.listTrials(req.params.companyId as string, req.params.setupId as string) });
  });

  router.post("/companies/:companyId/media/setups/:setupId/trials", validate(createMediaSetupTrialSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    res.status(201).json(await svc.createTrial(companyId, req.params.setupId as string, req.body, actorOf(req)));
  });

  router.delete("/companies/:companyId/media/setups/:setupId/trials/:trialId", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    await svc.deleteTrial(companyId, req.params.setupId as string, req.params.trialId as string, actorOf(req));
    res.status(204).end();
  });

  // ─── LoRA library ─────────────────────────────────────────────────────

  router.get("/companies/:companyId/media/loras", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const loras = await svc.listLoras(companyId, readerOf(req), { includeArchived: req.query.includeArchived === "true" });
    res.json({ loras, canEdit: canEdit(req, companyId) });
  });

  router.post("/companies/:companyId/media/loras", validate(createMediaLoraSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    res.status(201).json(await svc.createLora(companyId, req.body, actorOf(req)));
  });

  router.get("/companies/:companyId/media/loras/:loraId", scope(), async (req, res) => {
    res.json(await svc.getLora(req.params.companyId as string, req.params.loraId as string, readerOf(req)));
  });

  router.patch("/companies/:companyId/media/loras/:loraId", validate(updateMediaLoraSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    res.json(await svc.updateLora(companyId, req.params.loraId as string, req.body, actorOf(req)));
  });

  router.delete("/companies/:companyId/media/loras/:loraId", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    await svc.deleteLora(companyId, req.params.loraId as string, actorOf(req));
    res.status(204).end();
  });

  // ─── New-project defaults ─────────────────────────────────────────────

  router.get("/companies/:companyId/media/project-defaults", scope(), async (req, res) => {
    res.json(await svc.getProjectDefaults(req.params.companyId as string));
  });

  router.patch("/companies/:companyId/media/project-defaults", validate(updateMediaProjectDefaultsSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertEditor(req, companyId);
    if (req.body.defaultContentRating === "mature") {
      // D1: only the owner may let anything default to mature.
      assertCompanyOwnerOrInstanceAdmin(req, companyId, "a mature default content rating");
    }
    res.json(await svc.updateProjectDefaults(companyId, req.body, actorOf(req)));
  });

  // ─── Storylines ───────────────────────────────────────────────────────

  /** Pick the setups a storyline uses; agents may pick approved setups only. */
  router.put("/companies/:companyId/media/storylines/:storylineId/setups", validate(setStorylineMediaSetupsSchema), scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    await storylineSettings.assertEnabled(companyId);
    res.json(await svc.setStorylineSetups(companyId, req.params.storylineId as string, req.body, actorOf(req), readerOf(req)));
  });

  return router;
}
