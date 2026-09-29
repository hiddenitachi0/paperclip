// DUR-4062: the background job engine for video and audio generation.
//
// A tool call has a hard host-side timeout (150s; server/src/services/
// plugin-tool-registry.ts PLUGIN_TOOL_CALL_TIMEOUT_MS) and video generation
// can take minutes, so a video/audio tool cannot make and wait for its
// result the way generate-image does. Instead:
//   1. The tool call starts the provider's job (fast: a queue submit or a
//      workflow start) and returns right away with a job id.
//   2. A scheduled plugin job (jobs.schedule, "*/1 * * * *") calls
//      advanceMediaJobs() on every tick; it polls every job still running,
//      and on completion downloads the result and delivers it.
//
// Job records are plugin entities (ctx.entities), not plugin state: a
// scheduled job has no company id of its own (PluginJobContext carries only
// jobKey/runId/trigger/scheduledAt — see plugin-sdk's types.ts), so the
// company id for each job is read back out of the job's own record. Entities
// are upserted by a stable externalId (composeExternalId) so a repeat poll
// updates the same record instead of creating a new one on every tick — see
// PluginEntityUpsert in the SDK: without externalId, upsert always inserts.
//
// Delivery lands in the company's Files, never as a direct issue attachment:
// ctx.issues.createAttachment requires the calling run to be the issue's
// *current* checkout owner (plugin-sdk types.ts, createAttachment's own
// doc comment), which a background job tick never is (the tool-call run
// that started the job is long finished by the time a video completes). When
// the job started with an issueId, a plain comment is posted there instead,
// linking to the file and waking the assignee — see deliverResult().

import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import type { MediaKind } from "./media-provider.js";
import type { MediaJobHandle, MediaJobInput, MediaJobProvider, MediaJobResult, MediaPollOutcome } from "./media-jobs-types.js";
import { FalVideoProvider, SogniVideoProvider } from "./video.js";
import { FalAudioProvider } from "./audio.js";
import { guardedTransferFetch, SOGNI_TOKEN_TYPES, type SogniTokenType } from "./sogni.js";

export const MEDIA_JOB_ENTITY_TYPE = "media-generation-job";
export const JOB_KEY_MEDIA_POLL = "media-generation-poll";
/** Once a minute: video/audio jobs take minutes, not seconds, so there is no benefit to a tighter tick. */
export const MEDIA_POLL_SCHEDULE = "*/1 * * * *";
/** A job that has not finished after this long is given up on and reported as failed (well past any single provider's own timeout). */
export const MEDIA_JOB_MAX_AGE_MS = 30 * 60 * 1000;
const MEDIA_JOB_LIST_LIMIT = 200;

export type MediaJobStatus = "running" | "done" | "failed";

export interface MediaJobData {
  kind: MediaKind;
  provider: string;
  model: string;
  externalId: string;
  prompt: string;
  mode?: "music" | "speech";
  issueId: string | null;
  agentId: string;
  companyId: string;
  createdAt: string;
  updatedAt: string;
  progress: string | null;
  resultFileId: string | null;
  error: string | null;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function composeExternalId(data: Pick<MediaJobData, "kind" | "provider" | "externalId">): string {
  return `${data.kind}:${data.provider}:${data.externalId}`;
}

async function resolveMediaSecrets(
  ctx: PluginContext,
  cfg: Record<string, unknown>,
  providerId: string,
): Promise<{ falKey?: string; sogniKey?: string }> {
  if (providerId === "fal") {
    const ref = textOrUndefined(cfg.falKeySecretRef);
    if (!ref) throw new Error("Set the Fal.ai API key secret reference in Media Studio settings.");
    return { falKey: await ctx.secrets.resolve(ref) };
  }
  if (providerId === "sogni") {
    const ref = textOrUndefined(cfg.sogniKeySecretRef);
    if (!ref) throw new Error("Pick the Sogni API key in Media Studio settings (it comes from the company's Secrets).");
    return { sogniKey: await ctx.secrets.resolve(ref) };
  }
  throw new Error(`"${providerId}" does not make video or audio.`);
}

function buildMediaProvider(
  ctx: PluginContext,
  kind: MediaKind,
  providerId: string,
  cfg: Record<string, unknown>,
  secrets: { falKey?: string; sogniKey?: string },
): MediaJobProvider {
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  if (kind === "video") {
    if (providerId === "fal") {
      if (!secrets.falKey) throw new Error("Set the Fal.ai API key secret reference in Media Studio settings.");
      return new FalVideoProvider(secrets.falKey, fetchImpl, textOrUndefined(cfg.falVideoModel), textOrUndefined(cfg.falImageToVideoModel));
    }
    if (providerId === "sogni") {
      if (!secrets.sogniKey) throw new Error("Pick the Sogni API key in Media Studio settings.");
      const tokenType = (SOGNI_TOKEN_TYPES as readonly string[]).includes(String(cfg.sogniTokenType))
        ? (cfg.sogniTokenType as SogniTokenType)
        : "auto";
      return new SogniVideoProvider({
        apiKey: secrets.sogniKey,
        apiFetch: fetchImpl,
        transferFetch: guardedTransferFetch,
        defaultModel: textOrUndefined(cfg.sogniVideoModel),
        tokenType,
      });
    }
  }
  if (kind === "audio" && providerId === "fal") {
    if (!secrets.falKey) throw new Error("Set the Fal.ai API key secret reference in Media Studio settings.");
    return new FalAudioProvider(secrets.falKey, fetchImpl, textOrUndefined(cfg.falMusicModel), textOrUndefined(cfg.falSpeechModel));
  }
  throw new Error(`"${providerId}" does not make ${kind}.`);
}

/** Start a video/audio job: call the provider, then remember it as a plugin entity the poll tick will advance. Call ctx.personas.reserveDailyGeneration *before* this, same as generate-image. */
export async function startMediaJob(
  ctx: PluginContext,
  runCtx: { agentId: string; runId: string; companyId: string },
  kind: MediaKind,
  providerId: string,
  jobInput: MediaJobInput,
  issueId: string | null,
): Promise<{ jobId: string; provider: string; model: string }> {
  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const secrets = await resolveMediaSecrets(ctx, cfg, providerId);
  const provider = buildMediaProvider(ctx, kind, providerId, cfg, secrets);
  const handle = await provider.start(jobInput);
  const now = new Date().toISOString();
  const data: MediaJobData = {
    kind,
    provider: handle.provider,
    model: handle.model,
    externalId: handle.externalId,
    prompt: jobInput.prompt,
    mode: jobInput.mode,
    issueId,
    agentId: runCtx.agentId,
    companyId: runCtx.companyId,
    createdAt: now,
    updatedAt: now,
    progress: null,
    resultFileId: null,
    error: null,
  };
  const record = await ctx.entities.upsert({
    entityType: MEDIA_JOB_ENTITY_TYPE,
    scopeKind: "company",
    scopeId: runCtx.companyId,
    externalId: composeExternalId(data),
    status: "running",
    title: `${kind}: ${jobInput.prompt.slice(0, 60)}`,
    data: data as unknown as Record<string, unknown>,
  });
  return { jobId: record.id, provider: handle.provider, model: handle.model };
}

/** One company's own media jobs (for the check-media-job tool and tests): only the caller's own company/agent may read a job's status. */
export async function findOwnMediaJob(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
  jobId: string,
): Promise<PluginEntityRecord | null> {
  const records = await ctx.entities.list({ entityType: MEDIA_JOB_ENTITY_TYPE, scopeKind: "company", scopeId: companyId, limit: MEDIA_JOB_LIST_LIMIT });
  const record = records.find((r) => r.id === jobId);
  if (!record) return null;
  const data = record.data as unknown as MediaJobData;
  return data.agentId === agentId ? record : null;
}

const CONTENT_TYPE_PREFIX: Record<MediaKind, string> = { image: "image/", video: "video/", audio: "audio/" };

/** A media provider is expected to return the kind it was asked for; a misbehaving/compromised one must not smuggle another content type through the company Files allowlist. */
function assertMediaContentType(contentType: string, kind: MediaKind): string {
  const normalized = (contentType || "").trim().toLowerCase();
  if (!normalized.startsWith(CONTENT_TYPE_PREFIX[kind])) {
    throw new Error(`Provider returned a content type that is not ${kind}: "${contentType}"`);
  }
  return normalized;
}

const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s;

async function resultBytes(
  ctx: PluginContext,
  kind: MediaKind,
  result: MediaJobResult,
): Promise<{ contentBase64: string; contentType: string }> {
  if (result.dataUrl) {
    const match = DATA_URL_PATTERN.exec(result.dataUrl);
    if (!match?.[2]) throw new Error("Unrecognized (or non-base64) media data URL from provider");
    return { contentBase64: match[3]!, contentType: assertMediaContentType(match[1] || result.contentType, kind) };
  }
  if (result.url) {
    const response = await ctx.http.fetch(result.url);
    const bytes = await response.arrayBuffer();
    return {
      contentBase64: Buffer.from(bytes).toString("base64"),
      contentType: assertMediaContentType(response.headers?.get?.("content-type") || result.contentType, kind),
    };
  }
  throw new Error("Provider returned neither a url nor a dataUrl");
}

async function updateJob(ctx: PluginContext, record: PluginEntityRecord, status: MediaJobStatus, data: MediaJobData): Promise<void> {
  await ctx.entities.upsert({
    entityType: record.entityType,
    scopeKind: record.scopeKind,
    scopeId: record.scopeId ?? undefined,
    externalId: composeExternalId(data),
    status,
    title: record.title ?? undefined,
    data: data as unknown as Record<string, unknown>,
  });
}

async function failJob(ctx: PluginContext, record: PluginEntityRecord, data: MediaJobData, message: string): Promise<void> {
  const failed: MediaJobData = { ...data, error: message, updatedAt: new Date().toISOString() };
  await updateJob(ctx, record, "failed", failed);
  if (!data.issueId) return;
  try {
    await ctx.issues.createComment(data.issueId, `Could not make the ${data.kind}: ${message}`, data.companyId, { authorAgentId: data.agentId });
  } catch (err) {
    ctx.logger.warn(`media-studio: could not post the ${data.kind} failure to issue ${data.issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await ctx.issues.requestWakeup(data.issueId, data.companyId, { reason: "media-job-failed", actorAgentId: data.agentId });
  } catch {
    // The task may have moved on (done, cancelled, unassigned) since the job started; the comment above already said what happened.
  }
}

async function deliverResult(ctx: PluginContext, jobRunId: string, record: PluginEntityRecord, data: MediaJobData, result: MediaJobResult): Promise<void> {
  const { contentBase64, contentType } = await resultBytes(ctx, data.kind, result);
  const extension = contentType.split("/")[1]?.replace(/\+.*$/, "") ?? "bin";
  const filename = `${data.kind}-${data.provider}-${record.id.slice(0, 8)}.${extension}`;
  const file = await ctx.files.createCompanyFile({ contentBase64, contentType, filename }, data.companyId, { runId: jobRunId });
  const done: MediaJobData = { ...data, resultFileId: file.id, progress: "done", updatedAt: new Date().toISOString() };
  await updateJob(ctx, record, "done", done);
  if (!data.issueId) return;
  try {
    await ctx.issues.createComment(
      data.issueId,
      `Your ${data.kind} is ready: ${filename} — saved to the company's Files (id ${file.id}; it could not be attached to this task automatically, a task attachment needs a live run).`,
      data.companyId,
      { authorAgentId: data.agentId },
    );
  } catch (err) {
    ctx.logger.warn(`media-studio: could not post the finished ${data.kind} to issue ${data.issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await ctx.issues.requestWakeup(data.issueId, data.companyId, { reason: "media-job-complete", actorAgentId: data.agentId });
  } catch {
    // The task may have moved on since the job started; the comment above still delivered the result.
  }
}

async function advanceOne(ctx: PluginContext, jobRunId: string, record: PluginEntityRecord): Promise<void> {
  const data = record.data as unknown as MediaJobData;
  if (data.resultFileId) return; // Already delivered; nothing to do (defensive — should not happen once status flips to "done").

  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  let provider: MediaJobProvider;
  try {
    const secrets = await resolveMediaSecrets(ctx, cfg, data.provider);
    provider = buildMediaProvider(ctx, data.kind, data.provider, cfg, secrets);
  } catch (err) {
    await failJob(ctx, record, data, err instanceof Error ? err.message : String(err));
    return;
  }

  const handle: MediaJobHandle = { externalId: data.externalId, model: data.model, provider: data.provider };
  if (Date.now() - new Date(data.createdAt).getTime() > MEDIA_JOB_MAX_AGE_MS) {
    await provider.cancel(handle);
    await failJob(ctx, record, data, `Gave up after ${Math.round(MEDIA_JOB_MAX_AGE_MS / 60_000)} minutes without a result. Try again.`);
    return;
  }

  let outcome: MediaPollOutcome;
  try {
    outcome = await provider.poll(handle);
  } catch (err) {
    await failJob(ctx, record, data, err instanceof Error ? err.message : String(err));
    return;
  }

  if (outcome.status === "running") {
    await updateJob(ctx, record, "running", { ...data, progress: outcome.progress ?? data.progress, updatedAt: new Date().toISOString() });
    return;
  }
  if (outcome.status === "failed") {
    await failJob(ctx, record, data, outcome.error);
    return;
  }
  try {
    await deliverResult(ctx, jobRunId, record, data, outcome.result);
  } catch (err) {
    // The provider said "done" but the result could not be turned into a file
    // (e.g. a wrong/unsafe content type) — a clean failure, not a silent stall.
    await failJob(ctx, record, data, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The media-generation-poll job's own handler: advance every in-flight
 * video/audio job one step. Registered from worker.ts as
 * `ctx.jobs.register(JOB_KEY_MEDIA_POLL, (job) => advanceMediaJobs(ctx, job.runId))`.
 * One failing job is logged and skipped; it never stops the others.
 */
export async function advanceMediaJobs(ctx: PluginContext, jobRunId: string): Promise<void> {
  const records = await ctx.entities.list({ entityType: MEDIA_JOB_ENTITY_TYPE, limit: MEDIA_JOB_LIST_LIMIT });
  const running = records.filter((r) => r.status === "running");
  for (const record of running) {
    try {
      await advanceOne(ctx, jobRunId, record);
    } catch (err) {
      ctx.logger.warn(`media-studio: media job ${record.id} could not be advanced: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
