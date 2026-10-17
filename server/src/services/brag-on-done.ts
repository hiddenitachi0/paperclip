import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issueComments, issueWorkProducts, issues } from "@paperclipai/db";
import {
  BRAG_ON_DONE_LENGTH_SECONDS,
  bragSceneCount,
  resolveBragOnDoneMaxCostCents,
  type BragOnDoneOutcome,
  type IssueBragPreapproval,
} from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { bragService, type BragActor, type BragTaskMaterial } from "./brag.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

/**
 * "Make a short brag video when this is done".
 *
 * A person ticks the box on a task. That tick is stored on the task as a
 * pre-approval: who approved it, when, and the most the video may cost (the
 * company's cap at that moment). Agents can never write it: the issue routes
 * refuse the field from an agent, and the generic issue create/update paths
 * strip it, so the setter below is the only writer.
 *
 * When the task reaches done, the scheduler sweep (tick) claims the
 * pre-approval exactly once -- triggeredAt is set in the same UPDATE that
 * checks it is still empty, and is never cleared -- then makes the video
 * through the normal Brag pipeline with the pre-approving PERSON as the actor
 * (never an agent). The scene check a person would normally do is approved
 * automatically only while the cost stays within the recorded cap; otherwise
 * a question card asks the person. The task gets a comment with the video
 * link, or a plain reason when nothing was made.
 */

export const BRAG_ON_DONE_ORIGIN = "brag_on_done";
/** Custom confirmation-card key for "this video costs more than you allowed". */
export const BRAG_ON_DONE_OVER_CAP_CARD_KEY = "brag_on_done_over_cap";
const TICK_BATCH = 3;
const MAX_SNIPPET_CHARS = 200;

type IssueRow = typeof issues.$inferSelect;

export interface BragOnDoneDeps {
  brag?: ReturnType<typeof bragService>;
  now?: () => Date;
}

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Markdown -> short plain sentences fit for a title card. */
export function summarySnippetsFromMarkdown(markdown: string, max: number): string[] {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~>|]/g, " ");
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const clean = sentence.replace(/\s+/g, " ").trim();
      if (clean.length < 12) continue;
      out.push(clean.length > MAX_SNIPPET_CHARS ? `${clean.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…` : clean);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function bragOnDoneService(db: Db, deps: BragOnDoneDeps = {}) {
  const brag = deps.brag ?? bragService(db);
  const issuesSvc = issueService(db);
  const interactions = issueThreadInteractionService(db);
  const nowOf = () => (deps.now ? deps.now() : new Date());

  async function loadIssue(companyId: string, issueId: string): Promise<IssueRow> {
    const row = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Task not found");
    return row;
  }

  async function loadCompanySetting(companyId: string) {
    const row = await db
      .select({ enabled: companies.bragOnDoneEnabled, maxCostCents: companies.bragOnDoneMaxCostCents })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Company not found");
    return row;
  }

  /** Merges fields into the stored pre-approval (never touches triggeredAt once set). */
  async function patchPreapproval(issueId: string, patch: Partial<IssueBragPreapproval>) {
    await db
      .update(issues)
      .set({ bragPreapproval: sql`coalesce(${issues.bragPreapproval}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(issues.id, issueId));
  }

  async function comment(issueId: string, body: string) {
    try {
      await issuesSvc.addComment(issueId, body, {}, { authorType: "system" });
    } catch (err) {
      logger.warn({ err, issueId }, "brag-on-done: could not post the task comment");
    }
  }

  async function finish(issue: IssueRow, outcome: BragOnDoneOutcome, message: string, extra: Partial<IssueBragPreapproval> = {}) {
    await patchPreapproval(issue.id, { outcome, outcomeMessage: message, ...extra });
    await comment(issue.id, message);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: BRAG_ON_DONE_ORIGIN,
      action: `issue.brag_on_done_${outcome}`,
      entityType: "issue",
      entityId: issue.id,
      details: { identifier: issue.identifier, bragJobId: extra.bragJobId ?? null, message },
    });
  }

  /** The task's own outcome: its title plus the last real comment, else work products, else the description. */
  async function buildMaterial(issue: IssueRow): Promise<BragTaskMaterial> {
    const maxSnippets = Math.max(1, bragSceneCount(BRAG_ON_DONE_LENGTH_SECONDS) - 1);
    const lastComment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, issue.id),
        eq(issueComments.companyId, issue.companyId),
        isNull(issueComments.deletedAt),
        sql`coalesce(${issueComments.authorType}, '') <> 'system'`,
      ))
      .orderBy(desc(issueComments.createdAt))
      .limit(1)
      .then((r) => r[0] ?? null);
    let snippets = lastComment ? summarySnippetsFromMarkdown(lastComment.body, maxSnippets) : [];
    if (snippets.length === 0) {
      const products = await db
        .select({ title: issueWorkProducts.title, summary: issueWorkProducts.summary })
        .from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.issueId, issue.id), eq(issueWorkProducts.companyId, issue.companyId)))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt))
        .limit(maxSnippets);
      snippets = products
        .flatMap((p) => [p.title, ...(p.summary ? summarySnippetsFromMarkdown(p.summary, 2) : [])])
        .filter((t) => t.trim().length > 0)
        .slice(0, maxSnippets);
    }
    if (snippets.length === 0 && issue.description) {
      snippets = summarySnippetsFromMarkdown(issue.description, maxSnippets);
    }
    return { title: `Done: ${issue.title}`.slice(0, MAX_SNIPPET_CHARS), snippets };
  }

  async function leaveOverCapCard(issue: IssueRow, jobId: string, costCents: number, capCents: number) {
    try {
      await interactions.create(
        { id: issue.id, companyId: issue.companyId },
        {
          kind: "request_confirmation",
          title: "Make the brag video anyway?",
          summary: `The video for this task would cost about ${dollars(costCents)}, more than the ${dollars(capCents)} that was allowed when the box was ticked.`,
          continuationPolicy: "none",
          neverExpires: true,
          idempotencyKey: `${BRAG_ON_DONE_OVER_CAP_CARD_KEY}:${jobId}`,
          payload: {
            version: 1,
            prompt: `Make the short brag video for this finished task? It would cost about ${dollars(costCents)}, which is more than the ${dollars(capCents)} allowed when the box was ticked.`,
            acceptLabel: "Make it",
            rejectLabel: "No video",
            allowDeclineReason: false,
            target: { type: "custom", key: BRAG_ON_DONE_OVER_CAP_CARD_KEY, revisionId: jobId, label: "Brag video" },
          },
        } as never,
        { agentId: null, userId: null },
      );
    } catch (err) {
      logger.warn({ err, issueId: issue.id, jobId }, "brag-on-done: could not create the over-cap question card");
    }
  }

  /**
   * Plans, approves every scene (the pre-approval stands in for the person's
   * scene check, but only while spend stays within capCents) and renders.
   * Returns the video file id, or null when it stopped for the cap.
   */
  async function planApproveRender(companyId: string, jobId: string, actor: BragActor, capCents: number) {
    const current = await brag.getJob(companyId, jobId);
    const planned = current.job.status === "draft" || current.job.status === "failed"
      ? await brag.planJob(companyId, jobId, actor)
      : current;
    if (planned.job.actualCostCents > capCents || planned.job.estimatedCostCents > capCents) return null;
    for (const scene of planned.scenes) {
      if (scene.approvalStatus === "pending") await brag.updateScene(companyId, jobId, scene.id, { action: "approve" });
    }
    const done = await brag.render(companyId, jobId, actor);
    const videoFileId = ((done.job.options ?? {}) as { videoFileId?: string }).videoFileId ?? null;
    return { videoFileId, costCents: done.job.actualCostCents };
  }

  function failureText(err: unknown): string {
    if (err instanceof HttpError && err.status < 500) return err.message;
    return "Something went wrong while making it.";
  }

  async function runJob(issue: IssueRow, jobId: string, actor: BragActor, capCents: number) {
    try {
      const result = await planApproveRender(issue.companyId, jobId, actor, capCents);
      if (!result) {
        const job = await brag.getJob(issue.companyId, jobId);
        await leaveOverCapCard(issue, jobId, Math.max(job.job.estimatedCostCents, job.job.actualCostCents), capCents);
        await finish(issue, "over_cap", `The brag video was not made yet: it would cost more than the ${dollars(capCents)} allowed. Answer the question below to make it anyway.`, { bragJobId: jobId });
        return "over_cap" as const;
      }
      const link = result.videoFileId ? `[Watch the brag video](/api/attachments/${result.videoFileId}/content)` : "The brag video is attached to this task.";
      await finish(issue, "completed", `Your short brag video for this task is ready. ${link} (cost ${dollars(result.costCents)})`, {
        bragJobId: jobId,
        videoFileId: result.videoFileId,
      });
      return "completed" as const;
    } catch (err) {
      logger.warn({ err, issueId: issue.id, jobId }, "brag-on-done: video failed");
      await finish(issue, "failed", `The brag video for this task could not be made. ${failureText(err)}`, { bragJobId: jobId });
      return "failed" as const;
    }
  }

  const TURNED_OFF_MESSAGE = "Brag videos for finished tasks are turned off for this company. An owner or admin can turn them on in Company settings.";

  return {
    /** Refuses (422) when the company has the feature switched off. */
    async assertEnabled(companyId: string) {
      const setting = await loadCompanySetting(companyId);
      if (!setting.enabled) throw unprocessable(TURNED_OFF_MESSAGE);
    },

    /**
     * Person-only setter for the tick box. The caller (an issue route) has
     * already refused agents; this re-checks the rules that hold for people.
     */
    async setPreapproval(input: { companyId: string; issueId: string; userId: string; enabled: boolean; allowDoneTask?: boolean }) {
      const issue = await loadIssue(input.companyId, input.issueId);
      const existing = issue.bragPreapproval ?? null;
      if (existing?.triggeredAt) {
        throw conflict("A brag video was already started for this task, so this choice can no longer be changed.");
      }
      if (!input.allowDoneTask && issue.status === "done") {
        throw conflict("This task is already done. The brag video choice can only be changed before a task is finished.");
      }
      if (!input.enabled) {
        if (!existing) return null;
        await db
          .update(issues)
          .set({ bragPreapproval: null })
          .where(and(eq(issues.id, issue.id), sql`(${issues.bragPreapproval} ->> 'triggeredAt') is null`));
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "user",
          actorId: input.userId,
          action: "issue.brag_on_done_withdrawn",
          entityType: "issue",
          entityId: issue.id,
          details: { identifier: issue.identifier },
        });
        return null;
      }
      const setting = await loadCompanySetting(input.companyId);
      if (!setting.enabled) throw unprocessable(TURNED_OFF_MESSAGE);
      const record: IssueBragPreapproval = {
        approvedByUserId: input.userId,
        approvedAt: nowOf().toISOString(),
        maxCostCents: resolveBragOnDoneMaxCostCents(setting.maxCostCents),
        lengthSeconds: BRAG_ON_DONE_LENGTH_SECONDS,
      };
      const updated = await db
        .update(issues)
        .set({ bragPreapproval: record })
        .where(and(
          eq(issues.id, issue.id),
          sql`(${issues.bragPreapproval} is null or (${issues.bragPreapproval} ->> 'triggeredAt') is null)`,
        ))
        .returning({ id: issues.id });
      if (updated.length === 0) {
        throw conflict("A brag video was already started for this task, so this choice can no longer be changed.");
      }
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: input.userId,
        action: "issue.brag_on_done_approved",
        entityType: "issue",
        entityId: issue.id,
        details: { identifier: issue.identifier, maxCostCents: record.maxCostCents },
      });
      return record;
    },

    /**
     * Claims one done task's pre-approval (exactly once, ever) and makes the
     * video. Returns null when there was nothing to do.
     */
    async processIssue(companyId: string, issueId: string): Promise<BragOnDoneOutcome | null> {
      // A person answered "make it anyway" on the over-cap card: run that job once, as them.
      const resumed = await db
        .update(issues)
        .set({ bragPreapproval: sql`${issues.bragPreapproval} || ${JSON.stringify({ outcome: "running" })}::jsonb` })
        .where(and(
          eq(issues.id, issueId),
          eq(issues.companyId, companyId),
          sql`(${issues.bragPreapproval} ->> 'outcome') = 'accepted'`,
        ))
        .returning();
      if (resumed[0]) {
        const issue = resumed[0];
        const pre = issue.bragPreapproval as IssueBragPreapproval;
        if (!pre.bragJobId || !pre.acceptedByUserId) {
          await finish(issue, "failed", "The brag video for this task could not be made. Its saved details were incomplete.");
          return "failed";
        }
        return runJob(issue, pre.bragJobId, { userId: pre.acceptedByUserId, agentId: null }, pre.acceptedMaxCostCents ?? pre.maxCostCents);
      }

      const triggeredAt = nowOf().toISOString();
      const claimed = await db
        .update(issues)
        .set({ bragPreapproval: sql`${issues.bragPreapproval} || ${JSON.stringify({ triggeredAt, outcome: "running" })}::jsonb` })
        .where(and(
          eq(issues.id, issueId),
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          sql`${issues.bragPreapproval} is not null`,
          sql`(${issues.bragPreapproval} ->> 'triggeredAt') is null`,
        ))
        .returning();
      const issue = claimed[0];
      if (!issue) return null;
      const pre = issue.bragPreapproval as IssueBragPreapproval;

      const setting = await loadCompanySetting(companyId);
      if (!setting.enabled) {
        await finish(issue, "turned_off", "No brag video was made: brag videos for finished tasks are turned off in Company settings.");
        return "turned_off";
      }

      // The person who ticked the box is the actor for every pipeline step and every cost record.
      const actor: BragActor = { userId: pre.approvedByUserId, agentId: null };
      const capCents = pre.maxCostCents;
      try {
        const material = await buildMaterial(issue);
        const job = await brag.createTaskJob(companyId, actor, {
          issueId: issue.id,
          projectId: issue.projectId ?? null,
          lengthSeconds: pre.lengthSeconds || BRAG_ON_DONE_LENGTH_SECONDS,
          material,
          origin: BRAG_ON_DONE_ORIGIN,
        });
        await patchPreapproval(issue.id, { bragJobId: job.id });
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: BRAG_ON_DONE_ORIGIN,
          action: "issue.brag_on_done_started",
          entityType: "issue",
          entityId: issue.id,
          details: { identifier: issue.identifier, bragJobId: job.id, approvedByUserId: pre.approvedByUserId, maxCostCents: capCents },
        });
        if (job.estimatedCostCents > capCents) {
          await leaveOverCapCard(issue, job.id, job.estimatedCostCents, capCents);
          await finish(issue, "over_cap", `The brag video was not made yet: it would cost about ${dollars(job.estimatedCostCents)}, more than the ${dollars(capCents)} allowed. Answer the question below to make it anyway.`, { bragJobId: job.id });
          return "over_cap";
        }
        return await runJob(issue, job.id, actor, capCents);
      } catch (err) {
        logger.warn({ err, issueId }, "brag-on-done: could not start the video");
        await finish(issue, "failed", `The brag video for this task could not be made. ${failureText(err)}`);
        return "failed";
      }
    },

    /** Scheduler sweep: done tasks with an unused pre-approval, a few at a time, across companies. */
    async tick(limit = TICK_BATCH) {
      const due = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(and(
          sql`${issues.bragPreapproval} is not null`,
          sql`((${issues.bragPreapproval} ->> 'triggeredAt') is null or (${issues.bragPreapproval} ->> 'outcome') = 'accepted')`,
          sql`(${issues.status} = 'done' or (${issues.bragPreapproval} ->> 'outcome') = 'accepted')`,
        ))
        .limit(limit);
      const counts: Record<BragOnDoneOutcome, number> = { running: 0, accepted: 0, completed: 0, failed: 0, over_cap: 0, turned_off: 0 };
      for (const row of due) {
        try {
          const outcome = await this.processIssue(row.companyId, row.id);
          if (outcome) counts[outcome] += 1;
        } catch (err) {
          logger.error({ err, issueId: row.id }, "brag-on-done: tick failed for a task");
        }
      }
      return { checked: due.length, ...counts };
    },

    /**
     * A person accepted the "make it anyway" card. Only honoured for the card
     * this service created (no agent or user author) and for the job the
     * task's pre-approval points at. This only records the person's answer
     * (quick, inside their request); the scheduler sweep then makes the video
     * with the accepting person as the actor and the job's own estimate as
     * the raised cap. Returns true when the answer was recorded.
     */
    async acceptOverCap(input: {
      issue: { id: string; companyId: string };
      interaction: { kind: string; status: string; createdByAgentId?: string | null; createdByUserId?: string | null; payload?: unknown };
      userId: string;
    }): Promise<boolean> {
      const { interaction } = input;
      if (interaction.kind !== "request_confirmation" || interaction.status !== "accepted") return false;
      if (interaction.createdByAgentId || interaction.createdByUserId) return false;
      const target = (interaction.payload as { target?: { type?: string; key?: string; revisionId?: string | null } } | null)?.target;
      if (target?.type !== "custom" || target.key !== BRAG_ON_DONE_OVER_CAP_CARD_KEY || !target.revisionId) return false;
      const issue = await loadIssue(input.issue.companyId, input.issue.id);
      const pre = issue.bragPreapproval;
      if (!pre || pre.bragJobId !== target.revisionId || pre.outcome !== "over_cap") return false;
      const job = await brag.getJob(issue.companyId, target.revisionId);
      const patch: Partial<IssueBragPreapproval> = {
        outcome: "accepted",
        acceptedByUserId: input.userId,
        acceptedMaxCostCents: Math.max(pre.maxCostCents, job.job.estimatedCostCents),
      };
      const claimed = await db
        .update(issues)
        .set({ bragPreapproval: sql`${issues.bragPreapproval} || ${JSON.stringify(patch)}::jsonb` })
        .where(and(
          eq(issues.id, issue.id),
          eq(issues.companyId, issue.companyId),
          sql`(${issues.bragPreapproval} ->> 'outcome') = 'over_cap'`,
        ))
        .returning({ id: issues.id });
      if (claimed.length === 0) return false;
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: input.userId,
        action: "issue.brag_on_done_over_cap_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: { identifier: issue.identifier, bragJobId: target.revisionId, maxCostCents: patch.acceptedMaxCostCents },
      });
      return true;
    },
  };
}
