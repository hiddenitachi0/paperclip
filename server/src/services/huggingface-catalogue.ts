/**
 * DUR-4447: Hugging Face Inference Providers as a quick-agent provider.
 *
 * One router (https://router.huggingface.co/v1) fronts many hosts. Its public
 * GET /v1/models lists every model with, per host: status, tool support,
 * context length and price (USD per million tokens). This file owns:
 *
 *   - normalising that response (parseHuggingFaceModels),
 *   - an in-process cache of it (~1 hour), shared by the model-list route and
 *     cost recording so the picker and the bill read the same numbers,
 *   - token validation (validateHuggingFaceToken), used before a token is saved,
 *   - price lookup for a final model id with its host/policy suffix
 *     (huggingFacePricingForModelId).
 *
 * The token is sent only to the fixed router address, is never logged, and is
 * scrubbed from every message returned. The catalogue itself is public, so the
 * cache is global rather than per company; the token is used anyway so that
 * listing and validation share one code path.
 */
import { HUGGINGFACE_ROUTER_BASE_URL, splitHuggingFaceModelId } from "@paperclipai/shared";

export const HUGGINGFACE_MODELS_URL = `${HUGGINGFACE_ROUTER_BASE_URL}/models`;
export const HUGGINGFACE_CATALOGUE_TTL_MS = 60 * 60 * 1000;
export const HUGGINGFACE_REQUEST_TIMEOUT_MS = 15_000;

export interface HuggingFaceProviderEntry {
  provider: string;
  status: string;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  contextLength: number | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  firstTokenLatencyMs: number | null;
  throughput: number | null;
}

export interface HuggingFaceModelEntry {
  id: string;
  providers: HuggingFaceProviderEntry[];
}

export type HuggingFaceFetch = (input: string, init: RequestInit) => Promise<Response>;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseProvider(raw: unknown): HuggingFaceProviderEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== "string" || r.provider.length === 0) return null;
  const pricing = (typeof r.pricing === "object" && r.pricing !== null ? r.pricing : {}) as Record<string, unknown>;
  return {
    provider: r.provider,
    status: typeof r.status === "string" ? r.status : "unknown",
    supportsTools: r.supports_tools === true,
    supportsStructuredOutput: r.supports_structured_output === true,
    contextLength: num(r.context_length),
    inputUsdPerMillion: num(pricing.input),
    outputUsdPerMillion: num(pricing.output),
    firstTokenLatencyMs: num(r.first_token_latency_ms ?? r.latency_ms ?? r.latency),
    throughput: num(r.throughput ?? r.tokens_per_second),
  };
}

/** Turn the router's /v1/models body into the normalised shape. Unknown or malformed rows are dropped, never thrown on. */
export function parseHuggingFaceModels(body: unknown): HuggingFaceModelEntry[] {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return [];
  const out: HuggingFaceModelEntry[] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const providers = Array.isArray((row as { providers?: unknown }).providers)
      ? ((row as { providers: unknown[] }).providers.map(parseProvider).filter(Boolean) as HuggingFaceProviderEntry[])
      : [];
    out.push({ id, providers });
  }
  return out;
}

export interface HuggingFaceModelFilter {
  /** Keep only hosts that support tool calls (and models with at least one). */
  toolsOnly?: boolean;
  /** Keep only hosts whose status is "live". */
  liveOnly?: boolean;
}

export function filterHuggingFaceModels(
  models: HuggingFaceModelEntry[],
  filter: HuggingFaceModelFilter,
): HuggingFaceModelEntry[] {
  if (!filter.toolsOnly && !filter.liveOnly) return models;
  return models
    .map((m) => ({
      ...m,
      providers: m.providers.filter(
        (p) => (!filter.toolsOnly || p.supportsTools) && (!filter.liveOnly || p.status === "live"),
      ),
    }))
    .filter((m) => m.providers.length > 0);
}

export class HuggingFaceError extends Error {
  constructor(
    readonly reason: "rejected" | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "HuggingFaceError";
  }
}

async function getModelsBody(token: string, fetchImpl: HuggingFaceFetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(HUGGINGFACE_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      // The token travels as a header; never follow a redirect to another host.
      redirect: "error",
      signal: AbortSignal.timeout(HUGGINGFACE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Deliberately no err.message: it can echo request details.
    throw new HuggingFaceError("unreachable", "Couldn't reach Hugging Face. Try again in a minute.");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new HuggingFaceError(
      "rejected",
      "Hugging Face did not accept this token. Check that you copied the whole token and that it has not been revoked.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HuggingFaceError("unreachable", `Hugging Face is having trouble right now (HTTP ${response.status}). Try again in a minute.`);
  }
  try {
    return await response.json();
  } catch {
    throw new HuggingFaceError("unreachable", "Hugging Face sent an answer Paperclip could not read. Try again in a minute.");
  }
}

export type HuggingFaceTokenVerdict = { ok: true } | { ok: false; reason: "rejected" | "unreachable"; message: string };

/** Check a pasted token before it is stored. Resolves; never throws, never echoes the token. */
export async function validateHuggingFaceToken(
  token: string,
  deps: { fetchImpl?: HuggingFaceFetch } = {},
): Promise<HuggingFaceTokenVerdict> {
  const trimmed = token.trim();
  if (trimmed.length === 0) return { ok: false, reason: "rejected", message: "Paste your Hugging Face token first." };
  try {
    await getModelsBody(trimmed, deps.fetchImpl ?? ((i, init) => fetch(i, init)));
    return { ok: true };
  } catch (err) {
    if (err instanceof HuggingFaceError) {
      return { ok: false, reason: err.reason, message: err.message.split(trimmed).join("[token]") };
    }
    return { ok: false, reason: "unreachable", message: "Couldn't reach Hugging Face. Try again in a minute." };
  }
}

// ─── cache ──────────────────────────────────────────────────────────────────

let cache: { at: number; models: HuggingFaceModelEntry[] } | null = null;
let inflight: Promise<HuggingFaceModelEntry[]> | null = null;

export function resetHuggingFaceCatalogueCache(): void {
  cache = null;
  inflight = null;
}

/** Test seam and cold-start priming: install a catalogue as if it had just been fetched. */
export function primeHuggingFaceCatalogueCache(models: HuggingFaceModelEntry[], now = Date.now()): void {
  cache = { at: now, models };
}

/** The cached catalogue if still fresh, else null. Never fetches. */
export function peekHuggingFaceCatalogue(now = Date.now()): HuggingFaceModelEntry[] | null {
  return cache && now - cache.at < HUGGINGFACE_CATALOGUE_TTL_MS ? cache.models : null;
}

/** The catalogue, fetched with `token` when the cache is cold or older than ~1 hour. Concurrent callers share one fetch. */
export async function getHuggingFaceCatalogue(
  token: string,
  deps: { fetchImpl?: HuggingFaceFetch; now?: () => number } = {},
): Promise<HuggingFaceModelEntry[]> {
  const now = (deps.now ?? Date.now)();
  const fresh = peekHuggingFaceCatalogue(now);
  if (fresh) return fresh;
  if (!inflight) {
    const fetchImpl = deps.fetchImpl ?? ((i, init) => fetch(i, init));
    inflight = getModelsBody(token.trim(), fetchImpl)
      .then((body) => {
        const models = parseHuggingFaceModels(body);
        cache = { at: now, models };
        return models;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Best-effort warm-up used on the call path so cost rows can be priced; failure just leaves the cache cold. */
export async function warmHuggingFaceCatalogue(token: string | null): Promise<void> {
  if (!token || peekHuggingFaceCatalogue()) return;
  await getHuggingFaceCatalogue(token).catch(() => undefined);
}

// ─── pricing ────────────────────────────────────────────────────────────────

export interface HuggingFacePricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

function priced(p: HuggingFaceProviderEntry): p is HuggingFaceProviderEntry & HuggingFacePricing {
  return p.inputUsdPerMillion !== null && p.outputUsdPerMillion !== null;
}

/**
 * The price for a final model id ("Qwen/Qwen3-14B:deepinfra", ":cheapest",
 * ":fastest", ":preferred", or no suffix) from a catalogue, or null when it
 * cannot be priced truthfully.
 *   - explicit host: that host's price;
 *   - :cheapest: the lowest input+output price among live hosts;
 *   - :fastest: the live host with the highest throughput (else lowest first-token latency);
 *   - :preferred / no suffix: HF actually routes by the account's own
 *     preference order, which this catalogue cannot see, and that order can
 *     land on a host pricier than the router's first-listed one. So this
 *     prices to the most expensive *priced* live host instead of the first —
 *     a conservative ceiling that never under-bills — rather than guessing
 *     at the account's real order.
 * Unknown model/host, or a host with no published price, is null: the caller
 * must not record 0 for a model it cannot price truthfully (DUR-4494).
 */
export function huggingFacePricingForModelId(
  models: HuggingFaceModelEntry[],
  modelId: string,
): HuggingFacePricing | null {
  const { model, suffix } = splitHuggingFaceModelId(modelId);
  const entry = models.find((m) => m.id === model);
  if (!entry) return null;
  const live = entry.providers.filter((p) => p.status === "live" || p.status === "unknown");
  let chosen: HuggingFaceProviderEntry | undefined;
  const policy = suffix?.toLowerCase() ?? null;
  if (policy === "cheapest") {
    chosen = live.filter(priced).sort((a, b) => a.inputUsdPerMillion! + a.outputUsdPerMillion! - (b.inputUsdPerMillion! + b.outputUsdPerMillion!))[0];
  } else if (policy === "fastest") {
    chosen =
      [...live].sort((a, b) => (b.throughput ?? -1) - (a.throughput ?? -1))[0] ??
      undefined;
    if (chosen && chosen.throughput === null) {
      chosen = [...live].sort((a, b) => (a.firstTokenLatencyMs ?? Infinity) - (b.firstTokenLatencyMs ?? Infinity))[0];
    }
  } else if (policy === null || policy === "preferred") {
    chosen = live.filter(priced).sort((a, b) => b.inputUsdPerMillion! + b.outputUsdPerMillion! - (a.inputUsdPerMillion! + a.outputUsdPerMillion!))[0];
  } else {
    chosen = entry.providers.find((p) => p.provider.toLowerCase() === policy);
  }
  return chosen && priced(chosen)
    ? { inputUsdPerMillion: chosen.inputUsdPerMillion, outputUsdPerMillion: chosen.outputUsdPerMillion }
    : null;
}

/** Price from the cached catalogue only (sync, for cost recording). */
export function cachedHuggingFacePricing(modelId: string): HuggingFacePricing | null {
  const models = peekHuggingFaceCatalogue();
  return models ? huggingFacePricingForModelId(models, modelId) : null;
}
