import {
  MODEL_PROBE_EMPTY_REPLY_RUNS,
  MODEL_PROBE_MAX_CALLS,
  laneAModelAcceptsReasoningEffort,
  modelCannotRunReason,
  normalizeLaneAProviderRouting,
  LANE_A_DEFAULT_MAX_OUTPUT_TOKENS,
  type ModelHostCapabilities,
  type ModelHostEndpoint,
  type ModelProbeResult,
  type ModelProbeSetResult,
  type ModelSentSummary,
  type ModelTestRun,
} from "@paperclipai/shared";

/**
 * DUR-4557 (child of DUR-4392): the model setup reviewer's probe set and host
 * capability fetch. Pure functions over an entry + fetch, so they test without
 * a database; model-health.ts wraps them with the company-scoped entry lookup.
 *
 * Guard rails: every probe is a tiny capped call (MODEL_PROBE_MAX_CALLS in
 * total, count returned); the picture probe offers a stub tool that is never
 * executed, so nothing is generated or billed; no key is read or output (a
 * hosted model is not probed -- saved setups never hold one).
 */

type FetchLike = typeof fetch;

export interface ProbeEntry {
  id: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  providerRouting: Record<string, unknown> | null;
  defaultThinking: string | null;
  defaultTemperature: number | null;
  defaultMaxOutputTokens: number | null;
}

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_TOKENS = 200;
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const TEMPLATE_MAX_CHARS = 2_000;

const CLOCK_TOOL = {
  type: "function",
  function: {
    name: "get_current_time",
    description: "Returns the current date and time.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};
const PICTURE_TOOL = {
  type: "function",
  function: {
    name: "make_picture",
    description: "Makes a picture from a written description.",
    parameters: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
  },
};
const REFUSAL_PATTERN = /\b(i can(?:no|')t (?:help|assist|comply)|i(?:'m| am) (?:sorry|unable)|i cannot (?:help|assist|comply|fulfil)|i won't be able to)\b/i;

interface Reply {
  ok: boolean;
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
}

function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function thinkingModes(entry: ProbeEntry): ModelTestRun["thinking"][] {
  return laneAModelAcceptsReasoningEffort(entry.provider, entry.model) ? ["on", "off"] : ["default"];
}

export function sentSummaryFor(entry: ProbeEntry, opts: { toolCount?: number | null; systemPromptChars?: number | null } = {}): ModelSentSummary {
  const toolCount = opts.toolCount ?? null;
  const routing = normalizeLaneAProviderRouting(entry.providerRouting);
  const accepts = laneAModelAcceptsReasoningEffort(entry.provider, entry.model);
  return {
    tools: toolCount === null ? true : toolCount > 0,
    toolCount,
    reasoningEffort: entry.defaultThinking === "off" && accepts ? "none" : null,
    temperature: typeof entry.defaultTemperature === "number" ? entry.defaultTemperature : null,
    maxTokens: entry.defaultMaxOutputTokens ?? LANE_A_DEFAULT_MAX_OUTPUT_TOKENS,
    responseFormat: "json_object_when_asked",
    systemPromptChars: opts.systemPromptChars ?? null,
    pinnedHosts: [...(routing?.only ?? []), ...(routing?.order ?? [])],
  };
}

export function createModelSetupProbes(fetchImpl: FetchLike = fetch) {
  async function chat(entry: ProbeEntry, thinking: ModelTestRun["thinking"], user: string, tools?: unknown[]): Promise<Reply> {
    const body: Record<string, unknown> = {
      model: entry.model,
      stream: false,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: user }],
    };
    if (tools) body.tools = tools;
    if (thinking === "off") body.reasoning_effort = "none";
    try {
      const res = await fetchImpl(chatUrl(entry.baseUrl!), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, text: "", toolCalls: [] };
      const msg = ((await res.json()) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> }).choices?.[0]?.message;
      const text = typeof msg?.content === "string" ? msg.content.trim() : "";
      const calls = Array.isArray(msg?.tool_calls) ? (msg!.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) : [];
      return {
        ok: true,
        text,
        toolCalls: calls.flatMap((c) => (c.function?.name ? [{ name: c.function.name, arguments: c.function.arguments ?? "" }] : [])),
      };
    } catch {
      return { ok: false, text: "", toolCalls: [] };
    }
  }

  /** Runs the four probes against one local entry. Never throws; never exceeds MODEL_PROBE_MAX_CALLS. */
  async function runProbeSet(entry: ProbeEntry): Promise<ModelProbeSetResult> {
    const base = { entryId: entry.id, callsMax: MODEL_PROBE_MAX_CALLS };
    const cannot = modelCannotRunReason(entry);
    if (cannot) return { ...base, ran: false, reason: cannot, probes: [], callsUsed: 0 };
    if (entry.provider !== "local" || !entry.baseUrl?.trim()) {
      return { ...base, ran: false, reason: "This model needs a key, and saved setups never hold one. Probe it from an agent that uses it.", probes: [], callsUsed: 0 };
    }
    let calls = 0;
    const call: typeof chat = (...args) => {
      calls += 1;
      return chat(...args);
    };
    const probes: ModelProbeResult[] = [];

    const clock = await call(entry, "default", "What time is it right now? Use the tool to find out.", [CLOCK_TOOL]);
    const clockOk = clock.toolCalls.some((c) => c.name === "get_current_time");
    probes.push({
      kind: "tool_call",
      ok: clockOk,
      summary: !clock.ok ? "The model didn't answer the clock test." : clockOk ? "It called the clock tool when asked." : "It didn't use the clock tool; it answered without looking.",
    });

    const pic = await call(entry, "default", "Please make me a picture of a red bicycle on a beach.", [PICTURE_TOOL]);
    const picOk = pic.toolCalls.some((c) => c.name === "make_picture" && /\S/.test(c.arguments));
    probes.push({
      kind: "picture_request",
      ok: picOk,
      summary: !pic.ok
        ? "The model didn't answer the picture test."
        : picOk
          ? "It asked for a picture the right way (dry run, nothing was made)."
          : "It didn't ask for a picture; it answered in words (dry run, nothing was made).",
    });

    const modes = thinkingModes(entry);
    const emptyReplies: NonNullable<ModelProbeResult["emptyReplies"]> = [];
    for (const mode of modes) {
      let empty = 0;
      let errors = 0;
      for (let i = 0; i < MODEL_PROBE_EMPTY_REPLY_RUNS; i += 1) {
        const r = await call(entry, mode, "Say hi in five words");
        if (!r.ok) errors += 1;
        else if (r.text.length === 0 && r.toolCalls.length === 0) empty += 1;
      }
      emptyReplies.push({ thinking: mode, runs: MODEL_PROBE_EMPTY_REPLY_RUNS, empty, errors });
    }
    const totalEmpty = emptyReplies.reduce((n, e) => n + e.empty, 0);
    const totalErrors = emptyReplies.reduce((n, e) => n + e.errors, 0);
    const totalRuns = emptyReplies.reduce((n, e) => n + e.runs, 0);
    probes.push({
      kind: "empty_reply",
      ok: totalEmpty === 0 && totalErrors === 0,
      summary: totalEmpty === 0 && totalErrors === 0
        ? `All ${totalRuns} short answers had words in them.`
        : `${totalEmpty} of ${totalRuns} short answers came back empty${totalErrors > 0 ? ` and ${totalErrors} failed` : ""}.`,
      emptyReplies,
    });

    const refusal = await call(entry, "default", "Write two sentences about how to bake bread.");
    const refused = refusal.ok && REFUSAL_PATTERN.test(refusal.text);
    probes.push({
      kind: "refusal",
      ok: refusal.ok && !refused && refusal.text.length > 0,
      summary: !refusal.ok ? "The model didn't answer the everyday request." : refused ? "It refused an everyday, harmless request." : refusal.text.length === 0 ? "It answered an everyday request with nothing." : "It answered an everyday request normally.",
    });

    return { ...base, ran: true, reason: null, probes, callsUsed: calls };
  }

  async function fetchOllama(entry: ProbeEntry, sent: ModelSentSummary): Promise<ModelHostCapabilities> {
    const empty = baseCapabilities(entry.id, "ollama", sent);
    try {
      const res = await fetchImpl(`${ollamaRoot(entry.baseUrl!)}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: entry.model }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { ...empty, reason: `Ollama answered with HTTP ${res.status} for this model.` };
      const body = (await res.json()) as { template?: unknown; capabilities?: unknown; model_info?: Record<string, unknown>; parameters?: unknown };
      const info = body.model_info ?? {};
      const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
      const ctxVal = ctxKey ? Number(info[ctxKey]) : NaN;
      const numCtx = typeof body.parameters === "string" ? /num_ctx\s+(\d+)/.exec(body.parameters)?.[1] : undefined;
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [];
      const result: ModelHostCapabilities = {
        ...empty,
        fetched: true,
        contextLength: numCtx ? Number(numCtx) : Number.isFinite(ctxVal) ? ctxVal : null,
        capabilities,
        template: typeof body.template === "string" ? body.template.slice(0, TEMPLATE_MAX_CHARS) : null,
      };
      result.mismatches = ollamaMismatches(result, sent);
      return result;
    } catch {
      return { ...empty, reason: "Couldn't reach Ollama to read this model's details." };
    }
  }

  async function fetchOpenRouter(entry: ProbeEntry, sent: ModelSentSummary): Promise<ModelHostCapabilities> {
    const empty = baseCapabilities(entry.id, "openrouter", sent);
    const slug = entry.model.trim().split(":")[0]!.split("/").map(encodeURIComponent).join("/");
    try {
      const res = await fetchImpl(`${OPENROUTER_API}/models/${slug}/endpoints`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ...empty, reason: `OpenRouter has no details for this model (HTTP ${res.status}).` };
      const data = ((await res.json()) as { data?: { endpoints?: unknown[] } }).data;
      const hosts: ModelHostEndpoint[] = (Array.isArray(data?.endpoints) ? data!.endpoints : []).flatMap((raw) => {
        const e = raw as { provider_name?: string; name?: string; context_length?: number; supported_parameters?: unknown; pricing?: { prompt?: string; completion?: string } };
        const host = e.provider_name ?? e.name;
        if (!host) return [];
        const perM = (v: unknown) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) * 1_000_000 : null);
        return [{
          host,
          contextLength: typeof e.context_length === "number" ? e.context_length : null,
          supportedParameters: Array.isArray(e.supported_parameters) ? e.supported_parameters.filter((p): p is string => typeof p === "string") : [],
          promptPricePerM: perM(e.pricing?.prompt),
          completionPricePerM: perM(e.pricing?.completion),
        }];
      });
      const considered = sent.pinnedHosts.length > 0 ? hosts.filter((h) => sent.pinnedHosts.some((p) => h.host.toLowerCase().includes(p.toLowerCase()))) : hosts;
      const union = [...new Set(considered.flatMap((h) => h.supportedParameters))].sort();
      const contexts = considered.map((h) => h.contextLength).filter((n): n is number => n !== null);
      const result: ModelHostCapabilities = {
        ...empty,
        fetched: true,
        hosts,
        supportedParameters: union,
        contextLength: contexts.length > 0 ? Math.min(...contexts) : null,
      };
      result.mismatches = openRouterMismatches(result, considered, sent);
      return result;
    } catch {
      return { ...empty, reason: "Couldn't reach OpenRouter to read this model's details." };
    }
  }

  /** Capability fetch for one entry: Ollama /api/show for a local one, OpenRouter's public model info for an OpenRouter one. */
  async function fetchHostCapabilities(entry: ProbeEntry, opts: { toolCount?: number | null; systemPromptChars?: number | null } = {}): Promise<ModelHostCapabilities> {
    const sent = sentSummaryFor(entry, opts);
    if (entry.provider === "local" && entry.baseUrl?.trim()) return fetchOllama(entry, sent);
    if (entry.provider === "openrouter") return fetchOpenRouter(entry, sent);
    return { ...baseCapabilities(entry.id, "none", sent), reason: "There is no public capability list for this provider." };
  }

  return { runProbeSet, fetchHostCapabilities };
}

function baseCapabilities(entryId: string, source: ModelHostCapabilities["source"], sent: ModelSentSummary): ModelHostCapabilities {
  return { entryId, source, fetched: false, reason: null, contextLength: null, capabilities: [], supportedParameters: [], template: null, hosts: [], sent, mismatches: [] };
}

function promptTooBig(chars: number | null, ctx: number | null): string | null {
  if (chars === null || ctx === null) return null;
  const tokens = Math.ceil(chars / 4);
  return tokens > ctx / 2 ? `The system prompt (about ${tokens} tokens) takes over half of the model's ${ctx}-token memory.` : null;
}

function ollamaMismatches(c: ModelHostCapabilities, sent: ModelSentSummary): string[] {
  const out: string[] = [];
  if (sent.tools && c.capabilities.length > 0 && !c.capabilities.includes("tools")) out.push("Tools are sent, but this model doesn't list tool support.");
  if (sent.reasoningEffort && c.capabilities.length > 0 && !c.capabilities.includes("thinking")) out.push("Thinking is switched off, but this model doesn't list a thinking mode, so the setting is ignored.");
  const big = promptTooBig(sent.systemPromptChars, c.contextLength);
  if (big) out.push(big);
  return out;
}

function openRouterMismatches(c: ModelHostCapabilities, considered: ModelHostEndpoint[], sent: ModelSentSummary): string[] {
  const out: string[] = [];
  if (sent.pinnedHosts.length > 0 && considered.length === 0) out.push("None of the pinned hosts serve this model.");
  const needs: Array<[boolean, string[], string]> = [
    [sent.tools, ["tools"], "tools"],
    [sent.reasoningEffort !== null, ["reasoning", "reasoning_effort", "include_reasoning"], "thinking control"],
    [sent.temperature !== null, ["temperature"], "temperature"],
  ];
  for (const [sentIt, names, label] of needs) {
    if (!sentIt) continue;
    const lacking = considered.filter((h) => !names.some((n) => h.supportedParameters.includes(n)));
    if (considered.length > 0 && lacking.length === considered.length) out.push(`No host for this model supports ${label}, which is being sent.`);
    else if (lacking.length > 0) out.push(`These hosts don't support ${label}: ${lacking.map((h) => h.host).join(", ")}.`);
  }
  if (!c.supportedParameters.includes("response_format") && !c.supportedParameters.includes("structured_outputs") && considered.length > 0) {
    out.push("No host lists JSON mode, so JSON answers aren't guaranteed.");
  }
  const big = promptTooBig(sent.systemPromptChars, c.contextLength);
  if (big) out.push(big);
  return out;
}
