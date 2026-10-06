import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";
import {
  CACHE_LIFETIME_MAX,
  CACHE_LIFETIME_MIN,
  CACHE_SETTING_DESCRIPTIONS,
  HANDOFF_THRESHOLD_MAX,
  HANDOFF_THRESHOLD_MIN,
  companyCacheSettingsService,
  type CompanyCacheSettingsPatch,
} from "../services/company-cache-settings.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * DUR-4471: per-company cache-aware-run settings. Any board member can read;
 * only an owner/admin can write (same bar as job-settings.ts).
 */
export function cacheSettingsRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const settings = companyCacheSettingsService(db);

  function scope(requireAdmin: boolean) {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      if (requireAdmin && req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
        const role = membership?.status === "active" ? membership.membershipRole : null;
        if (role !== "owner" && role !== "admin") {
          throw forbidden("Only a company owner or admin can change cache settings. You can see them, but not change them.");
        }
      }
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  function parsePatch(body: unknown): CompanyCacheSettingsPatch {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Body must be an object");
    const input = body as Record<string, unknown>;
    const patch: CompanyCacheSettingsPatch = {};
    for (const key of Object.keys(input)) {
      if (!(key in CACHE_SETTING_DESCRIPTIONS)) throw badRequest(`Unknown setting: ${key}`);
    }
    for (const key of ["enabled", "schedulingEnabled", "handoffEnabled"] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== "boolean") throw badRequest(`${key} must be a boolean`);
      patch[key] = input[key] as boolean;
    }
    const threshold = input.handoffTokenThreshold;
    if (threshold !== undefined) {
      if (!Number.isInteger(threshold) || (threshold as number) < HANDOFF_THRESHOLD_MIN || (threshold as number) > HANDOFF_THRESHOLD_MAX) {
        throw badRequest(`handoffTokenThreshold must be an integer between ${HANDOFF_THRESHOLD_MIN} and ${HANDOFF_THRESHOLD_MAX}`);
      }
      patch.handoffTokenThreshold = threshold as number;
    }
    const lifetime = input.cacheLifetimeMinutes;
    if (lifetime !== undefined) {
      if (lifetime !== null && (!Number.isInteger(lifetime) || (lifetime as number) < CACHE_LIFETIME_MIN || (lifetime as number) > CACHE_LIFETIME_MAX)) {
        throw badRequest(`cacheLifetimeMinutes must be null or an integer between ${CACHE_LIFETIME_MIN} and ${CACHE_LIFETIME_MAX}`);
      }
      patch.cacheLifetimeMinutes = lifetime as number | null;
    }
    if (Object.keys(patch).length === 0) throw badRequest("No settings provided");
    return patch;
  }

  router.get("/companies/:companyId/cache-settings", scope(false), async (req, res) => {
    res.json({ settings: await settings.get(req.params.companyId as string), descriptions: CACHE_SETTING_DESCRIPTIONS });
  });

  router.put("/companies/:companyId/cache-settings", scope(true), async (req, res) => {
    const patch = parsePatch(req.body);
    const companyId = req.params.companyId as string;
    const result = await settings.update(companyId, patch);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.cache_settings_updated",
      entityType: "company_cache_settings",
      entityId: companyId,
      details: patch,
    });
    res.json({ settings: result, descriptions: CACHE_SETTING_DESCRIPTIONS });
  });

  return router;
}
