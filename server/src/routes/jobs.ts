import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  createJobSchema,
  createJobTriggerSchema,
  runJobSchema,
  setJobPositionsSchema,
  updateJobSchema,
  updateJobTriggerSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, jobService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";

// DUR-4182: Jobs are a company-wide catalog item attached to Positions
// (company_agent_roles), not owned by a single assignee the way a routine
// is -- so "can this actor manage this job definition" can't reuse the
// routine pattern of "assignee === caller". Job definitions/triggers are
// board-managed (same tasks:assign permission already gating who may define
// assignable work via routines); any company-scoped actor may list/get a
// job, and running one additionally requires the target runAgentId to
// currently hold one of the job's linked positions (board actors may run on
// behalf of any agent, same operator-override split used throughout).
export function jobRoutes(db: Db, options: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const svc = jobService(db, { heartbeat: options.heartbeat });
  const access = accessService(db);

  async function assertBoardCanManageJobs(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Only the board (or an agent with tasks:assign) can manage job definitions");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  async function assertAgentHoldsAnyPosition(companyId: string, agentId: string, positionIds: string[]) {
    if (positionIds.length === 0) return false;
    const agent = await db
      .select({ roleId: agents.roleId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return !!agent?.roleId && positionIds.includes(agent.roleId);
  }

  function actorTuple(req: Request) {
    return {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    };
  }

  router.get("/companies/:companyId/jobs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
    const result = await svc.list(companyId, { projectId, agentId });
    res.json(result);
  });

  router.post("/companies/:companyId/jobs", validate(createJobSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCanManageJobs(req, companyId);
    const created = await svc.create(companyId, req.body, actorTuple(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.created",
      entityType: "job",
      entityId: created.id,
      details: { title: created.title, runMode: created.runMode, positionIds: created.positions.map((p) => p.id) },
    });
    res.status(201).json(created);
  });

  router.get("/jobs/:id", async (req, res) => {
    const detail = await svc.getDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.patch("/jobs/:id", validate(updateJobSchema), async (req, res) => {
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await assertBoardCanManageJobs(req, existing.companyId);
    const updated = await svc.update(existing.id, req.body, actorTuple(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.updated",
      entityType: "job",
      entityId: existing.id,
      details: { title: updated?.title ?? existing.title },
    });
    res.json(updated);
  });

  router.put("/jobs/:id/positions", validate(setJobPositionsSchema), async (req, res) => {
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await assertBoardCanManageJobs(req, existing.companyId);
    const updated = await svc.setPositions(existing.id, req.body.positionIds, actorTuple(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.positions_set",
      entityType: "job",
      entityId: existing.id,
      details: { positionIds: req.body.positionIds },
    });
    res.json(updated);
  });

  router.get("/jobs/:id/runs", async (req, res) => {
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const limit = Number(req.query.limit ?? 50);
    const result = await svc.listRuns(existing.id, Number.isFinite(limit) ? limit : 50);
    res.json(result);
  });

  router.post("/jobs/:id/triggers", validate(createJobTriggerSchema), async (req, res) => {
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await assertBoardCanManageJobs(req, existing.companyId);
    const created = await svc.createTrigger(existing.id, req.body, actorTuple(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.trigger_created",
      entityType: "job_trigger",
      entityId: created.trigger.id,
      details: { jobId: existing.id, kind: created.trigger.kind },
    });
    res.status(201).json(created);
  });

  router.patch("/job-triggers/:id", validate(updateJobTriggerSchema), async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Job trigger not found" });
      return;
    }
    const job = await svc.get(trigger.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await assertBoardCanManageJobs(req, job.companyId);
    const updated = await svc.updateTrigger(trigger.id, req.body, actorTuple(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: job.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.trigger_updated",
      entityType: "job_trigger",
      entityId: trigger.id,
      details: { jobId: job.id },
    });
    res.json(updated);
  });

  router.delete("/job-triggers/:id", async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Job trigger not found" });
      return;
    }
    const job = await svc.get(trigger.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await assertBoardCanManageJobs(req, job.companyId);
    await svc.deleteTrigger(trigger.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: job.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.trigger_deleted",
      entityType: "job_trigger",
      entityId: trigger.id,
      details: { jobId: job.id, kind: trigger.kind },
    });
    res.status(204).end();
  });

  // "Run job" -- creates a task from the job definition + form values. A
  // quick-agent persona bridged over Telegram (e.g. Maja) calls this the
  // same way any other agent does, naming a colleague as `runAgentId` and
  // `source: "telegram"` -- no separate Telegram-specific route is needed.
  router.post("/jobs/:id/run", validate(runJobSchema), async (req, res) => {
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "agent" && !req.actor.agentId) throw unauthorized();
    if (req.actor.type !== "board") {
      // Gate on the *target* holding a linked position, not the caller. A
      // job's task is always assigned to `runAgentId` (required by
      // runJobSchema, even for a self-run), so gating on "caller holds any
      // linked position" instead/in addition would let any position holder
      // direct the job's task -- attacker-controlled title/instructions,
      // model profile and effort included -- onto an unrelated agent who
      // never qualified for this job. Requiring the target to hold the
      // position covers both self-run and the Telegram-bridge "Maja starts a
      // job on a qualified colleague" case without that escalation.
      const detail = await svc.getDetail(existing.id);
      const positionIds = detail?.positions.map((p) => p.id) ?? [];
      const targetHoldsPosition = await assertAgentHoldsAnyPosition(existing.companyId, req.body.runAgentId, positionIds);
      if (!targetHoldsPosition) {
        throw forbidden("The target agent does not hold a position linked to this job");
      }
    }
    const run = await svc.runJob(existing.id, req.body, actorTuple(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "job.run_triggered",
      entityType: "job_run",
      entityId: run.id,
      details: { jobId: existing.id, source: run.source, status: run.status, runAgentId: run.runAgentId },
    });
    res.status(202).json(run);
  });

  router.post("/job-triggers/public/:publicId/fire", async (req, res) => {
    const result = await svc.firePublicTrigger(req.params.publicId as string, {
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload: typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : null,
    });
    res.status(202).json(result);
  });

  return router;
}
