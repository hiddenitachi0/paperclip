import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { speechSpeakSchema, speechTranscribeSchema, updateSpeechSettingsSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin } from "./authz.js";
import { logActivity } from "../services/index.js";
import { speechService } from "../services/speech.js";

/** Path of the one route whose body may be larger than the default JSON limit. */
export const SPEECH_TRANSCRIBE_API_PATH = "/api/companies/:companyId/speech/transcribe";
/** Base64 of a 20 MB recording, plus room for the other fields. */
export const SPEECH_TRANSCRIBE_JSON_BODY_LIMIT = "28mb";

/**
 * Voice messages: the company's speech settings, and the two speech calls.
 *
 * Board users only, with access to the company. An agent is refused by
 * assertBoard on every route here, so no agent can turn text into speech or
 * speech into text on the company's key. The Telegram bridge reaches these
 * routes through the CLI with its existing board sign-in, like every other
 * call it makes. Changing the key or the daily allowances is for the company's
 * owner or an admin, since it decides what the company pays for.
 */
export function speechRoutes(rawDb: Db, deps: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = speechService(db, deps);

  function boardScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    });
  }

  function actorUserId(req: Request): string | null {
    return req.actor.type === "board" ? (req.actor.userId ?? "board") : null;
  }

  router.get("/companies/:companyId/speech-settings", boardScope(), async (req, res) => {
    res.json(await svc.getSettings(req.params.companyId as string));
  });

  router.put(
    "/companies/:companyId/speech-settings",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the voice message settings");
    }),
    validate(updateSpeechSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.updateSettings(companyId, req.body, { userId: actorUserId(req) });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req) ?? "board",
        action: "speech.settings_changed",
        entityType: "company",
        entityId: companyId,
        // The secret's id and name only, never its value.
        details: {
          keySecretId: updated.keySecretId,
          dailyTranscribeSecondsCap: updated.dailyTranscribeSecondsCap,
          dailySpeakCharactersCap: updated.dailySpeakCharactersCap,
        },
      });
      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/speech/transcribe",
    boardScope(),
    validate(speechTranscribeSchema),
    async (req, res) => {
      res.json(
        await svc.transcribe(req.params.companyId as string, req.body, { userId: actorUserId(req) }),
      );
    },
  );

  router.post("/companies/:companyId/speech/speak", boardScope(), validate(speechSpeakSchema), async (req, res) => {
    res.json(await svc.speak(req.params.companyId as string, req.body, { userId: actorUserId(req) }));
  });

  return router;
}
