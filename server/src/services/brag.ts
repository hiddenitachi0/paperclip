import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { bragJobs, bragScenes, projectWorkspaces, projects, withCompanyScope } from "@paperclipai/db";
import {
  BRAG_BILLING_CODE,
  bragSceneCount,
  estimateBragCostCents,
  isBragOverrun,
  type BragEstimateResult,
  type BragFormat,
  type CreateBragJobInput,
  type UpdateBragSceneInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { costService } from "./costs.js";
import { issueService } from "./issues.js";
import { stitchClipsWithTransitions, type StitchResult } from "./video-ffmpeg.js";
import { fetchWebsiteMaterial, readWorkspaceMaterial, type BragSourceMaterial } from "./brag-source.js";
import { ffmpegBragCapturer, type BragCapturer } from "./brag-render.js";
import { redactForScreen } from "./brag-secret-mask.js";

/**
 * DUR-4520 (Brag video, parent DUR-4518): the backend pipeline. Same gate
 * shape as video storylines (DUR-4320/4321): plan -> one still per scene ->
 * approve / edit / leave out -> refuse the full render until every scene
 * that is still in is approved. Spend is checked against the company and
 * project budget policies before anything starts, and a render aborts when
 * actual spend passes 2x its estimate. Every piece of on-screen text goes
 * through brag-secret-mask before it is stored on a scene.
 */

export interface BragActor {
  userId: string | null;
  agentId?: string | null;
}

export interface BragServiceDeps {
  capturer?: BragCapturer;
  loadSource?: (job: typeof bragJobs.$inferSelect, project: { name: string; workspaceCwd: string | null }) => Promise<BragSourceMaterial>;
  stitch?: (clips: Buffer[]) => Promise<StitchResult>;
  /** Persists bytes and returns the stored file id. Defaults to company storage + a Files-page row (same as Media Studio direct). */
  saveFile?: (input: { companyId: string; actor: BragActor; filename: string; contentType: string; body: Buffer }) => Promise<{ id: string }>;
}

const SECONDS_PER_SCENE_CLIP = 4;

export function bragService(db: Db, deps: BragServiceDeps = {}) {
  const budgets = budgetService(db);
  const costs = costService(db);
  const issues = issueService(db);
  const capturer = deps.capturer ?? ffmpegBragCapturer;

  async function loadJob(companyId: string, jobId: string) {
    const row = await withCompanyScope(db, companyId, (tx) =>
      tx.select().from(bragJobs).where(and(eq(bragJobs.id, jobId), eq(bragJobs.companyId, companyId))).then((r) => r[0] ?? null),
    );
    if (!row) throw notFound("Brag job not found");
    return row;
  }

  async function loadScenes(companyId: string, jobId: string) {
    return withCompanyScope(db, companyId, (tx) =>
      tx.select().from(bragScenes).where(and(eq(bragScenes.jobId, jobId), eq(bragScenes.companyId, companyId))).orderBy(asc(bragScenes.sceneOrder)),
    );
  }

  /** Refuses when a hard-stop budget policy on the company or this project cannot cover the estimate. Fails closed. */
  async function assertWithinBudget(companyId: string, projectId: string, estimatedCents: number): Promise<void> {
    const overview = await budgets.overview(companyId);
    for (const policy of overview.policies) {
      const applies = policy.scopeType === "company" || (policy.scopeType === "project" && policy.scopeId === projectId);
      if (!applies || !policy.isActive) continue;
      if (policy.paused) throw unprocessable(`The ${policy.scopeType} budget is paused. Resume it before making a video.`);
      if (policy.hardStopEnabled && policy.remainingAmount < estimatedCents) {
        throw unprocessable(
          `Estimated cost (${estimatedCents} cents) is more than what is left in the ${policy.scopeType} budget (${Math.max(0, policy.remainingAmount)} cents).`,
        );
      }
    }
  }

  async function recordSpend(companyId: string, job: typeof bragJobs.$inferSelect, cents: number, actor: BragActor) {
    if (cents <= 0) return;
    await costs.createEvent(companyId, {
      agentId: actor.agentId ?? null,
      createdByUserId: actor.userId,
      projectId: job.projectId,
      provider: "paperclip",
      biller: "paperclip",
      billingType: "metered_api",
      billingCode: BRAG_BILLING_CODE,
      model: "brag-slim",
      inputTokens: 0,
      outputTokens: 0,
      costCents: cents,
      occurredAt: new Date(),
    } as never);
  }

  async function defaultLoadSource(job: typeof bragJobs.$inferSelect, project: { name: string; workspaceCwd: string | null }) {
    if (job.sourceUrl) return fetchWebsiteMaterial(job.sourceUrl);
    if (!project.workspaceCwd) throw unprocessable("This project has no workspace checkout to read. Give it a website address instead.");
    return readWorkspaceMaterial(project.workspaceCwd, project.name);
  }

  async function defaultSaveFile(input: { companyId: string; actor: BragActor; filename: string; contentType: string; body: Buffer }) {
    const stored = await getStorageService().putFile({
      companyId: input.companyId,
      namespace: "brag",
      originalFilename: input.filename,
      contentType: input.contentType,
      body: input.body,
    });
    return issues.createCompanyFile({
      companyId: input.companyId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: input.actor.agentId ?? null,
      createdByUserId: input.actor.userId,
    });
  }

  return {
    estimate(input: { lengthSeconds: number; music: boolean }): BragEstimateResult {
      return estimateBragCostCents(input);
    },

    async createJob(companyId: string, actor: BragActor, input: CreateBragJobInput) {
      const project = await withCompanyScope(db, companyId, (tx) =>
        tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId))).then((r) => r[0] ?? null),
      );
      if (!project) throw notFound("Project not found");
      const estimate = estimateBragCostCents({ lengthSeconds: input.lengthSeconds, music: input.music });
      const job = await withCompanyScope(db, companyId, (tx) =>
        tx
          .insert(bragJobs)
          .values({
            companyId,
            projectId: input.projectId,
            status: "draft",
            sourceUrl: input.sourceUrl ?? null,
            tone: input.tone ?? null,
            format: input.format,
            lengthSeconds: input.lengthSeconds,
            music: input.music,
            note: input.note ? redactForScreen(input.note) : null,
            estimatedCostCents: estimate.estimatedCostCents,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId,
          })
          .returning()
          .then((r) => r[0]!),
      );
      await logActivity(db, {
        companyId,
        actorType: actor.agentId ? "agent" : "user",
        actorId: actor.agentId ?? actor.userId ?? "unknown",
        agentId: actor.agentId ?? null,
        action: "brag_job.created",
        entityType: "brag_job",
        entityId: job.id,
        details: { projectId: input.projectId, estimatedCostCents: estimate.estimatedCostCents, mode: input.sourceUrl ? "website" : "code" },
      });
      return job;
    },

    async getJob(companyId: string, jobId: string) {
      const job = await loadJob(companyId, jobId);
      return { job, scenes: await loadScenes(companyId, jobId) };
    },

    async listJobs(companyId: string, projectId: string) {
      return withCompanyScope(db, companyId, (tx) =>
        tx.select().from(bragJobs).where(and(eq(bragJobs.companyId, companyId), eq(bragJobs.projectId, projectId))).orderBy(desc(bragJobs.createdAt)).limit(50),
      );
    },

    /** Gathers source material, writes one scene per snippet, captures a still for each, then waits for approval. */
    async planJob(companyId: string, jobId: string, actor: BragActor) {
      const job = await loadJob(companyId, jobId);
      if (job.status !== "draft" && job.status !== "failed") {
        throw conflict(`This video is already ${job.status}; it cannot be planned again.`);
      }
      await assertWithinBudget(companyId, job.projectId, job.estimatedCostCents);

      const project = await withCompanyScope(db, companyId, async (tx) => {
        const p = await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, job.projectId)).then((r) => r[0]);
        const ws = await tx.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces).where(eq(projectWorkspaces.projectId, job.projectId)).limit(1).then((r) => r[0]);
        return { name: p?.name ?? "Project", workspaceCwd: ws?.cwd ?? null };
      });

      await withCompanyScope(db, companyId, (tx) => tx.update(bragJobs).set({ status: "planning", updatedAt: new Date() }).where(eq(bragJobs.id, jobId)));
      try {
        const material = await (deps.loadSource ?? defaultLoadSource)(job, project);
        const count = bragSceneCount(job.lengthSeconds);
        const texts = [material.title, ...material.snippets].filter(Boolean).slice(0, count).map((t) => redactForScreen(t));
        if (texts.length === 0) throw unprocessable("Found nothing on screen-worthy to make a video from.");
        const format = job.format as BragFormat;
        const stored = getStorageService();
        const rows: Array<{ description: string; stillRef: string }> = [];
        for (const text of texts) {
          const still = await capturer.captureStill({ text, format });
          const file = await stored.putFile({ companyId, namespace: "brag-stills", originalFilename: "scene.png", contentType: "image/png", body: still });
          rows.push({ description: text, stillRef: file.objectKey });
        }
        // Slim mode: capture/stitch are free local tools; only the planning call is metered. Music generation is not part of this phase, so it is never charged.
        const planningCents = estimateBragCostCents({ lengthSeconds: job.lengthSeconds, music: false }).planningCents;
        await withCompanyScope(db, companyId, async (tx) => {
          await tx.delete(bragScenes).where(eq(bragScenes.jobId, jobId));
          await tx.insert(bragScenes).values(rows.map((r, i) => ({ companyId, jobId, sceneOrder: i + 1, description: r.description, stillRef: r.stillRef })));
          await tx.update(bragJobs).set({ status: "awaiting_approval", actualCostCents: planningCents, updatedAt: new Date() }).where(eq(bragJobs.id, jobId));
        });
        await recordSpend(companyId, job, planningCents, actor);
        await logActivity(db, {
          companyId,
          actorType: actor.agentId ? "agent" : "user",
          actorId: actor.agentId ?? actor.userId ?? "unknown",
          agentId: actor.agentId ?? null,
          action: "brag_job.planned",
          entityType: "brag_job",
          entityId: jobId,
          details: { sceneCount: rows.length, skippedSecretFiles: material.skipped.length },
        });
      } catch (error) {
        await withCompanyScope(db, companyId, (tx) => tx.update(bragJobs).set({ status: "failed", updatedAt: new Date() }).where(eq(bragJobs.id, jobId)));
        throw error;
      }
      return this.getJob(companyId, jobId);
    },

    /** approve / edit (re-captures the still, back to pending) / leave out. Only while awaiting approval. */
    async updateScene(companyId: string, jobId: string, sceneId: string, input: UpdateBragSceneInput) {
      const job = await loadJob(companyId, jobId);
      if (job.status !== "awaiting_approval") throw conflict("Scenes can only be changed while the video is waiting for approval.");
      const scene = (await loadScenes(companyId, jobId)).find((s) => s.id === sceneId);
      if (!scene) throw notFound("Scene not found");
      const patch: Partial<typeof bragScenes.$inferInsert> = { updatedAt: new Date() };
      if (input.action === "approve") patch.approvalStatus = "approved";
      else if (input.action === "leave_out") patch.approvalStatus = "rejected";
      else {
        const text = redactForScreen(input.description!);
        const still = await capturer.captureStill({ text, format: job.format as BragFormat });
        const file = await getStorageService().putFile({ companyId, namespace: "brag-stills", originalFilename: "scene.png", contentType: "image/png", body: still });
        patch.description = text;
        patch.stillRef = file.objectKey;
        patch.approvalStatus = "pending";
      }
      await withCompanyScope(db, companyId, (tx) => tx.update(bragScenes).set(patch).where(and(eq(bragScenes.id, sceneId), eq(bragScenes.companyId, companyId))));
      return loadScenes(companyId, jobId);
    },

    /** Refuses until every scene still in is approved; checks budget; renders, stitches, saves MP4 + poster. */
    async render(companyId: string, jobId: string, actor: BragActor) {
      const job = await loadJob(companyId, jobId);
      if (job.status !== "awaiting_approval") throw conflict(`This video is ${job.status}; only one waiting for approval can be rendered.`);
      const scenes = await loadScenes(companyId, jobId);
      const inScenes = scenes.filter((s) => s.approvalStatus !== "rejected");
      if (inScenes.length === 0) throw unprocessable("Every scene was left out. Keep at least one scene.");
      const pending = inScenes.find((s) => s.approvalStatus !== "approved");
      if (pending) {
        throw unprocessable(`Scene ${pending.sceneOrder} has not been approved yet. Approve every scene (or leave it out) before rendering.`);
      }
      await assertWithinBudget(companyId, job.projectId, job.estimatedCostCents);
      // Claim the render: only one caller flips awaiting_approval -> rendering.
      const claimed = await withCompanyScope(db, companyId, (tx) =>
        tx.update(bragJobs).set({ status: "rendering", updatedAt: new Date() }).where(and(eq(bragJobs.id, jobId), eq(bragJobs.status, "awaiting_approval"))).returning({ id: bragJobs.id }),
      );
      if (claimed.length === 0) throw conflict("This video is already being rendered.");

      try {
        const storage = getStorageService();
        const clips: Buffer[] = [];
        let poster: Buffer | null = null;
        for (const scene of inScenes) {
          if (isBragOverrun(job.estimatedCostCents, job.actualCostCents)) throw unprocessable("Spend passed twice the estimate; the render was stopped.");
          const obj = await storage.getObject(companyId, scene.stillRef!);
          const chunks: Buffer[] = [];
          for await (const c of obj.stream) chunks.push(Buffer.from(c));
          const still = Buffer.concat(chunks);
          poster ??= still;
          clips.push(await capturer.makeClip({ still, seconds: SECONDS_PER_SCENE_CLIP, format: job.format as BragFormat }));
        }
        const stitched = await (deps.stitch ?? ((c: Buffer[]) => stitchClipsWithTransitions(c.map((buffer, i) => ({ buffer, transitionIn: i === 0 ? "cut" as const : "fade" as const, transitionDurationMs: 400 })))))(clips);
        const video = await (deps.saveFile ?? defaultSaveFile)({ companyId, actor, filename: "brag.mp4", contentType: "video/mp4", body: stitched.buffer });
        const posterFile = await (deps.saveFile ?? defaultSaveFile)({ companyId, actor, filename: "brag-poster.png", contentType: "image/png", body: poster! });
        const shareCopy = inScenes.map((s) => s.description).filter(Boolean).slice(0, 3).join(" — ");
        await withCompanyScope(db, companyId, (tx) =>
          tx.update(bragJobs).set({
            status: "completed",
            options: { ...(job.options ?? {}), videoFileId: video.id, posterFileId: posterFile.id, shareCopy },
            updatedAt: new Date(),
          }).where(eq(bragJobs.id, jobId)),
        );
        await logActivity(db, {
          companyId,
          actorType: actor.agentId ? "agent" : "user",
          actorId: actor.agentId ?? actor.userId ?? "unknown",
          agentId: actor.agentId ?? null,
          action: "brag_job.completed",
          entityType: "brag_job",
          entityId: jobId,
          details: { videoFileId: video.id, posterFileId: posterFile.id, sceneCount: inScenes.length },
        });
      } catch (error) {
        await withCompanyScope(db, companyId, (tx) => tx.update(bragJobs).set({ status: "failed", updatedAt: new Date() }).where(eq(bragJobs.id, jobId)));
        throw error;
      }
      return this.getJob(companyId, jobId);
    },

    async cancel(companyId: string, jobId: string) {
      const job = await loadJob(companyId, jobId);
      if (job.status === "completed" || job.status === "cancelled") throw conflict(`This video is already ${job.status}.`);
      await withCompanyScope(db, companyId, (tx) => tx.update(bragJobs).set({ status: "cancelled", updatedAt: new Date() }).where(eq(bragJobs.id, jobId)));
      return loadJob(companyId, jobId);
    },
  };
}
