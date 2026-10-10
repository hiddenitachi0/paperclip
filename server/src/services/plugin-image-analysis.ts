/**
 * Picture analysis for plugins, run by the host (`models.analyseImage`,
 * capability `models.image_analysis.run`).
 *
 * Why the host and not the plugin worker: a plugin's own outbound fetch is
 * SSRF-gated and refuses private and tailnet addresses, so a company's own
 * model server (Ollama on the owner's computer, http://100.x.x.x:11434/v1)
 * could never be reached from a worker. The host already reaches those
 * servers for quick agents. This service does the same, narrowly:
 *
 *  - the company is the one the host confirmed for the current UI action,
 *    and the person is that action's own board user, who must manage the
 *    company (both from the host's invocation scope, never from the worker);
 *  - the model is one of THIS company's saved models (model directory entry);
 *    the plugin names the entry, never a provider, model id or address;
 *  - a local address is called only when the company already uses it (its
 *    model server setting, a saved local model, a quick agent on a local
 *    model; findCompanyLocalAddress), built from the stored address, with no
 *    redirects -- the same rule as the model directory's local resync;
 *  - any other editable address (OpenRouter) must be a public address
 *    (validateAndResolveFetchUrl, the plugin fetch SSRF guard);
 *  - the picture is read by the host from this company's Files (pictures
 *    only) and shrunk to a JPEG before it is sent;
 *  - the key is a company secret of this company (resolved through the
 *    audited plugin path), else Paperclip's own Claude key for Claude only,
 *    else none for a local server -- the same order as quick agents;
 *  - no tools are ever offered to the model; only text comes back;
 *  - the call is priced and recorded on the company's costs like a quick
 *    agent's turn (priceLaneACall), with an activity-log entry.
 */
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@paperclipai/db";
import { companies, modelDirectoryEntries, modelDirectorySettings } from "@paperclipai/db";
import { LANE_A_PROVIDER_CATALOGUE, isLaneAProvider, laneAProviderLabel, type LaneAProvider } from "@paperclipai/shared";
import type { PluginImageAnalysisInput, PluginImageAnalysisResult } from "@paperclipai/plugin-sdk";
import { costService } from "./costs.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";
import { findCompanyLocalAddress } from "./model-directory.js";
import { priceLaneACall } from "./lane-a.js";
import { scrubLaneASecrets } from "./lane-a-providers.js";
import { validateAndResolveFetchUrl } from "./safe-outbound-fetch.js";
import { readAnthropicApiKey } from "../env-values.js";
import { getStorageService } from "../storage/index.js";
import type { StorageService } from "../storage/types.js";
import { logger } from "../middleware/logger.js";

/** Cost events written by this service carry this billing code. */
export const PLUGIN_IMAGE_ANALYSIS_BILLING_CODE = "plugin_image_analysis";
/** The longest instructions a plugin may send. */
export const IMAGE_ANALYSIS_MAX_PROMPT_CHARS = 8_000;
/** The answer is capped at this many tokens whatever the plugin asks for. */
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS = 2_000;
/** A picture larger than this is not read (same limit as files.readContent). */
export const IMAGE_ANALYSIS_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The picture is shrunk to fit this many pixels on its longest side. */
export const IMAGE_ANALYSIS_MAX_SIDE = 1536;
/** One call, including a local model that is still loading. */
export const IMAGE_ANALYSIS_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImageAnalysisCaller {
  companyId: string;
  /** The UI action's own board user, from the host's invocation scope. */
  userId: string | null | undefined;
  /** Whether the host decided that user manages the company. */
  canManageCompany: boolean | undefined;
  /**
   * The host resolved the call to a quick agent's running tool call for this
   * company (a safety check of a photo sent in a chat); `userId` is the
   * person talking to the quick agent.
   */
  quickAgentRun?: boolean;
  pluginId: string;
}

export interface ImageAnalysisDeps {
  /** The model call itself; tests pass a stub. */
  fetchImpl?: typeof fetch;
  /** Public-address check for an editable, non-local address. */
  assertPublicUrl?: (url: string) => Promise<void>;
  /** Paperclip's own Claude key (settings page, then the server's env). */
  instanceAnthropicKey?: () => string | null | undefined;
  storage?: () => StorageService;
  /** Pricing seam (OpenRouter's catalogue is fetched otherwise). */
  priceFetch?: typeof fetch;
}

/** The error a plugin sees: always plain words, never a key. */
export class ImageAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAnalysisError";
  }
}

const fail = (message: string) => new ImageAnalysisError(message);

async function streamToBuffer(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > max) throw fail("That picture is too large to analyse (over 10 MB).");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readCapped(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function finite(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** The OpenAI-compatible request body: system + one user message with the picture as a data URI. Never any tools. */
export function openAiImageBody(model: string, system: string, user: string, picture: { contentType: string; base64: string }, maxTokens: number) {
  return {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: `data:${picture.contentType};base64,${picture.base64}` } },
        ],
      },
    ],
  };
}

/** The Anthropic Messages request body: an image block, then the text. Never any tools. */
export function anthropicImageBody(model: string, system: string, user: string, picture: { contentType: string; base64: string }, maxTokens: number) {
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: picture.contentType, data: picture.base64 } },
          { type: "text", text: user },
        ],
      },
    ],
  };
}

export function pluginImageAnalysisService(db: Db, deps: ImageAnalysisDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const assertPublicUrl =
    deps.assertPublicUrl ??
    (async (url: string) => {
      await validateAndResolveFetchUrl(url);
    });
  const instanceAnthropicKey = deps.instanceAnthropicKey ?? (() => readAnthropicApiKey());
  const storage = deps.storage ?? (() => getStorageService());
  const issues = issueService(db);
  const secrets = secretService(db);
  const costs = costService(db);

  /** Where the call goes. Fixed providers use their own address; local and OpenRouter are checked. */
  async function addressFor(companyId: string, provider: LaneAProvider, storedBaseUrl: string | null): Promise<string> {
    const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
    if (provider === "anthropic") return "https://api.anthropic.com/v1";
    if (provider === "local") {
      let candidate = storedBaseUrl?.trim() || null;
      if (!candidate) {
        // A saved local model without its own address uses the company's model server address.
        const [row] = await db.select().from(modelDirectorySettings).where(eq(modelDirectorySettings.companyId, companyId));
        candidate = row?.localBaseUrl?.trim() || null;
      }
      if (!candidate) {
        throw fail("This saved model runs on the company's own model server, but no address is set. Add the address in Settings > Models first.");
      }
      const known = await findCompanyLocalAddress(db, companyId, candidate);
      if (!known) {
        throw fail("That model server address is not one this company uses. Set it in Settings > Models first.");
      }
      if (!/^https?:\/\/[^\s]+$/i.test(known.trim())) throw fail("The saved model's address must start with http:// or https://.");
      return known.trim().replace(/\/+$/, "");
    }
    const custom = storedBaseUrl?.trim() || null;
    if (!descriptor.baseUrlEditable || !custom) {
      if (!descriptor.defaultBaseUrl) throw fail("This saved model has no address.");
      return descriptor.defaultBaseUrl.replace(/\/+$/, "");
    }
    // An address the company typed for a hosted service: public addresses only.
    if (!/^https?:\/\/[^\s]+$/i.test(custom)) throw fail("The saved model's address must start with http:// or https://.");
    try {
      await assertPublicUrl(custom);
    } catch {
      throw fail(
        `The saved model's address is not a public internet address, so it cannot be used for ${laneAProviderLabel(provider)}. Only a model on the company's own model server (a local model in Settings > Models) can use a private address.`,
      );
    }
    return custom.replace(/\/+$/, "");
  }

  async function keyFor(caller: ImageAnalysisCaller, provider: LaneAProvider, keySecretId: string | null): Promise<string | null> {
    const label = laneAProviderLabel(provider);
    if (keySecretId) {
      if (!UUID.test(keySecretId)) throw fail("Pick the model's key from the company's Secrets.");
      try {
        return await secrets.resolveSecretValueForPlugin(caller.companyId, keySecretId, "latest", {
          consumerType: "plugin",
          consumerId: caller.pluginId,
          actorType: "plugin",
          pluginId: caller.pluginId,
        });
      } catch {
        throw fail(`The ${label} key picked for picture analysis could not be read. Pick it again from this company's Secrets.`);
      }
    }
    if (provider === "local") return null;
    if (provider === "anthropic") {
      const key = instanceAnthropicKey();
      if (key) return key;
      throw fail("Pick the Claude key (a company secret) for picture analysis, or ask the instance admin to set Paperclip's own Claude key.");
    }
    throw fail(`Pick the ${label} key (a company secret) for picture analysis.`);
  }

  async function readPicture(companyId: string, fileId: string): Promise<{ contentType: string; base64: string }> {
    if (!UUID.test(fileId)) throw fail("That picture is not in this company's Files. Pick it again.");
    const file = await issues.getAttachmentById(fileId);
    // A file of another company reads exactly like a missing one.
    if (!file || file.companyId !== companyId) throw fail("That picture is not in this company's Files. Pick it again.");
    if (!String(file.contentType).toLowerCase().startsWith("image/")) throw fail("That file is not a picture.");
    if (file.byteSize > IMAGE_ANALYSIS_MAX_FILE_BYTES) throw fail("That picture is too large to analyse (over 10 MB).");
    const object = await storage().getObject(companyId, file.objectKey);
    const bytes = await streamToBuffer(object.stream, IMAGE_ANALYSIS_MAX_FILE_BYTES);
    let out: Buffer;
    try {
      out = await sharp(bytes).rotate().resize(IMAGE_ANALYSIS_MAX_SIDE, IMAGE_ANALYSIS_MAX_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    } catch {
      throw fail("That picture could not be read. Try another picture.");
    }
    return { contentType: "image/jpeg", base64: out.toString("base64") };
  }

  return {
    async analyseImage(caller: ImageAnalysisCaller, input: PluginImageAnalysisInput): Promise<PluginImageAnalysisResult> {
      const companyId = caller.companyId;
      if (!caller.userId || (caller.canManageCompany !== true && caller.quickAgentRun !== true)) {
        throw fail("Only the company's owner or an admin can analyse pictures with the company's models, from Paperclip's own pages.");
      }
      const system = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
      const user = typeof input.userPrompt === "string" ? input.userPrompt : "";
      if (!system.trim() || !user.trim() || system.length > IMAGE_ANALYSIS_MAX_PROMPT_CHARS || user.length > IMAGE_ANALYSIS_MAX_PROMPT_CHARS) {
        throw fail("The analysis instructions are missing or too long.");
      }
      const maxTokens = Math.min(
        IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
        Number.isInteger(input.maxOutputTokens) && (input.maxOutputTokens as number) > 0 ? (input.maxOutputTokens as number) : 900,
      );

      const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
      if (!company) throw fail("Company not found.");
      if (company.status === "paused") {
        throw fail("This company is paused (for example because its budget limit was reached), so no model can be called for it now.");
      }

      const entryId = typeof input.entryId === "string" ? input.entryId.trim() : "";
      const [entry] = UUID.test(entryId)
        ? await db.select().from(modelDirectoryEntries).where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, entryId)))
        : [];
      if (!entry) throw fail("That saved model is not one of this company's models (Settings > Models). Pick it again.");
      if (entry.archivedAt) throw fail(`The saved model "${entry.name}" is archived. Pick another one.`);
      if (!isLaneAProvider(entry.provider)) throw fail(`The saved model "${entry.name}" uses a service Paperclip cannot call for pictures.`);
      const provider = entry.provider;
      const model = entry.model;

      const base = await addressFor(companyId, provider, entry.baseUrl ?? null);
      const apiKey = await keyFor(caller, provider, typeof input.keySecretId === "string" && input.keySecretId.trim() ? input.keySecretId.trim() : null);
      const picture = await readPicture(companyId, typeof input.fileId === "string" ? input.fileId.trim() : "");
      const scrub = (t: string) => scrubLaneASecrets(t, apiKey).slice(0, 200);

      const url = provider === "anthropic" ? `${base}/messages` : `${base}/chat/completions`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (provider === "anthropic") {
        headers["x-api-key"] = apiKey ?? "";
        headers["anthropic-version"] = "2023-06-01";
      } else if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }
      const body =
        provider === "anthropic"
          ? anthropicImageBody(model, system, user, picture, maxTokens)
          : openAiImageBody(model, system, user, picture, maxTokens);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          // A saved address that redirects elsewhere is not followed.
          redirect: "error",
          signal: AbortSignal.timeout(IMAGE_ANALYSIS_TIMEOUT_MS),
        });
      } catch (err) {
        logger.warn({ companyId, entryId: entry.id, provider, detail: scrub(err instanceof Error ? err.message : String(err)) }, "plugin image analysis: call failed");
        throw fail(
          provider === "local"
            ? `Could not reach the model server for "${entry.name}". Check that the computer is on and the model server is running.`
            : `Could not reach ${laneAProviderLabel(provider)} for "${entry.name}". Try again in a minute.`,
        );
      }
      const raw = await readCapped(res);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw fail(`${laneAProviderLabel(provider)} did not accept the key. Pick the right key for picture analysis.`);
        if (res.status === 429) throw fail(`${laneAProviderLabel(provider)} is busy. Try again in a minute.`);
        let detail = "";
        try {
          const parsed = asRecord(JSON.parse(raw));
          const m = asRecord(parsed?.error)?.message ?? parsed?.message ?? parsed?.error;
          if (typeof m === "string") detail = `: ${scrub(m)}`;
        } catch {
          // keep it short
        }
        throw fail(`The model "${entry.name}" could not look at the picture (error ${res.status})${detail}. If it cannot see pictures, pick another model.`);
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = asRecord(JSON.parse(raw));
      } catch {
        parsed = null;
      }
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let providerCostUsd: number | null = null;
      if (provider === "anthropic") {
        const parts = Array.isArray(parsed?.content) ? (parsed!.content as unknown[]) : [];
        text = parts.map((p) => (asRecord(p)?.type === "text" ? String(asRecord(p)?.text ?? "") : "")).join("");
        const usage = asRecord(parsed?.usage);
        inputTokens = finite(usage?.input_tokens);
        outputTokens = finite(usage?.output_tokens);
      } else {
        const choice = Array.isArray(parsed?.choices) ? asRecord((parsed!.choices as unknown[])[0]) : null;
        const message = asRecord(choice?.message);
        const content = message?.content;
        if (typeof message?.refusal === "string" && message.refusal) text = message.refusal;
        else if (typeof content === "string") text = content;
        else if (Array.isArray(content)) text = content.map((p) => String(asRecord(p)?.text ?? "")).join("");
        const usage = asRecord(parsed?.usage);
        inputTokens = finite(usage?.prompt_tokens);
        outputTokens = finite(usage?.completion_tokens);
        if (provider === "openrouter" && typeof usage?.cost === "number" && Number.isFinite(usage.cost)) providerCostUsd = usage.cost;
      }

      // Priced and recorded like a quick agent's turn, on the company (no agent).
      let costCents = 0;
      try {
        const cost = await priceLaneACall({ provider, model, inputTokens, outputTokens, providerCostUsd, fetchImpl: deps.priceFetch });
        costCents = cost.costCents;
        await costs.createEvent(companyId, {
          agentId: null,
          provider,
          biller: provider,
          billingType: "metered_api",
          billingCode: PLUGIN_IMAGE_ANALYSIS_BILLING_CODE,
          model,
          inputTokens,
          outputTokens,
          costCents: cost.costCents,
          costMicroUsd: cost.costMicroUsd,
          costSource: cost.costSource,
          createdByUserId: caller.userId,
          occurredAt: new Date(),
        });
      } catch (err) {
        // Like a quick agent's turn: an answer whose cost could not be recorded is not handed out.
        logger.error({ err: err instanceof Error ? err.message : String(err), companyId }, "plugin image analysis: could not record the cost");
        throw fail("The picture was analysed, but its cost could not be recorded, so the answer was not used. Try again.");
      }
      return { text: text.slice(0, 20_000), entryName: entry.name, provider, model, costCents };
    },
  };
}
