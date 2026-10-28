import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { submitCodeRenderSchema, type SubmitCodeRenderInput } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { notFound } from "../errors.js";
import { assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { codeRenderService, type CodeRenderActor, type CodeRenderServiceDeps } from "../services/code-renders.js";

/**
 * Media Studio code-rendered videos (D14). Agents (the explainer-video and
 * Brag skills) and board members send a Hyperframes composition here; the
 * service checks it against the caps and hands it to the locked-down render
 * worker. Agent keys and board users of THIS company only (assertCompanyAccess
 * refuses another company's agent key and a viewer's writes); every job lookup
 * is company-scoped in the service.
 *
 *   POST /companies/:companyId/code-renders                  submit (check | snapshot | render)
 *   GET  /companies/:companyId/code-renders                  recent jobs
 *   GET  /companies/:companyId/code-renders/usage            caps and today's use
 *   GET  /companies/:companyId/code-renders/:jobId           one job (collects it when finished)
 *   POST /companies/:companyId/code-renders/:jobId/cancel    stop a waiting or running job
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(req: Request): CodeRenderActor {
  const info = getActorInfo(req);
  return info.actorType === "agent"
    ? { agentId: info.agentId, userId: null, runId: info.runId }
    : { agentId: null, userId: info.actorId, runId: info.runId };
}

function jobIdOf(req: Request): string {
  const jobId = req.params.jobId as string;
  if (!UUID_PATTERN.test(jobId)) throw notFound("Code render job not found");
  return jobId;
}

export function codeRenderRoutes(rawDb: Db, deps: CodeRenderServiceDeps = {}) {
  const router = Router();
  const renders = codeRenderService(createRequestScopedDb(rawDb), deps);
  const scope = () =>
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrAgent(req);
      assertCompanyAccess(req, companyId);
    });

  router.get("/companies/:companyId/code-renders/usage", scope(), async (req, res) => {
    res.json(await renders.usage(req.params.companyId as string));
  });

  router.get("/companies/:companyId/code-renders", scope(), async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    res.json(await renders.list(req.params.companyId as string, { limit: Number.isFinite(limit) ? limit : undefined }));
  });

  router.post("/companies/:companyId/code-renders", scope(), validate(submitCodeRenderSchema), async (req, res) => {
    const job = await renders.submit(req.params.companyId as string, actorOf(req), req.body as SubmitCodeRenderInput);
    res.status(202).json(job);
  });

  router.get("/companies/:companyId/code-renders/:jobId", scope(), async (req, res) => {
    res.json(await renders.get(req.params.companyId as string, jobIdOf(req)));
  });

  router.post("/companies/:companyId/code-renders/:jobId/cancel", scope(), async (req, res) => {
    res.json(await renders.cancel(req.params.companyId as string, jobIdOf(req), actorOf(req)));
  });

  return router;
}
