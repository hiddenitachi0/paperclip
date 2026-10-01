import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyAgentRoles,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  jobPositions,
  jobRuns,
  jobTriggers,
  jobs,
} from "@paperclipai/db";
import type {
  CreateJob,
  CreateJobTrigger,
  Job,
  JobDetail,
  JobListItem,
  JobPositionSummary,
  JobTrigger,
  RunJob,
  UpdateJob,
  UpdateJobTrigger,
} from "@paperclipai/shared";
import { getBuiltinRoutineVariableValues, interpolateRoutineTemplate } from "@paperclipai/shared";
import { conflict, notFound, unauthorized, unprocessable } from "../errors.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { issueService } from "./issues.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { secretService } from "./secrets.js";
import { nextCronTickInTimeZone } from "./routines.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

type Actor = { agentId?: string | null; userId?: string | null; runId?: string | null };
type JobRow = typeof jobs.$inferSelect;
type JobTriggerRow = typeof jobTriggers.$inferSelect;

export const JOB_EXECUTION_ORIGIN_KIND = "job_execution";

function jobWebhookSecretConfigPath(secretId: string) {
  return `job_trigger_webhook_secret:${secretId}`;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    goalId: row.goalId,
    title: row.title,
    instructions: row.instructions,
    status: row.status as Job["status"],
    variables: row.variables,
    runMode: row.runMode as Job["runMode"],
    modelProfile: row.modelProfile,
    effort: row.effort,
    outputFormat: row.outputFormat,
    requiresApproval: row.requiresApproval,
    isBuiltin: row.isBuiltin,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toJobTrigger(row: JobTriggerRow): JobTrigger {
  return {
    id: row.id,
    companyId: row.companyId,
    jobId: row.jobId,
    kind: row.kind as JobTrigger["kind"],
    label: row.label,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt,
    lastFiredAt: row.lastFiredAt,
    publicId: row.publicId,
    signingMode: row.signingMode,
    replayWindowSec: row.replayWindowSec,
    emailMatchAddress: row.emailMatchAddress,
    lastResult: row.lastResult,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function jobService(
  db: Db,
  options: { heartbeat?: IssueAssignmentWakeupDeps; pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  async function getJobById(id: string): Promise<JobRow | null> {
    return db.select().from(jobs).where(eq(jobs.id, id)).then((rows) => rows[0] ?? null);
  }

  async function getTriggerById(id: string): Promise<JobTriggerRow | null> {
    return db.select().from(jobTriggers).where(eq(jobTriggers.id, id)).then((rows) => rows[0] ?? null);
  }

  async function getDetailInternal(id: string): Promise<JobDetail | null> {
    const row = await getJobById(id);
    if (!row) return null;
    const positions = await listPositionSummaries([id]);
    const triggers = await db.select().from(jobTriggers).where(eq(jobTriggers.jobId, id));
    return {
      ...toJob(row),
      positions: positions.get(id) ?? [],
      triggers: triggers.map(toJobTrigger),
    };
  }

  async function listPositionSummaries(jobIds: string[]): Promise<Map<string, JobPositionSummary[]>> {
    const map = new Map<string, JobPositionSummary[]>();
    if (jobIds.length === 0) return map;
    const rows = await db
      .select({
        jobId: jobPositions.jobId,
        id: companyAgentRoles.id,
        name: companyAgentRoles.name,
        key: companyAgentRoles.key,
      })
      .from(jobPositions)
      .innerJoin(companyAgentRoles, eq(companyAgentRoles.id, jobPositions.positionId))
      .where(inArray(jobPositions.jobId, jobIds));
    for (const row of rows) {
      const list = map.get(row.jobId) ?? [];
      list.push({ id: row.id, name: row.name, key: row.key });
      map.set(row.jobId, list);
    }
    return map;
  }

  async function assertPositionsInCompany(companyId: string, positionIds: string[]) {
    if (positionIds.length === 0) return;
    const rows = await db
      .select({ id: companyAgentRoles.id })
      .from(companyAgentRoles)
      .where(and(inArray(companyAgentRoles.id, positionIds), eq(companyAgentRoles.companyId, companyId)));
    if (rows.length !== new Set(positionIds).size) {
      throw unprocessable("One or more positions do not belong to this company");
    }
  }

  async function setPositionsInternal(companyId: string, jobId: string, positionIds: string[]) {
    await assertPositionsInCompany(companyId, positionIds);
    await db.delete(jobPositions).where(eq(jobPositions.jobId, jobId));
    if (positionIds.length > 0) {
      await db.insert(jobPositions).values(
        Array.from(new Set(positionIds)).map((positionId) => ({ companyId, jobId, positionId })),
      );
    }
  }

  async function createWebhookSecret(companyId: string, jobTriggerId: string, actor: Actor) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const providerId = getConfiguredSecretProvider();
    const name = `job-trigger-${jobTriggerId}-${crypto.randomBytes(6).toString("hex")}`;
    const provider = getSecretProvider(providerId);
    const prepared = await provider.createSecret({
      value: secretValue,
      externalRef: null,
      context: { companyId, secretKey: name, secretName: name, version: 1 },
    });

    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: name,
        name,
        provider: providerId,
        status: "active",
        managedMode: "paperclip_managed",
        externalRef: prepared.externalRef,
        providerMetadata: null,
        latestVersion: 1,
        description: `Webhook auth for job trigger ${jobTriggerId}`,
        lastRotatedAt: new Date(),
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: prepared.material,
      valueSha256: prepared.valueSha256,
      fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
      providerVersionRef: prepared.providerVersionRef ?? null,
      status: "current",
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
    });

    await db.insert(companySecretBindings).values({
      companyId,
      secretId: secret.id,
      targetType: "job",
      targetId: jobTriggerId,
      configPath: jobWebhookSecretConfigPath(secret.id),
    });

    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: JobTriggerRow, companyId: string) {
    if (!trigger.secretId) throw notFound("Job trigger secret not found");
    return secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", {
      consumerType: "job",
      consumerId: trigger.jobId,
      actorType: "system",
      actorId: null,
      configPath: jobWebhookSecretConfigPath(trigger.secretId),
    });
  }

  async function verifyWebhookTriggerAuth(
    trigger: JobTriggerRow,
    companyId: string,
    input: { authorizationHeader?: string | null; signatureHeader?: string | null; rawBody?: Buffer | null },
  ) {
    if (trigger.signingMode === "none") return;
    const secretValue = await resolveTriggerSecret(trigger, companyId);
    if (trigger.signingMode === "bearer" || !trigger.signingMode) {
      const expected = `Bearer ${secretValue}`;
      const provided = input.authorizationHeader?.trim() ?? "";
      const expectedBuf = Buffer.from(expected);
      const providedBuf = Buffer.alloc(expectedBuf.length);
      providedBuf.write(provided.slice(0, expectedBuf.length));
      const valid = provided.length === expected.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
      if (!valid) throw unauthorized();
      return;
    }
    // github_hmac / hmac-with-timestamp signing reuses the same primitive as
    // routine webhook triggers; kept to bearer-only for v1 jobs triggers since
    // no job integration needs the GitHub-style header yet (see PR notes).
    const rawBody = input.rawBody ?? Buffer.from("{}");
    const providedSignature = input.signatureHeader?.trim() ?? "";
    if (!providedSignature) throw unauthorized();
    const expectedHmac = crypto.createHmac("sha256", secretValue).update(rawBody).digest("hex");
    const normalized = providedSignature.replace(/^sha256=/, "");
    const valid =
      normalized.length === expectedHmac.length &&
      crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(expectedHmac));
    if (!valid) throw unauthorized();
  }

  function resolveFormValues(job: JobRow, formValues: Record<string, unknown> | null | undefined) {
    const resolved: Record<string, unknown> = {};
    for (const variable of job.variables) {
      const provided = formValues?.[variable.name];
      if (provided !== undefined && provided !== null && provided !== "") {
        resolved[variable.name] = provided;
        continue;
      }
      if (variable.required && variable.type !== "file_upload") {
        throw unprocessable(`Missing required job variable: ${variable.name}`);
      }
      resolved[variable.name] = variable.defaultValue ?? "";
    }
    return resolved;
  }

  async function dispatchJobRun(input: {
    job: JobRow;
    trigger: JobTriggerRow | null;
    source: "manual" | "api" | "telegram" | "schedule" | "webhook" | "email";
    runAgentId: string;
    formValues?: Record<string, unknown> | null;
    projectId?: string | null;
    idempotencyKey?: string | null;
    actor: Actor;
  }) {
    await assertAssignableAgent(db, input.job.companyId, input.runAgentId, { kind: "work" });

    if (input.idempotencyKey) {
      const existing = await db
        .select()
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.companyId, input.job.companyId),
            eq(jobRuns.jobId, input.job.id),
            eq(jobRuns.idempotencyKey, input.idempotencyKey),
          ),
        )
        .orderBy(desc(jobRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) return existing;
    }

    const resolvedVariables = resolveFormValues(input.job, input.formValues);
    const allVariables = { ...getBuiltinRoutineVariableValues(), ...resolvedVariables };
    const title = interpolateRoutineTemplate(input.job.title, allVariables) ?? input.job.title;
    const description = interpolateRoutineTemplate(input.job.instructions, allVariables);

    const [createdRun] = await db
      .insert(jobRuns)
      .values({
        companyId: input.job.companyId,
        jobId: input.job.id,
        triggerId: input.trigger?.id ?? null,
        runAgentId: input.runAgentId,
        source: input.source,
        status: "received",
        formValues: resolvedVariables,
        idempotencyKey: input.idempotencyKey ?? null,
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? null,
      })
      .returning();

    const modelProfile = input.job.modelProfile ?? (input.job.runMode === "quick_agent" ? "cheap" : null);
    const assigneeAdapterOverrides =
      modelProfile || input.job.effort
        ? {
            ...(modelProfile ? { modelProfile } : {}),
            ...(input.job.effort ? { adapterConfig: { effort: input.job.effort } } : {}),
          }
        : null;

    try {
      const createdIssue = await issueSvc.create(input.job.companyId, {
        projectId: input.projectId ?? input.job.projectId ?? null,
        goalId: input.job.goalId,
        title,
        description,
        status: "todo",
        priority: "medium",
        assigneeAgentId: input.runAgentId,
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? null,
        originKind: JOB_EXECUTION_ORIGIN_KIND,
        originId: input.job.id,
        originRunId: createdRun.id,
        assigneeAdapterOverrides,
      });

      await db
        .update(jobRuns)
        .set({ status: "dispatched", linkedIssueId: createdIssue.id, updatedAt: new Date() })
        .where(eq(jobRuns.id, createdRun.id));

      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: createdIssue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "job.dispatch",
        requestedByActorType: input.source === "schedule" ? "system" : undefined,
        rethrowOnError: true,
      });

      return { ...createdRun, status: "dispatched" as const, linkedIssueId: createdIssue.id };
    } catch (error) {
      await db
        .update(jobRuns)
        .set({
          status: "failed",
          failureReason: error instanceof Error ? error.message : "Failed to create task",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, createdRun.id));
      throw error;
    }
  }

  return {
    list: async (companyId: string, filters: { projectId?: string; agentId?: string } = {}): Promise<JobListItem[]> => {
      const conditions = [eq(jobs.companyId, companyId)];
      if (filters.projectId) conditions.push(eq(jobs.projectId, filters.projectId));
      let jobIdFilter: string[] | null = null;
      if (filters.agentId) {
        const agent = await db
          .select({ roleId: agents.roleId })
          .from(agents)
          .where(and(eq(agents.id, filters.agentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!agent?.roleId) return [];
        const rows = await db
          .select({ jobId: jobPositions.jobId })
          .from(jobPositions)
          .where(and(eq(jobPositions.companyId, companyId), eq(jobPositions.positionId, agent.roleId)));
        jobIdFilter = rows.map((row) => row.jobId);
        if (jobIdFilter.length === 0) return [];
      }
      if (jobIdFilter) conditions.push(inArray(jobs.id, jobIdFilter));
      const rows = await db
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt));
      const positions = await listPositionSummaries(rows.map((row) => row.id));
      return rows.map((row) => ({ ...toJob(row), positions: positions.get(row.id) ?? [] }));
    },

    get: async (id: string) => getJobById(id),

    getDetail: async (id: string): Promise<JobDetail | null> => getDetailInternal(id),

    create: async (companyId: string, data: CreateJob, actor: Actor): Promise<JobDetail> => {
      const { positionIds, ...jobData } = data;
      await assertPositionsInCompany(companyId, positionIds);
      const [created] = await db
        .insert(jobs)
        .values({
          companyId,
          projectId: jobData.projectId ?? null,
          goalId: jobData.goalId ?? null,
          title: jobData.title,
          instructions: jobData.instructions ?? null,
          status: jobData.status,
          variables: jobData.variables,
          runMode: jobData.runMode,
          modelProfile: jobData.modelProfile ?? null,
          effort: jobData.effort ?? null,
          outputFormat: jobData.outputFormat ?? null,
          requiresApproval: jobData.requiresApproval,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();
      await setPositionsInternal(companyId, created.id, positionIds);
      return (await getDetailInternal(created.id)) as JobDetail;
    },

    update: async (id: string, data: UpdateJob, actor: Actor): Promise<JobDetail | null> => {
      const existing = await getJobById(id);
      if (!existing) return null;
      const { positionIds, ...jobData } = data;
      const patch: Partial<typeof jobs.$inferInsert> = {
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        updatedAt: new Date(),
      };
      if (jobData.projectId !== undefined) patch.projectId = jobData.projectId;
      if (jobData.goalId !== undefined) patch.goalId = jobData.goalId;
      if (jobData.title !== undefined) patch.title = jobData.title;
      if (jobData.instructions !== undefined) patch.instructions = jobData.instructions;
      if (jobData.status !== undefined) patch.status = jobData.status;
      if (jobData.variables !== undefined) patch.variables = jobData.variables;
      if (jobData.runMode !== undefined) patch.runMode = jobData.runMode;
      if (jobData.modelProfile !== undefined) patch.modelProfile = jobData.modelProfile;
      if (jobData.effort !== undefined) patch.effort = jobData.effort;
      if (jobData.outputFormat !== undefined) patch.outputFormat = jobData.outputFormat;
      if (jobData.requiresApproval !== undefined) patch.requiresApproval = jobData.requiresApproval;
      await db.update(jobs).set(patch).where(eq(jobs.id, id));
      if (positionIds !== undefined) {
        await setPositionsInternal(existing.companyId, id, positionIds);
      }
      return getDetailInternal(id);
    },

    setPositions: async (id: string, positionIds: string[], _actor: Actor): Promise<JobDetail | null> => {
      const existing = await getJobById(id);
      if (!existing) return null;
      await setPositionsInternal(existing.companyId, id, positionIds);
      return getDetailInternal(id);
    },

    getTrigger: async (id: string) => getTriggerById(id),

    createTrigger: async (jobId: string, data: CreateJobTrigger, actor: Actor) => {
      const job = await getJobById(jobId);
      if (!job) throw notFound("Job not found");
      const values: Partial<typeof jobTriggers.$inferInsert> = {
        companyId: job.companyId,
        jobId,
        kind: data.kind,
        label: data.label ?? null,
        enabled: data.enabled,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
      };
      if (data.kind === "schedule") {
        values.cronExpression = data.cronExpression;
        values.timezone = data.timezone;
        values.nextRunAt = nextCronTickInTimeZone(data.cronExpression, data.timezone, new Date());
      }
      if (data.kind === "webhook") {
        values.signingMode = data.signingMode;
        values.replayWindowSec = data.replayWindowSec;
        values.publicId = crypto.randomBytes(16).toString("hex");
      }
      if (data.kind === "email") {
        values.emailMatchAddress = data.emailMatchAddress;
      }
      const [created] = await db.insert(jobTriggers).values(values as typeof jobTriggers.$inferInsert).returning();
      let secretValue: string | null = null;
      if (data.kind === "webhook" && data.signingMode !== "none") {
        const result = await createWebhookSecret(job.companyId, created.id, actor);
        await db.update(jobTriggers).set({ secretId: result.secret.id }).where(eq(jobTriggers.id, created.id));
        secretValue = result.secretValue;
        created.secretId = result.secret.id;
      }
      return { trigger: toJobTrigger(created), secretValue };
    },

    updateTrigger: async (id: string, data: UpdateJobTrigger, actor: Actor) => {
      const existing = await getTriggerById(id);
      if (!existing) return null;
      const patch: Partial<typeof jobTriggers.$inferInsert> = {
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        updatedAt: new Date(),
      };
      if (data.label !== undefined) patch.label = data.label;
      if (data.enabled !== undefined) patch.enabled = data.enabled;
      if (data.cronExpression !== undefined) patch.cronExpression = data.cronExpression;
      if (data.timezone !== undefined) patch.timezone = data.timezone;
      if (data.signingMode !== undefined) patch.signingMode = data.signingMode;
      if (data.replayWindowSec !== undefined) patch.replayWindowSec = data.replayWindowSec;
      if (data.emailMatchAddress !== undefined) patch.emailMatchAddress = data.emailMatchAddress;
      if (existing.kind === "schedule" && (data.cronExpression !== undefined || data.timezone !== undefined)) {
        const cron = data.cronExpression ?? existing.cronExpression;
        const tz = data.timezone ?? existing.timezone;
        if (cron && tz) patch.nextRunAt = nextCronTickInTimeZone(cron, tz, new Date());
      }
      const [updated] = await db.update(jobTriggers).set(patch).where(eq(jobTriggers.id, id)).returning();
      return toJobTrigger(updated);
    },

    deleteTrigger: async (id: string) => {
      await db.delete(jobTriggers).where(eq(jobTriggers.id, id));
    },

    listRuns: async (jobId: string, limit = 50) => {
      return db
        .select()
        .from(jobRuns)
        .where(eq(jobRuns.jobId, jobId))
        .orderBy(desc(jobRuns.createdAt))
        .limit(limit);
    },

    runJob: async (jobId: string, input: RunJob, actor: Actor) => {
      const job = await getJobById(jobId);
      if (!job) throw notFound("Job not found");
      if (job.status !== "active") throw conflict("Job is archived");
      let trigger: JobTriggerRow | null = null;
      if (input.triggerId) {
        trigger = await getTriggerById(input.triggerId);
        if (!trigger || trigger.jobId !== jobId) throw notFound("Job trigger not found");
      }
      return dispatchJobRun({
        job,
        trigger,
        source: input.source,
        runAgentId: input.runAgentId,
        formValues: input.formValues,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        actor,
      });
    },

    firePublicTrigger: async (
      publicId: string,
      input: { authorizationHeader?: string | null; signatureHeader?: string | null; rawBody?: Buffer | null; payload?: Record<string, unknown> | null },
    ) => {
      const trigger = await db
        .select()
        .from(jobTriggers)
        .where(and(eq(jobTriggers.publicId, publicId), eq(jobTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Job trigger not found");
      const job = await getJobById(trigger.jobId);
      if (!job) throw notFound("Job not found");
      if (!trigger.enabled || job.status !== "active") throw conflict("Job trigger is not active");
      await verifyWebhookTriggerAuth(trigger, job.companyId, input);

      const positions = await db
        .select({ positionId: jobPositions.positionId })
        .from(jobPositions)
        .where(eq(jobPositions.jobId, job.id));
      const positionIds = positions.map((row) => row.positionId);
      if (positionIds.length === 0) throw unprocessable("Job has no linked position to run as");
      const runAgent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, job.companyId), inArray(agents.roleId, positionIds)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!runAgent) throw unprocessable("No agent currently holds a position linked to this job");

      await db.update(jobTriggers).set({ lastFiredAt: new Date() }).where(eq(jobTriggers.id, trigger.id));
      return dispatchJobRun({
        job,
        trigger,
        source: "webhook",
        runAgentId: runAgent.id,
        formValues: (input.payload as Record<string, unknown> | null) ?? null,
        actor: {},
      });
    },

    // DUR-4142: wires job "email" triggers (DUR-4182 added the column,
    // `emailMatchAddress`, as match-configuration storage only -- see
    // packages/db/src/schema/jobs.ts) to the mail secretary's inbound-mail
    // pipeline. mail-secretary.ts calls this once per fetched message with
    // the inbox's own IMAP address (the only "address" a message carries --
    // the IMAP client never parses a To: header), already run through
    // frameDelegatedMailContent so any injection attempt in the mail body
    // cannot be read as instructions. A job opts in to the content by
    // declaring variables named email_from/email_subject/email_body;
    // resolveFormValues ignores undeclared keys, so this is a no-op for any
    // other job accidentally sharing an email trigger address.
    fireEmailJobTriggers: async (
      companyId: string,
      inboxAddress: string,
      message: { from: string; subject: string; bodyText: string; messageId: string | null },
    ): Promise<number> => {
      const normalizedAddress = inboxAddress.trim().toLowerCase();
      if (!normalizedAddress) return 0;
      const triggers = await db
        .select()
        .from(jobTriggers)
        .where(
          and(
            eq(jobTriggers.companyId, companyId),
            eq(jobTriggers.kind, "email"),
            eq(jobTriggers.enabled, true),
            sql`lower(trim(${jobTriggers.emailMatchAddress})) = ${normalizedAddress}`,
          ),
        );
      let fired = 0;
      for (const trigger of triggers) {
        const job = await getJobById(trigger.jobId);
        if (!job || job.status !== "active") continue;
        const positions = await db
          .select({ positionId: jobPositions.positionId })
          .from(jobPositions)
          .where(eq(jobPositions.jobId, job.id));
        const positionIds = positions.map((row) => row.positionId);
        const runAgent = positionIds.length
          ? await db
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.companyId, companyId), inArray(agents.roleId, positionIds)))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        await db.update(jobTriggers).set({ lastFiredAt: new Date() }).where(eq(jobTriggers.id, trigger.id));
        if (!runAgent) continue;
        try {
          await dispatchJobRun({
            job,
            trigger,
            source: "email",
            runAgentId: runAgent.id,
            formValues: {
              email_from: message.from,
              email_subject: message.subject,
              email_body: message.bodyText,
            },
            idempotencyKey: message.messageId ? `email-trigger:${trigger.id}:${message.messageId}` : null,
            actor: {},
          });
          fired += 1;
        } catch (err) {
          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "job-email-trigger",
            action: "job.email_run_failed",
            entityType: "job_trigger",
            entityId: trigger.id,
            details: { jobId: job.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      return fired;
    },

    // Mirrors routines' `tickScheduledTriggers` at a much smaller scope: jobs
    // have no concurrency policy or catch-up-run limit (a one-press job is
    // meant to run exactly once per due tick, assigned to whichever agent
    // currently holds a linked position), so this only needs to find due
    // schedule triggers, pick a holder, dispatch, and roll nextRunAt forward.
    tickScheduledJobTriggers: async (now: Date) => {
      const due = await db
        .select()
        .from(jobTriggers)
        .where(
          and(
            eq(jobTriggers.kind, "schedule"),
            eq(jobTriggers.enabled, true),
            or(isNull(jobTriggers.nextRunAt), lte(jobTriggers.nextRunAt, now)),
          ),
        );
      let enqueued = 0;
      for (const trigger of due) {
        const job = await getJobById(trigger.jobId);
        const nextRunAt =
          trigger.cronExpression && trigger.timezone
            ? nextCronTickInTimeZone(trigger.cronExpression, trigger.timezone, now)
            : null;
        if (!job || job.status !== "active") {
          await db.update(jobTriggers).set({ nextRunAt }).where(eq(jobTriggers.id, trigger.id));
          continue;
        }
        const positions = await db
          .select({ positionId: jobPositions.positionId })
          .from(jobPositions)
          .where(eq(jobPositions.jobId, job.id));
        const positionIds = positions.map((row) => row.positionId);
        const runAgent = positionIds.length
          ? await db
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.companyId, job.companyId), inArray(agents.roleId, positionIds)))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        await db
          .update(jobTriggers)
          .set({ nextRunAt, lastFiredAt: new Date() })
          .where(eq(jobTriggers.id, trigger.id));
        if (!runAgent) continue;
        try {
          await dispatchJobRun({ job, trigger, source: "schedule", runAgentId: runAgent.id, actor: {} });
          enqueued += 1;
        } catch (err) {
          await logActivity(db, {
            companyId: job.companyId,
            actorType: "system",
            actorId: "job-scheduler",
            action: "job.scheduled_run_failed",
            entityType: "job_trigger",
            entityId: trigger.id,
            details: { jobId: job.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      return { enqueued };
    },
  };
}

export type JobService = ReturnType<typeof jobService>;
