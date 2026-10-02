import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, costEvents, mediaStudioDirectCreations } from "@paperclipai/db";
import {
  MEDIA_STUDIO_DIRECT_BILLING_CODE,
  MEDIA_STUDIO_DIRECT_REWRITE_BILLING_CODE,
  estimateMediaStudioDirectCostCents,
  type CreateMediaStudioDirectAudioInput,
  type CreateMediaStudioDirectPictureInput,
  type CreateMediaStudioDirectVideoInput,
  type MediaStudioDirectHistoryEntry,
  type MediaStudioDirectKind,
  type MediaStudioDirectRewritePromptInput,
} from "@paperclipai/shared";
import { notFound, tooManyRequests, unprocessable } from "../errors.js";
import { readAnthropicApiKey } from "../env-values.js";
import { normalizeContentType, isAllowedContentType, normalizeIssueAttachmentMaxBytes } from "../attachment-types.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { computeCostCents } from "./lane-a.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { secretService } from "./secrets.js";
import { costService } from "./costs.js";
import { issueService } from "./issues.js";
import { executePinnedHttpRequest, validateAndResolveFetchUrl } from "./safe-outbound-fetch.js";
import {
  FalDirectAudioProvider,
  FalDirectPictureProvider,
  type MediaStudioDirectJobHandle,
  type MediaStudioDirectMediaResult,
  type MediaStudioDirectPictureResult,
} from "./media-studio-direct-providers.js";
import { FalVideoProvider } from "./video-provider-clients.js";

/**
 * DUR-4329: Media Studio's Create tab direct generation -- a board
 * owner/admin/operator (never a viewer, never an agent) triggers the same
 * Fal provider actions agents already call, with an upfront cost estimate,
 * a company-budget + per-plugin-cap gate before anything is generated, and
 * the result saved to company storage. Built as plain Express-route-backed
 * services (not a plugin action) because the plugin ctx bridge's file-save
 * and daily-generation-limit capabilities are run-id/agent-id bound by
 * design (see ctx.files.createCompanyFile's own doc comment) -- there is no
 * run for a board user to supply one. video-storyline-render.ts solved the
 * same "board/agent-writable, DB-backed, no run" problem for video
 * storylines by duplicating the provider HTTP clients outside the plugin
 * sandbox; this follows the same shape. See
 * media-studio-direct-providers.ts's doc comment for why v1 ships Fal only.
 */

const MEDIA_STUDIO_PLUGIN_KEY = "paperclip.media-studio";
/** Config key read off the same instance-wide Media Studio plugin config as falKeySecretRef/sogniKeySecretRef (registry.getConfig) -- a ceiling on this new spend vector specifically, on top of (never instead of) each company's own budgetMonthlyCents. Unset or <= 0 means no extra cap. */
const DIRECT_CREATE_CAP_CONFIG_KEY = "directCreateMonthlyCapCents";

const VIDEO_POLL_TIMEOUT_MS = 150_000;
const AUDIO_POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const MEDIA_FETCH_TIMEOUT_MS = 60_000;
/** A direct-create clip/picture/clip-of-audio is short by construction (see the shared duration caps); this is a generous ceiling against a misbehaving provider, not a real-world size. */
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

const REWRITE_MODEL = "claude-sonnet-5";
const REWRITE_MAX_OUTPUT_TOKENS = 300;
/** Mirrors lane-a.ts's dailyCallCap shape for a cheap quick-model call -- this one has no configurable agent, so the cap is a fixed constant rather than a per-agent setting. */
const REWRITE_DAILY_CALL_CAP_PER_COMPANY = 50;

export interface MediaStudioDirectActor {
  userId: string;
}

async function safeFetch(url: string, init?: RequestInit, maxResponseBytes = MEDIA_MAX_BYTES): Promise<Response> {
  const target = await validateAndResolveFetchUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
  try {
    const pinned = await executePinnedHttpRequest(target, init, controller.signal, { maxResponseBytes });
    return new Response(new Uint8Array(pinned.bodyBytes), { status: pinned.status, statusText: pinned.statusText, headers: pinned.headers });
  } finally {
    clearTimeout(timeout);
  }
}

function assertContentTypePrefix(contentType: string, prefix: string, kind: string): string {
  const normalized = (contentType || "").trim().toLowerCase();
  if (!normalized.startsWith(prefix)) {
    throw new Error(`Provider returned a content type that is not ${kind}: "${contentType}"`);
  }
  return normalized;
}

const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s;

function extensionFor(contentType: string): string {
  return contentType.split("/")[1]?.replace(/\+.*$/, "") ?? "bin";
}

async function pictureResultBytes(result: MediaStudioDirectPictureResult): Promise<{ contentBase64: string; contentType: string }> {
  if (result.imageDataUrl) {
    const match = DATA_URL_PATTERN.exec(result.imageDataUrl);
    if (!match?.[3]) throw new Error("Unrecognized (or non-base64) image data URL from provider");
    return { contentBase64: match[3], contentType: assertContentTypePrefix(match[1] || result.contentType, "image/", "a picture") };
  }
  if (result.imageUrl) {
    const response = await safeFetch(result.imageUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      contentBase64: bytes.toString("base64"),
      contentType: assertContentTypePrefix(response.headers.get("content-type") || result.contentType, "image/", "a picture"),
    };
  }
  throw new Error("Provider returned neither a url nor a dataUrl");
}

async function mediaResultBytes(result: MediaStudioDirectMediaResult, prefix: string, kind: string): Promise<{ contentBase64: string; contentType: string }> {
  if (result.dataUrl) {
    const match = DATA_URL_PATTERN.exec(result.dataUrl);
    if (!match?.[3]) throw new Error(`Unrecognized (or non-base64) ${kind} data URL from provider`);
    return { contentBase64: match[3], contentType: assertContentTypePrefix(match[1] || result.contentType, prefix, kind) };
  }
  if (result.url) {
    const response = await safeFetch(result.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { contentBase64: bytes.toString("base64"), contentType: assertContentTypePrefix(response.headers.get("content-type") || result.contentType, prefix, kind) };
  }
  throw new Error("Provider returned neither a url nor a dataUrl");
}

interface PollableProvider {
  poll(handle: MediaStudioDirectJobHandle): Promise<{ status: "running" | "done" | "failed"; progress?: string; error?: string; result?: MediaStudioDirectMediaResult }>;
  cancel(handle: MediaStudioDirectJobHandle): Promise<void>;
}

/** Bounded synchronous poll, same shape as video-storyline-render.ts's renderPreview: a direct-create clip is short by construction (shared duration caps), so this answers within one HTTP request rather than handing back a job id to poll separately. */
async function pollUntilDone(provider: PollableProvider, handle: MediaStudioDirectJobHandle, timeoutMs: number): Promise<MediaStudioDirectMediaResult> {
  const deadline = Date.now() + timeoutMs;
  let outcome = await provider.poll(handle);
  while (outcome.status === "running") {
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    outcome = await provider.poll(handle);
  }
  if (outcome.status === "running") {
    try {
      await provider.cancel(handle);
    } catch {
      // Best effort -- the timeout is what the caller needs to hear about.
    }
    throw unprocessable("This did not finish in time. Try again in a moment.");
  }
  if (outcome.status === "failed") {
    throw unprocessable(`Could not make this: ${outcome.error ?? "unknown error"}`);
  }
  if (!outcome.result) throw new Error("Provider reported done with no result");
  return outcome.result;
}

export function mediaStudioDirectService(db: Db, deps: { now?: () => Date } = {}) {
  const registry = pluginRegistryService(db);
  const secrets = secretService(db);
  const costs = costService(db);
  const issues = issueService(db);
  const nowOf = () => deps.now?.() ?? new Date();

  async function getMediaStudioConfig(): Promise<Record<string, unknown>> {
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    if (!plugin) throw unprocessable("The media-studio plugin is not installed, so direct generation has no provider configured.");
    const config = await registry.getConfig(plugin.id);
    return (config?.configJson ?? {}) as Record<string, unknown>;
  }

  async function resolveFalApiKey(companyId: string, actorId: string): Promise<string> {
    const cfg = await getMediaStudioConfig();
    const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
    if (!ref) throw unprocessable("No Fal.ai API key is configured in Media Studio settings yet.");
    return secrets.resolveSecretValueForMediaStudioDirect(companyId, ref, { actorId });
  }

  async function directCreatePluginCapCents(): Promise<number | null> {
    const cfg = await getMediaStudioConfig();
    const raw = cfg[DIRECT_CREATE_CAP_CONFIG_KEY];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }

  function currentUtcMonthWindow(now = nowOf()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return { start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)), end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)) };
  }

  /** Instance-wide (no companyId filter): the per-plugin cap protects the shared Fal account regardless of which company spent against it. */
  async function directCreateMonthSpendCents(): Promise<number> {
    const { start, end } = currentUtcMonthWindow();
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
      .from(costEvents)
      .where(and(eq(costEvents.billingCode, MEDIA_STUDIO_DIRECT_BILLING_CODE), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)));
    return Number(row?.total ?? 0);
  }

  async function getCompanyRow(companyId: string) {
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!row) throw notFound("Company not found");
    return row;
  }

  /**
   * Two independent gates, in order: the company's own monthly budget (a
   * hard ceiling -- never overridable here, since it is a cross-feature
   * guardrail the rest of the company relies on too) and the Media Studio
   * plugin's own direct-create cap (confirmBudgetCapCents may override this
   * one for a single call, the same "support a confirmBudgetCapCents
   * override param" shape video-storyline-render.ts's startRender uses).
   */
  async function assertWithinBudget(companyId: string, estimateCents: number, confirmBudgetCapCents?: number): Promise<void> {
    const company = await getCompanyRow(companyId);
    if (company.budgetMonthlyCents > 0 && company.spentMonthlyCents + estimateCents > company.budgetMonthlyCents) {
      throw unprocessable(
        `This would cost about ${estimateCents} cents on top of ${company.spentMonthlyCents} cents already spent this month, over the company's ${company.budgetMonthlyCents}-cent monthly budget. Raise the company budget to continue.`,
        { reason: "company_budget", estimateCents, spentMonthlyCents: company.spentMonthlyCents, budgetMonthlyCents: company.budgetMonthlyCents },
      );
    }
    const capCents = confirmBudgetCapCents ?? (await directCreatePluginCapCents());
    if (capCents !== null) {
      const spentCents = await directCreateMonthSpendCents();
      if (spentCents + estimateCents > capCents) {
        throw unprocessable(
          `This would push Media Studio's direct-creation spend this month to ${spentCents + estimateCents} cents, over the ${capCents}-cent cap. Pass a higher confirmBudgetCapCents to proceed anyway, or ask an admin to raise the cap.`,
          { reason: "direct_create_cap", estimateCents, spentCents, capCents },
        );
      }
    }
  }

  async function saveResultFile(
    companyId: string,
    actor: MediaStudioDirectActor,
    contentBase64: string,
    contentType: string,
    filename: string,
  ) {
    const normalized = normalizeContentType(contentType);
    if (!isAllowedContentType(normalized)) throw unprocessable(`File type "${normalized}" is not allowed`);
    const buffer = Buffer.from(contentBase64, "base64");
    if (buffer.length <= 0) throw unprocessable("The generated file is empty");
    const company = await getCompanyRow(companyId);
    const maxBytes = normalizeIssueAttachmentMaxBytes(company.attachmentMaxBytes);
    if (buffer.length > maxBytes) throw unprocessable(`The generated file is larger than this company allows (${maxBytes} bytes)`);

    const stored = await getStorageService().putFile({ companyId, namespace: "media-studio-direct", originalFilename: filename, contentType: normalized, body: buffer });
    // Board-user file path (POST /api/companies/:companyId/files's own semantics): createdByUserId set, createdByAgentId null, never ctx.files.createCompanyFile (agent/run-bound).
    return issues.createCompanyFile({
      companyId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: null,
      createdByUserId: actor.userId,
    });
  }

  async function recordCreation(
    companyId: string,
    actor: MediaStudioDirectActor,
    params: {
      kind: MediaStudioDirectKind | "rewrite_prompt";
      provider: string;
      model: string;
      prompt: string | null;
      costCents: number;
      fileId: string | null;
      billingCode: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<void> {
    const event = await costs.createEvent(companyId, {
      agentId: null,
      createdByUserId: actor.userId,
      provider: params.provider,
      biller: params.provider,
      billingType: "metered_api",
      billingCode: params.billingCode,
      model: params.model,
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      costCents: params.costCents,
      occurredAt: nowOf(),
    });
    await db.insert(mediaStudioDirectCreations).values({
      companyId,
      createdByUserId: actor.userId,
      kind: params.kind,
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      costCents: params.costCents,
      fileId: params.fileId,
      costEventId: event.id,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId,
      agentId: null,
      action: `media_studio_direct.${params.kind}_created`,
      entityType: params.fileId ? "company_file" : "cost_event",
      entityId: params.fileId ?? event.id,
      details: { costCents: params.costCents, provider: params.provider, model: params.model },
    });
  }

  function attachmentResponse(fileId: string, contentType: string) {
    const contentPath = `/api/attachments/${fileId}/content`;
    return { fileId, contentPath, openPath: contentPath, downloadPath: `${contentPath}?download=1`, contentType };
  }

  async function createPicture(companyId: string, actor: MediaStudioDirectActor, input: CreateMediaStudioDirectPictureInput) {
    const estimate = estimateMediaStudioDirectCostCents({ kind: "picture", provider: input.provider });
    await assertWithinBudget(companyId, estimate.estimatedCostCents, input.confirmBudgetCapCents);

    const apiKey = await resolveFalApiKey(companyId, actor.userId);
    const provider = new FalDirectPictureProvider(apiKey, safeFetch);
    const result = await provider.generate({ prompt: input.prompt, model: input.model, seed: input.seed });
    const { contentBase64, contentType } = await pictureResultBytes(result);
    const file = await saveResultFile(companyId, actor, contentBase64, contentType, `picture-${result.provider}-${Date.now()}.${extensionFor(contentType)}`);

    await recordCreation(companyId, actor, {
      kind: "picture",
      provider: result.provider,
      model: result.model,
      prompt: input.prompt,
      costCents: estimate.estimatedCostCents,
      fileId: file.id,
      billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE,
    });

    return { ...attachmentResponse(file.id, file.contentType), costCents: estimate.estimatedCostCents, seed: result.seed, provider: result.provider, model: result.model };
  }

  async function createVideo(companyId: string, actor: MediaStudioDirectActor, input: CreateMediaStudioDirectVideoInput) {
    const estimate = estimateMediaStudioDirectCostCents({ kind: "video", provider: input.provider, durationSeconds: input.durationSeconds });
    await assertWithinBudget(companyId, estimate.estimatedCostCents, input.confirmBudgetCapCents);

    const apiKey = await resolveFalApiKey(companyId, actor.userId);
    const provider = new FalVideoProvider(apiKey, safeFetch);
    const handle = await provider.start({ kind: "video", prompt: input.prompt, model: input.model, durationSeconds: input.durationSeconds, seed: input.seed });
    const result = await pollUntilDone(provider, handle as MediaStudioDirectJobHandle, VIDEO_POLL_TIMEOUT_MS);
    const { contentBase64, contentType } = await mediaResultBytes(result, "video/", "a video");
    const file = await saveResultFile(companyId, actor, contentBase64, contentType, `video-${handle.provider}-${Date.now()}.${extensionFor(contentType)}`);

    await recordCreation(companyId, actor, {
      kind: "video",
      provider: handle.provider,
      model: handle.model,
      prompt: input.prompt,
      costCents: estimate.estimatedCostCents,
      fileId: file.id,
      billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE,
    });

    return { ...attachmentResponse(file.id, file.contentType), costCents: estimate.estimatedCostCents, provider: handle.provider, model: handle.model };
  }

  async function createAudio(companyId: string, actor: MediaStudioDirectActor, input: CreateMediaStudioDirectAudioInput) {
    const estimate = estimateMediaStudioDirectCostCents({ kind: "audio", provider: input.provider, durationSeconds: input.durationSeconds });
    await assertWithinBudget(companyId, estimate.estimatedCostCents, input.confirmBudgetCapCents);

    const apiKey = await resolveFalApiKey(companyId, actor.userId);
    const provider = new FalDirectAudioProvider(apiKey, safeFetch);
    const handle = await provider.start({ prompt: input.prompt, mode: input.mode, voice: input.voice, model: input.model, durationSeconds: input.durationSeconds });
    const result = await pollUntilDone(provider, handle, AUDIO_POLL_TIMEOUT_MS);
    const { contentBase64, contentType } = await mediaResultBytes(result, "audio/", "audio");
    const file = await saveResultFile(companyId, actor, contentBase64, contentType, `audio-${handle.provider}-${Date.now()}.${extensionFor(contentType)}`);

    await recordCreation(companyId, actor, {
      kind: "audio",
      provider: handle.provider,
      model: handle.model,
      prompt: input.prompt,
      costCents: estimate.estimatedCostCents,
      fileId: file.id,
      billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE,
    });

    return { ...attachmentResponse(file.id, file.contentType), costCents: estimate.estimatedCostCents, provider: handle.provider, model: handle.model };
  }

  async function countRewriteCallsToday(companyId: string): Promise<number> {
    const start = new Date(nowOf());
    start.setUTCHours(0, 0, 0, 0);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), eq(costEvents.billingCode, MEDIA_STUDIO_DIRECT_REWRITE_BILLING_CODE), gte(costEvents.occurredAt, start)));
    return Number(row?.count ?? 0);
  }

  /**
   * "Help me write this": a single, tool-less quick-model call, patterned
   * after lane-a.ts's transform call shape (system + user message, capped
   * output, no conversation) but with board auth and no target agent --
   * there is no agent persona to bind a key to, so this uses the same
   * instance-level ANTHROPIC_API_KEY secretary-classifier.ts's chat router
   * already uses for an agent-independent quick-model call.
   */
  async function rewritePrompt(companyId: string, actor: MediaStudioDirectActor, input: MediaStudioDirectRewritePromptInput) {
    const callsToday = await countRewriteCallsToday(companyId);
    if (callsToday >= REWRITE_DAILY_CALL_CAP_PER_COMPANY) {
      throw tooManyRequests(
        `This company has used its ${REWRITE_DAILY_CALL_CAP_PER_COMPANY} prompt-rewrite calls for today. Try again after midnight UTC.`,
        { reason: "daily_call_cap", limit: REWRITE_DAILY_CALL_CAP_PER_COMPANY },
      );
    }
    const apiKey = readAnthropicApiKey();
    if (!apiKey) throw unprocessable("Prompt rewriting is not configured on this instance (ANTHROPIC_API_KEY unset).");

    const kindSentence = input.kind ? ` for a ${input.kind}-generation prompt` : "";
    const systemPrompt =
      `You rewrite short media-generation prompts${kindSentence} to be clearer and more specific for an AI generator, ` +
      "without changing their meaning or adding content the person didn't ask for. Reply with ONLY the rewritten " +
      "prompt text -- no preface, no quotes, no commentary.";

    const client = new Anthropic({ apiKey });
    let response;
    try {
      response = await client.messages.create({
        model: REWRITE_MODEL,
        max_tokens: REWRITE_MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: input.prompt }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw unprocessable("Prompt rewriting credentials are invalid on this instance.");
      if (err instanceof Anthropic.RateLimitError) throw tooManyRequests("Prompt rewriting is rate limited upstream -- retry shortly.");
      if (err instanceof Anthropic.APIError) throw unprocessable(`Prompt rewriting call failed: ${err.message}`);
      throw err;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw unprocessable("Prompt rewriting returned no text.");

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const costCents = computeCostCents("anthropic", REWRITE_MODEL, inputTokens, outputTokens);

    await recordCreation(companyId, actor, {
      kind: "rewrite_prompt",
      provider: "anthropic",
      model: REWRITE_MODEL,
      prompt: input.prompt,
      costCents,
      fileId: null,
      billingCode: MEDIA_STUDIO_DIRECT_REWRITE_BILLING_CODE,
      inputTokens,
      outputTokens,
    });

    return { rewritten: text, model: REWRITE_MODEL, costCents };
  }

  async function history(companyId: string, actor: MediaStudioDirectActor, limit = 50): Promise<MediaStudioDirectHistoryEntry[]> {
    const rows = await db
      .select()
      .from(mediaStudioDirectCreations)
      .where(and(eq(mediaStudioDirectCreations.companyId, companyId), eq(mediaStudioDirectCreations.createdByUserId, actor.userId)))
      .orderBy(desc(mediaStudioDirectCreations.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as MediaStudioDirectKind | "rewrite_prompt",
      provider: row.provider,
      model: row.model,
      prompt: row.prompt,
      costCents: row.costCents,
      fileId: row.fileId,
      contentPath: row.fileId ? `/api/attachments/${row.fileId}/content` : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  return {
    estimate: estimateMediaStudioDirectCostCents,
    createPicture,
    createVideo,
    createAudio,
    rewritePrompt,
    history,
  };
}
