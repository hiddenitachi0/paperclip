/**
 * DUR-3997: the Test button for AI-provider keys.
 *
 * One bounded, harmless call per provider that answers "does the provider
 * accept this key?" and nothing more:
 *
 *   anthropic   one 1-token messages call (the same call Paperclip's own
 *               Claude key is tested with, services/server-anthropic-key.ts)
 *   openai      GET https://api.openai.com/v1/models with the bearer
 *   openrouter  GET https://openrouter.ai/api/v1/models with the bearer
 *   google      GET https://generativelanguage.googleapis.com/v1beta/models
 *   local       GET <baseUrl>/v1/models, with a bearer when the stored value
 *               also carries a key ("http://host:11434 my-key")
 *
 * Every probe is bounded to PROBE_TIMEOUT_MS with one retry, and every
 * message that comes back is run through `scrubSecretValue` so the key can
 * never travel back out inside an error, whatever the provider echoed.
 *
 * The value never reaches process.env, a child process, a log line or an
 * activity row: it is read here, sent to the provider over TLS, and dropped.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SecretKind } from "@paperclipai/shared";
import {
  SERVER_ANTHROPIC_KEY_TEST_MODEL,
  describeAnthropicTestError,
  scrubKey,
} from "./server-anthropic-key.js";

/** How long one attempt may take before the page gets an answer. */
export const PROBE_TIMEOUT_MS = 15_000;
/** One retry, so a blip does not mark a good key bad. */
export const PROBE_MAX_RETRIES = 1;

export interface SecretProbeResult {
  ok: boolean;
  /** One plain sentence. Never contains the value. */
  message: string;
}

export type ProbeFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Remove a secret from free text: the literal value, plus anything shaped
 * like a well-known key (sk-…, sk-ant-…, sk-or-…, AIza…, ghp_…, a bearer
 * header) so a provider that echoes a key in a different form is also caught.
 */
export function scrubSecretValue(text: string, value: string): string {
  let out = scrubKey(text, value);
  const trimmed = value.trim();
  // The local-endpoint value is "url key": scrub each part on its own too.
  for (const part of trimmed.split(/\s+/)) {
    if (part.length >= 8) out = out.split(part).join("[key]");
  }
  out = out.replace(/sk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[key]");
  out = out.replace(/AIza[A-Za-z0-9_-]{8,}/g, "[key]");
  out = out.replace(/(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{8,}/g, "[key]");
  out = out.replace(/github_pat_[A-Za-z0-9_]{8,}/g, "[key]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [key]");
  return out;
}

/**
 * The stored value of a `local_model_endpoint` secret is the server address,
 * optionally followed by whitespace and a key. Returns null when it is not a
 * usable http(s) address.
 */
export function parseLocalModelEndpoint(value: string): { baseUrl: string; apiKey: string | null } | null {
  const [rawUrl, ...rest] = value.trim().split(/\s+/);
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const baseUrl = url.toString().replace(/\/+$/, "");
  const apiKey = rest.join(" ").trim();
  return { baseUrl, apiKey: apiKey.length > 0 ? apiKey : null };
}

function providerName(kind: SecretKind): string {
  switch (kind) {
    case "anthropic_api_key":
      return "Claude";
    case "openai_api_key":
      return "OpenAI";
    case "openrouter_api_key":
      return "OpenRouter";
    case "google_api_key":
      return "Google";
    case "local_model_endpoint":
      return "the model server";
    default:
      return "the provider";
  }
}

/** Turn an HTTP status from a models-list call into one plain sentence. */
export function describeHttpProbeStatus(provider: string, status: number, bodyHint: string): string {
  const detail = bodyHint.trim().length > 0 ? ` (${bodyHint.trim()})` : "";
  if (status === 401 || status === 403) return `${provider} did not accept this key${detail}.`;
  if (status === 429) return `${provider} is rate limiting this key right now${detail}. The key itself may still be fine.`;
  if (status >= 500) return `${provider} is having trouble right now (HTTP ${status})${detail}. Try again in a minute.`;
  return `${provider} returned HTTP ${status}${detail}.`;
}

/** Turn a thrown fetch error into one plain sentence. */
export function describeFetchProbeError(provider: string, err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `${provider} did not answer within ${Math.round(PROBE_TIMEOUT_MS / 1000)} seconds.`;
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? err.message;
    return `Could not reach ${provider}: ${detail}`;
  }
  return `Could not reach ${provider}.`;
}

/** Pull a short, safe hint out of a provider's JSON error body. */
async function errorBodyHint(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : typeof parsed?.message === "string"
            ? parsed.message
            : "";
    return message.slice(0, 160);
  } catch {
    return "";
  }
}

/**
 * GET a models list with a bearer (or none) and turn the outcome into a
 * verdict. Retries once on a network failure or a 5xx, never on 4xx: a
 * refused key does not become accepted by asking twice.
 */
async function probeModelsList(input: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  fetchImpl: ProbeFetch;
}): Promise<SecretProbeResult> {
  let lastMessage = `Could not reach ${input.provider}.`;
  for (let attempt = 0; attempt <= PROBE_MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await input.fetchImpl(input.url, {
        method: "GET",
        headers: { accept: "application/json", ...input.headers },
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      lastMessage = describeFetchProbeError(input.provider, err);
      continue;
    }
    if (response.ok) {
      return { ok: true, message: `${input.provider} answered. This key works.` };
    }
    const hint = await errorBodyHint(response);
    lastMessage = describeHttpProbeStatus(input.provider, response.status, hint);
    if (response.status < 500) break;
  }
  return { ok: false, message: lastMessage };
}

async function probeAnthropic(key: string): Promise<SecretProbeResult> {
  const client = new Anthropic({ apiKey: key, timeout: PROBE_TIMEOUT_MS, maxRetries: PROBE_MAX_RETRIES });
  try {
    await client.messages.create({
      model: SERVER_ANTHROPIC_KEY_TEST_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "Hi" }],
    });
    return { ok: true, message: "Claude answered. This key works." };
  } catch (err) {
    return { ok: false, message: describeAnthropicTestError(err, key) };
  }
}

export interface SecretProbeDeps {
  fetchImpl?: ProbeFetch;
  /** Injected so tests never go near Anthropic. */
  probeAnthropicImpl?: (key: string) => Promise<SecretProbeResult>;
}

/**
 * Check `value` with the provider for `kind`. Resolves for every kind: an
 * untestable kind or an unusable value is an `ok: false` verdict with a plain
 * sentence, never a throw. The returned message is always scrubbed.
 */
export async function probeSecretKind(
  kind: SecretKind,
  value: string,
  deps: SecretProbeDeps = {},
): Promise<SecretProbeResult> {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const trimmed = value.trim();
  let result: SecretProbeResult;
  try {
    if (trimmed.length === 0) {
      result = { ok: false, message: "The stored value is empty." };
    } else {
      switch (kind) {
        case "anthropic_api_key":
          result = await (deps.probeAnthropicImpl ?? probeAnthropic)(trimmed);
          break;
        case "openai_api_key":
          result = await probeModelsList({
            provider: "OpenAI",
            url: "https://api.openai.com/v1/models",
            headers: { authorization: `Bearer ${trimmed}` },
            fetchImpl,
          });
          break;
        case "openrouter_api_key":
          result = await probeModelsList({
            provider: "OpenRouter",
            url: "https://openrouter.ai/api/v1/models",
            headers: { authorization: `Bearer ${trimmed}` },
            fetchImpl,
          });
          break;
        case "google_api_key":
          // Google takes the key as a header, never in the URL, so it cannot
          // end up in anyone's access log.
          result = await probeModelsList({
            provider: "Google",
            url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
            headers: { "x-goog-api-key": trimmed },
            fetchImpl,
          });
          break;
        case "local_model_endpoint": {
          const endpoint = parseLocalModelEndpoint(trimmed);
          if (!endpoint) {
            result = {
              ok: false,
              message:
                "The stored value should be the server's address, like http://localhost:11434, optionally followed by a space and its key.",
            };
            break;
          }
          result = await probeModelsList({
            provider: "The model server",
            url: `${endpoint.baseUrl}/v1/models`,
            headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
            fetchImpl,
          });
          break;
        }
        default:
          result = { ok: false, message: `Paperclip cannot test ${providerName(kind)} keys yet.` };
      }
    }
  } catch (err) {
    result = { ok: false, message: describeFetchProbeError(providerName(kind), err) };
  }
  return { ok: result.ok, message: scrubSecretValue(result.message, trimmed) };
}
