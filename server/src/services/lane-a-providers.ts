/**
 * DUR-3997 (Connections, slice 2): one small client shape for every model
 * provider a quick agent (Lane A) can run on.
 *
 * Before this, lane-a.ts constructed `new Anthropic({ apiKey })` in two places
 * and spoke the Anthropic Messages API directly, so a quick agent could only
 * ever be Claude. Now the two call sites ask this factory for a client and
 * speak one neutral shape (`LaneACompletionRequest` in, `LaneACompletion`
 * out); the translation to and from each provider's wire format — including
 * tool calls in both directions — lives here and nowhere else.
 *
 * Two implementations:
 *   - anthropic: the existing SDK. Also wraps the injectable test client
 *     (LaneAServiceOptions.createModelClient) so every existing Lane A test
 *     keeps asserting on the same Anthropic-shaped call it always did.
 *   - openai-compatible: OpenAI, Google (its OpenAI-compatible endpoint),
 *     OpenRouter and any local OpenAI-compatible server (Ollama, LM Studio,
 *     llama.cpp, vLLM). Plain `fetch` to /chat/completions: the `openai`
 *     package is not a dependency of this repo and is not added.
 *
 * Security (DUR-3994): the key is held in the closure of the client for the
 * duration of the call and nowhere else. It is never written to process.env,
 * never logged, and every error message that could carry it — an upstream
 * body echoing the Authorization header, an SDK message — is scrubbed of the
 * key value and of anything that looks like a key before it leaves here.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  LANE_A_PROVIDER_CATALOGUE,
  normalizeLaneAProvider,
  type LaneAProvider,
} from "@paperclipai/shared";

/** A tool the model may call, provider-neutral (JSON-schema input). */
export interface LaneATool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LaneAToolCall {
  id: string;
  name: string;
  /** `null` when the provider sent arguments that were not a JSON object. */
  input: Record<string, unknown> | null;
}

export interface LaneAToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type LaneAChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LaneAToolCall[] }
  | { role: "tool"; results: LaneAToolResult[] };

export interface LaneACompletionRequest {
  model: string;
  system: string;
  messages: LaneAChatMessage[];
  tools?: LaneATool[];
  maxTokens: number;
}

export type LaneAStop = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface LaneACompletion {
  text: string;
  toolCalls: LaneAToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stop: LaneAStop;
  /** The provider's own stop reason, kept for the `stopReason` field the routes already return. */
  stopReason: string | null;
}

export interface LaneAProviderClient {
  provider: LaneAProvider;
  complete(request: LaneACompletionRequest): Promise<LaneACompletion>;
}

/** The one part of the Anthropic client a chat turn uses — the existing test seam. */
export type LaneAModelClient = Pick<Anthropic, "messages">;

export type LaneAProviderErrorKind = "auth" | "rate_limit" | "upstream" | "network";

/**
 * A provider call that failed, classified so lane-a.ts can turn it into the
 * right HTTP answer (503 for a bad key, 429 for upstream rate limiting, 502
 * otherwise). `message` is already scrubbed.
 */
export class LaneAProviderError extends Error {
  readonly kind: LaneAProviderErrorKind;
  readonly provider: LaneAProvider;
  readonly status: number | null;

  constructor(input: { kind: LaneAProviderErrorKind; provider: LaneAProvider; message: string; status?: number | null }) {
    super(input.message);
    this.name = "LaneAProviderError";
    this.kind = input.kind;
    this.provider = input.provider;
    this.status = input.status ?? null;
  }
}

/**
 * Remove a key value, and anything shaped like one, from text that is about
 * to be logged or returned. Exported so the tests can prove it.
 */
export function scrubLaneASecrets(text: string, apiKey?: string | null): string {
  let out = text;
  if (typeof apiKey === "string" && apiKey.length >= 4) {
    out = out.split(apiKey).join("[redacted]");
  }
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\bBearer\s+[^\s"']+/g, "Bearer [redacted]");
}

/**
 * Where an OpenAI-compatible provider is called. The fixed providers ignore
 * any stored base URL (their address is not the operator's to change);
 * OpenRouter falls back to its public endpoint; a local model has no default
 * and returns null when the operator has not set one.
 */
export function resolveLaneABaseUrl(provider: unknown, baseUrl: string | null | undefined): string | null {
  const key = normalizeLaneAProvider(provider);
  const descriptor = LANE_A_PROVIDER_CATALOGUE[key];
  const custom = typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl.trim() : null;
  if (!descriptor.baseUrlEditable) return descriptor.defaultBaseUrl;
  return custom ?? descriptor.defaultBaseUrl;
}

export interface CreateLaneAProviderClientInput {
  provider: LaneAProvider;
  /** Null only when `anthropicClient` is injected (tests). */
  apiKey: string | null;
  baseUrl?: string | null;
  /** Test seam: a pre-built Anthropic-shaped client (LaneAServiceOptions.createModelClient). */
  anthropicClient?: LaneAModelClient;
  /** Test seam for the OpenAI-compatible providers. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Wall-clock bound for one OpenAI-compatible call. */
  timeoutMs?: number;
}

export function createLaneAProviderClient(input: CreateLaneAProviderClientInput): LaneAProviderClient {
  if (input.provider === "anthropic") {
    const client = input.anthropicClient ?? new Anthropic({ apiKey: input.apiKey ?? "" });
    return createAnthropicLaneAClient(client, input.apiKey);
  }
  const baseUrl = resolveLaneABaseUrl(input.provider, input.baseUrl);
  if (!baseUrl) {
    throw new Error(`No model address configured for provider ${input.provider}`);
  }
  if (!input.apiKey && input.provider !== "local") {
    throw new Error(`No key for provider ${input.provider}`);
  }
  return createOpenAiCompatibleLaneAClient({
    provider: input.provider,
    apiKey: input.apiKey ?? "",
    baseUrl,
    fetchImpl: input.fetch ?? globalThis.fetch,
    timeoutMs: input.timeoutMs ?? DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS,
  });
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

export function toAnthropicTool(tool: LaneATool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

export function fromAnthropicTool(tool: Anthropic.Tool): LaneATool {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.input_schema as Record<string, unknown>,
  };
}

export function toAnthropicMessages(messages: LaneAChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "assistant") {
      if (!message.toolCalls || message.toolCalls.length === 0) {
        return { role: "assistant", content: message.content };
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      // An empty text block is refused by the API; only add one that says something.
      if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      return { role: "assistant", content: blocks };
    }
    return {
      role: "user",
      content: message.results.map(
        (result): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
          is_error: result.isError,
        }),
      ),
    };
  });
}

export function fromAnthropicMessage(response: Anthropic.Message): LaneACompletion {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: ((block.input as Record<string, unknown>) ?? {}) as Record<string, unknown>,
    }));
  const stopReason = response.stop_reason ?? null;
  let stop: LaneAStop = "other";
  if (stopReason === "tool_use") stop = "tool_use";
  else if (stopReason === "end_turn" || stopReason === "stop_sequence") stop = "end_turn";
  else if (stopReason === "max_tokens") stop = "max_tokens";
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    stop,
    stopReason,
  };
}

function createAnthropicLaneAClient(client: LaneAModelClient, apiKey: string | null): LaneAProviderClient {
  return {
    provider: "anthropic",
    async complete(request) {
      try {
        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
        });
        return fromAnthropicMessage(response as Anthropic.Message);
      } catch (err) {
        throw classifyAnthropicError(err, apiKey);
      }
    },
  };
}

function classifyAnthropicError(err: unknown, apiKey: string | null): unknown {
  if (err instanceof Anthropic.AuthenticationError) {
    return new LaneAProviderError({ kind: "auth", provider: "anthropic", message: "The Claude key was refused.", status: 401 });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LaneAProviderError({ kind: "rate_limit", provider: "anthropic", message: "Claude is rate limited.", status: 429 });
  }
  if (err instanceof Anthropic.APIError) {
    return new LaneAProviderError({
      kind: "upstream",
      provider: "anthropic",
      message: scrubLaneASecrets(err.message, apiKey),
      status: typeof err.status === "number" ? err.status : null,
    });
  }
  return err;
}

// ─── OpenAI-compatible (OpenAI, Google, OpenRouter, local) ──────────────────

const DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS = 120_000;

type OpenAiToolCallParam = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiMessageParam =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCallParam[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiTool(tool: LaneATool): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

export function toOpenAiMessages(system: string, messages: LaneAChatMessage[]): OpenAiMessageParam[] {
  const out: OpenAiMessageParam[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map(
                (call): OpenAiToolCallParam => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                }),
              ),
            }
          : {}),
      });
    } else {
      for (const result of message.results) {
        // The OpenAI shape has no error flag on a tool message; the prefix
        // keeps the signal the model needs to know the call did not work.
        out.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: result.isError ? `Error: ${result.content}` : result.content,
        });
      }
    }
  }
  return out;
}

/** The request body one OpenAI-compatible call sends. Exported for tests. */
export function buildOpenAiCompatibleBody(provider: LaneAProvider, request: LaneACompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request.system, request.messages),
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toOpenAiTool);
  }
  // OpenAI's reasoning models refuse `max_tokens` and want
  // `max_completion_tokens`; every other OpenAI-compatible server (OpenRouter,
  // Google's shim, Ollama, LM Studio, llama.cpp, vLLM) speaks `max_tokens`.
  if (provider === "openai") body.max_completion_tokens = request.maxTokens;
  else body.max_tokens = request.maxTokens;
  return body;
}

function textFromOpenAiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Returns the parsed arguments, or `null` when the provider sent arguments
 * that are not a JSON object. A null is turned into an error tool result by
 * the caller rather than running the tool with `{}`: an empty call would
 * burn one of the few tool calls a message gets and answer the wrong question.
 */
function parseToolArguments(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Translate one /chat/completions response body. Exported for tests. */
export function fromOpenAiCompletion(payload: unknown): LaneACompletion {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = (choices[0] && typeof choices[0] === "object" ? choices[0] : {}) as Record<string, unknown>;
  const message = (first.message && typeof first.message === "object" ? first.message : {}) as Record<string, unknown>;
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: LaneAToolCall[] = rawToolCalls.flatMap((raw, index) => {
    const call = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const fn = (call.function && typeof call.function === "object" ? call.function : {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) return [];
    return [
      {
        // Some local servers omit ids; the loop needs one to pair the result.
        id: typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${index + 1}`,
        name,
        input: parseToolArguments(fn.arguments),
      },
    ];
  });
  const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : null;
  let stop: LaneAStop = "other";
  if (finishReason === "tool_calls" || (toolCalls.length > 0 && finishReason !== "length")) stop = "tool_use";
  else if (finishReason === "stop") stop = "end_turn";
  else if (finishReason === "length") stop = "max_tokens";
  const usage = (record.usage && typeof record.usage === "object" ? record.usage : {}) as Record<string, unknown>;
  return {
    text: textFromOpenAiContent(message.content),
    toolCalls,
    usage: {
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    },
    stop,
    stopReason: finishReason,
  };
}

/** Upper bound on a provider's response body; anything past it is refused. */
export const LANE_A_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readBodyCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`the answer was larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function createOpenAiCompatibleLaneAClient(input: {
  provider: LaneAProvider;
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): LaneAProviderClient {
  const endpoint = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const label = LANE_A_PROVIDER_CATALOGUE[input.provider].label;
  return {
    provider: input.provider,
    async complete(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      let response: Response;
      try {
        response = await input.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
            ...(input.provider === "openrouter" ? { "x-title": "Paperclip" } : {}),
          },
          body: JSON.stringify(buildOpenAiCompatibleBody(input.provider, request)),
          signal: controller.signal,
          // Never follow a redirect: the key travels as a header, and a
          // bounce to another host is not something a model endpoint does.
          redirect: "error",
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = err instanceof Error ? err.message : String(err);
        throw new LaneAProviderError({
          kind: "network",
          provider: input.provider,
          message: controller.signal.aborted
            ? `${label} did not answer within ${Math.round(input.timeoutMs / 1000)} seconds.`
            : `Could not reach ${label}: ${scrubLaneASecrets(reason, input.apiKey)}`,
        });
      }

      // The time limit covers the body too: a server that sends headers and
      // then stalls must not hold the chat request (or a transform slot) open
      // for ever. The body is also capped, since it is parsed in memory.
      let rawBody: string;
      try {
        rawBody = await readBodyCapped(response, LANE_A_MAX_RESPONSE_BYTES, controller.signal);
      } catch (err) {
        throw new LaneAProviderError({
          kind: "network",
          provider: input.provider,
          message: controller.signal.aborted
            ? `${label} did not finish answering within ${Math.round(input.timeoutMs / 1000)} seconds.`
            : `${label} sent an answer Paperclip could not read: ${scrubLaneASecrets(err instanceof Error ? err.message : String(err), input.apiKey)}`,
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) {
        throw new LaneAProviderError({
          kind: "auth",
          provider: input.provider,
          message: `${label} refused the key.`,
          status: response.status,
        });
      }
      if (response.status === 429) {
        throw new LaneAProviderError({
          kind: "rate_limit",
          provider: input.provider,
          message: `${label} is rate limited.`,
          status: 429,
        });
      }
      if (!response.ok) {
        throw new LaneAProviderError({
          kind: "upstream",
          provider: input.provider,
          message: `${label} answered ${response.status}: ${scrubLaneASecrets(rawBody.slice(0, 300), input.apiKey)}`,
          status: response.status,
        });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw new LaneAProviderError({
          kind: "upstream",
          provider: input.provider,
          message: `${label} answered with something that is not JSON.`,
          status: response.status,
        });
      }
      return fromOpenAiCompletion(payload);
    },
  };
}
