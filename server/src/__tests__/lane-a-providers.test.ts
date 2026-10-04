import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  LaneAProviderError,
  buildOpenAiCompatibleBody,
  createLaneAProviderClient,
  fromAnthropicMessage,
  fromOpenAiCompletion,
  resolveLaneABaseUrl,
  scrubLaneASecrets,
  toAnthropicMessages,
  toOpenAiMessages,
  type LaneAChatMessage,
  type LaneAModelClient,
  type LaneATool,
} from "../services/lane-a-providers.ts";

// DUR-3997 (Connections, slice 2): the provider client factory that lets a
// quick agent run on Claude, OpenAI, Google, OpenRouter or a local model.
// These tests prove the translation in both directions — the neutral shape
// lane-a.ts speaks to and from each provider's wire format, tool calls
// included — with a fake fetch and a fake Anthropic-shaped client, and that
// a key never leaks through an error message.

const KEY = "sk-test-0123456789abcdef";

const WEATHER_TOOL: LaneATool = {
  name: "get_weather",
  description: "Look up the weather.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // A local model's reachability check (GET .../models) runs before the
    // real call; it is answered here but not recorded, so calls[0] stays the
    // model call these tests inspect.
    if ((init?.method ?? "POST") === "GET" && url.endsWith("/models")) return new Response("{}");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, init: init ?? {}, body });
    return responder(url, init ?? {});
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("OpenAI-compatible provider client", () => {
  it("sends the request in the /chat/completions shape with the key as a bearer token", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Hei!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
    const client = createLaneAProviderClient({ provider: "openai", apiKey: KEY, fetch: fetcher.impl });

    const completion = await client.complete({
      model: "gpt-4.1-mini",
      system: "You are the front desk.",
      messages: [{ role: "user", content: "hi" }],
      tools: [WEATHER_TOOL],
      maxTokens: 256,
    });

    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(call.body.model).toBe("gpt-4.1-mini");
    // OpenAI's reasoning models refuse max_tokens; the field is max_completion_tokens there.
    expect(call.body.max_completion_tokens).toBe(256);
    expect(call.body.max_tokens).toBeUndefined();
    expect(call.body.messages).toEqual([
      { role: "system", content: "You are the front desk." },
      { role: "user", content: "hi" },
    ]);
    expect(call.body.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "Look up the weather.", parameters: WEATHER_TOOL.inputSchema },
      },
    ]);
    expect(completion).toEqual({
      text: "Hei!",
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 3 },
      stop: "end_turn",
      stopReason: "stop",
    });
  });

  it("uses max_tokens and the provider's own endpoint for OpenRouter, Google and a local server", async () => {
    for (const [provider, baseUrl, expectedUrl] of [
      ["openrouter", null, "https://openrouter.ai/api/v1/chat/completions"],
      ["google", null, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
      ["local", "http://localhost:11434/v1/", "http://localhost:11434/v1/chat/completions"],
    ] as const) {
      const fetcher = fakeFetch(() =>
        jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
      );
      const client = createLaneAProviderClient({
        provider,
        apiKey: provider === "local" ? null : KEY,
        baseUrl,
        fetch: fetcher.impl,
      });
      await client.complete({ model: "m", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 64 });
      expect(fetcher.calls[0]!.url).toBe(expectedUrl);
      expect(fetcher.calls[0]!.body.max_tokens).toBe(64);
      expect(fetcher.calls[0]!.body.max_completion_tokens).toBeUndefined();
      if (provider === "local") {
        // A local server usually has no key; no Authorization header is sent for it.
        expect((fetcher.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
      }
    }
  });

  it("translates a function call from the model into a tool call, arguments parsed", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 9 },
      }),
    );
    const client = createLaneAProviderClient({ provider: "openai", apiKey: KEY, fetch: fetcher.impl });
    const completion = await client.complete({
      model: "gpt-4.1-mini",
      system: "s",
      messages: [{ role: "user", content: "weather in Oslo?" }],
      tools: [WEATHER_TOOL],
      maxTokens: 64,
    });
    expect(completion.stop).toBe("tool_use");
    expect(completion.toolCalls).toEqual([{ id: "call_abc", name: "get_weather", input: { city: "Oslo" } }]);
    expect(completion.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
  });

  it("replays the assistant's tool calls and the tool results back in the OpenAI shape", () => {
    const messages: LaneAChatMessage[] = [
      { role: "user", content: "weather in Oslo?" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_abc", name: "get_weather", input: { city: "Oslo" } }] },
      {
        role: "tool",
        results: [
          { toolCallId: "call_abc", name: "get_weather", content: "12°C, rain", isError: false },
        ],
      },
      { role: "assistant", content: "It rains.", toolCalls: [{ id: "call_2", name: "lookup_issue", input: {} }] },
      { role: "tool", results: [{ toolCallId: "call_2", name: "lookup_issue", content: "Not found", isError: true }] },
    ];
    expect(toOpenAiMessages("sys", messages)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "weather in Oslo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
      },
      { role: "tool", tool_call_id: "call_abc", content: "12°C, rain" },
      {
        role: "assistant",
        content: "It rains.",
        tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup_issue", arguments: "{}" } }],
      },
      // No error flag in the OpenAI shape: the prefix carries the signal.
      { role: "tool", tool_call_id: "call_2", content: "Error: Not found" },
    ]);
  });

  it("copes with servers that omit tool-call ids, send arguments as objects, or return content parts", () => {
    const completion = fromOpenAiCompletion({
      choices: [
        {
          message: {
            content: [{ type: "text", text: "Part one. " }, { type: "text", text: "Part two." }],
            tool_calls: [
              { type: "function", function: { name: "get_weather", arguments: { city: "Bergen" } } },
              { id: "", type: "function", function: { name: "lookup_issue", arguments: "not json" } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    expect(completion.text).toBe("Part one. Part two.");
    expect(completion.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", input: { city: "Bergen" } },
      // Arguments that are not JSON come through as null, so the loop can
      // refuse that one call instead of running the tool with nothing.
      { id: "call_2", name: "lookup_issue", input: null },
    ]);
    expect(completion.stop).toBe("tool_use");
    expect(completion.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("maps a length stop and an empty answer", () => {
    const completion = fromOpenAiCompletion({
      choices: [{ message: { content: null }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(completion).toMatchObject({ text: "", toolCalls: [], stop: "max_tokens", stopReason: "length" });
  });

  it("classifies 401/403 as a refused key, 429 as rate limited, and never repeats the key", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "auth"],
      [429, "rate_limit"],
    ] as const) {
      const fetcher = fakeFetch(() => jsonResponse({ error: { message: `bad key ${KEY}` } }, status));
      const client = createLaneAProviderClient({ provider: "openai", apiKey: KEY, fetch: fetcher.impl });
      const err = await client
        .complete({ model: "m", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaneAProviderError);
      expect((err as LaneAProviderError).kind).toBe(kind);
      expect((err as LaneAProviderError).status).toBe(status);
      expect((err as LaneAProviderError).message).not.toContain(KEY);
    }
  });

  it("scrubs the key out of an upstream error body that echoes it", async () => {
    const fetcher = fakeFetch(() =>
      new Response(`server error while checking Authorization: Bearer ${KEY} for sk-other-abcdefgh`, { status: 500 }),
    );
    const client = createLaneAProviderClient({ provider: "openrouter", apiKey: KEY, fetch: fetcher.impl });
    const err = await client
      .complete({ model: "m", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaneAProviderError);
    expect((err as LaneAProviderError).kind).toBe("upstream");
    expect((err as LaneAProviderError).message).toContain("OpenRouter answered 500");
    expect((err as LaneAProviderError).message).not.toContain(KEY);
    expect((err as LaneAProviderError).message).not.toContain("sk-other");
  });

  it("reports a server that cannot be reached without the key", async () => {
    const fetcher = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED (token ${KEY})`);
    });
    const client = createLaneAProviderClient({
      provider: "local",
      apiKey: KEY,
      baseUrl: "http://localhost:11434/v1",
      fetch: fetcher.impl,
    });
    const err = await client
      .complete({ model: "m", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaneAProviderError);
    expect((err as LaneAProviderError).kind).toBe("network");
    expect((err as LaneAProviderError).message).toContain("Could not reach Local model");
    expect((err as LaneAProviderError).message).not.toContain(KEY);
  });

  it("refuses to build a local client without an address, and a keyed provider without a key", () => {
    expect(() => createLaneAProviderClient({ provider: "local", apiKey: null, baseUrl: null })).toThrow(
      /No model address/,
    );
    expect(() => createLaneAProviderClient({ provider: "openai", apiKey: null })).toThrow(/No key/);
  });

  it("buildOpenAiCompatibleBody makes OpenRouter use a host that really supports the tools", () => {
    const tool = { name: "list_looks", description: "List looks", inputSchema: { type: "object", properties: {} } };
    const withTools = buildOpenAiCompatibleBody("openrouter", {
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "which looks do we have?" }],
      maxTokens: 10,
      tools: [tool] as never,
    });
    expect(withTools.provider).toEqual({ require_parameters: true });

    const noTools = buildOpenAiCompatibleBody("openrouter", {
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    });
    expect(Object.hasOwn(noTools, "provider")).toBe(false);

    const otherHost = buildOpenAiCompatibleBody("local", {
      model: "llama3.1",
      system: "s",
      messages: [{ role: "user", content: "u" }],
      maxTokens: 10,
      tools: [tool] as never,
    });
    expect(Object.hasOwn(otherHost, "provider")).toBe(false);
  });

  it("buildOpenAiCompatibleBody leaves tools out entirely when there are none", () => {
    const body = buildOpenAiCompatibleBody("local", {
      model: "llama3.1",
      system: "s",
      messages: [{ role: "user", content: "u" }],
      maxTokens: 10,
    });
    expect(Object.hasOwn(body, "tools")).toBe(false);
    expect(body.max_tokens).toBe(10);
  });

  it("buildOpenAiCompatibleBody sends temperature only when a creativity setting is chosen", () => {
    const base = { model: "m", system: "s", messages: [{ role: "user" as const, content: "u" }], maxTokens: 10 };
    for (const provider of ["openai", "google", "openrouter", "local"] as const) {
      expect(Object.hasOwn(buildOpenAiCompatibleBody(provider, base), "temperature")).toBe(false);
      expect(Object.hasOwn(buildOpenAiCompatibleBody(provider, { ...base, temperature: null }), "temperature")).toBe(false);
      expect(buildOpenAiCompatibleBody(provider, { ...base, temperature: 0.9 }).temperature).toBe(0.9);
      // 0 is a real choice ("as predictable as possible"), not "unset".
      expect(buildOpenAiCompatibleBody(provider, { ...base, temperature: 0 }).temperature).toBe(0);
    }
  });

  it("buildOpenAiCompatibleBody sends reasoning_effort only when thinking is turned off (DUR-4367)", () => {
    const base = { model: "m", system: "s", messages: [{ role: "user" as const, content: "u" }], maxTokens: 10 };
    for (const provider of ["openai", "google", "openrouter", "local"] as const) {
      expect(Object.hasOwn(buildOpenAiCompatibleBody(provider, base), "reasoning_effort")).toBe(false);
      expect(Object.hasOwn(buildOpenAiCompatibleBody(provider, { ...base, reasoningEffort: null }), "reasoning_effort")).toBe(
        false,
      );
      expect(buildOpenAiCompatibleBody(provider, { ...base, reasoningEffort: "none" }).reasoning_effort).toBe("none");
    }
  });

  it("puts reasoning_effort on the wire for a local Ollama-style host (DUR-4367)", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }] }),
    );
    const client = createLaneAProviderClient({ provider: "local", baseUrl: "http://10.0.0.1:11434/v1", fetch: fetcher.impl });
    await client.complete({
      model: "huihui_ai/qwen3-abliterated:8b",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
      reasoningEffort: "none",
    });
    expect(fetcher.calls[0]!.body.reasoning_effort).toBe("none");
  });

  it("puts the temperature on the wire for OpenRouter", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "Hei!" }, finish_reason: "stop" }] }),
    );
    const client = createLaneAProviderClient({ provider: "openrouter", apiKey: KEY, fetch: fetcher.impl });
    await client.complete({
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
      temperature: 1.2,
    });
    expect(fetcher.calls[0]!.body.temperature).toBe(1.2);
  });

  it("on OpenRouter with tools, sends both the temperature and require_parameters", () => {
    const body = buildOpenAiCompatibleBody("openrouter", {
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [WEATHER_TOOL],
      maxTokens: 10,
      temperature: 0.9,
    });
    expect(body.temperature).toBe(0.9);
    expect(body.provider).toEqual({ require_parameters: true });
  });

  // 29 Sep: Mistral Small 3.2 24B was wanted on DeepInfra, but OpenRouter
  // picked Venice, which does not do tools. The operator's "model hosts"
  // setting is merged into OpenRouter's `provider` object in its own names.
  it("on OpenRouter, merges the model-hosts setting into `provider` next to require_parameters", () => {
    const body = buildOpenAiCompatibleBody("openrouter", {
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [WEATHER_TOOL],
      maxTokens: 10,
      providerRouting: { only: ["deepinfra"], order: ["deepinfra", "mistral"], ignore: ["venice"], allowFallbacks: false },
    });
    expect(body.provider).toEqual({
      require_parameters: true,
      only: ["deepinfra"],
      order: ["deepinfra", "mistral"],
      ignore: ["venice"],
      allow_fallbacks: false,
    });
  });

  it("on OpenRouter without tools, still sends the host choice but not require_parameters", () => {
    const body = buildOpenAiCompatibleBody("openrouter", {
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "u" }],
      maxTokens: 10,
      providerRouting: { ignore: ["venice"] },
    });
    expect(body.provider).toEqual({ ignore: ["venice"] });
  });

  it("no host choice (null, empty, or malformed) sends exactly what was sent before", () => {
    const base = {
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user" as const, content: "u" }],
      maxTokens: 10,
    };
    for (const providerRouting of [undefined, null, {}, { only: [] }, { only: ["Not a host!"] }, "deepinfra"] as never[]) {
      expect(buildOpenAiCompatibleBody("openrouter", { ...base, providerRouting }).provider).toBeUndefined();
      expect(
        buildOpenAiCompatibleBody("openrouter", { ...base, tools: [WEATHER_TOOL], providerRouting }).provider,
      ).toEqual({ require_parameters: true });
    }
  });

  it("ignores the host choice for every provider but OpenRouter", () => {
    for (const provider of ["openai", "google", "local"] as const) {
      const body = buildOpenAiCompatibleBody(provider, {
        model: "m",
        system: "s",
        messages: [{ role: "user", content: "u" }],
        tools: [WEATHER_TOOL],
        maxTokens: 10,
        providerRouting: { only: ["deepinfra"], allowFallbacks: false },
      });
      expect(Object.hasOwn(body, "provider"), provider).toBe(false);
    }
  });

  it("puts the host choice on the wire for OpenRouter", async () => {
    const fetcher = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "Hei!" }, finish_reason: "stop" }] }),
    );
    const client = createLaneAProviderClient({ provider: "openrouter", apiKey: KEY, fetch: fetcher.impl });
    await client.complete({
      model: "mistralai/mistral-small-3.2-24b-instruct",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [WEATHER_TOOL],
      maxTokens: 64,
      providerRouting: { only: ["deepinfra"] },
    });
    expect(fetcher.calls[0]!.body.provider).toEqual({ require_parameters: true, only: ["deepinfra"] });
  });
});

describe("Anthropic provider client", () => {
  function fakeAnthropic(responses: Array<Record<string, unknown>>) {
    const create = vi.fn(async () => responses.shift());
    const client = { messages: { create } } as unknown as LaneAModelClient;
    return { client, create };
  }

  it("speaks the Messages API exactly as lane-a.ts did before: system, messages, tools with input_schema", async () => {
    const { client, create } = fakeAnthropic([
      { content: [{ type: "text", text: "Hei!" }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: "end_turn" },
    ]);
    const provider = createLaneAProviderClient({ provider: "anthropic", apiKey: null, anthropicClient: client });
    const completion = await provider.complete({
      model: "claude-sonnet-5",
      system: "You are the front desk.",
      messages: [{ role: "user", content: "hi" }],
      tools: [WEATHER_TOOL],
      maxTokens: 2048,
    });
    expect(create).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: "You are the front desk.",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "Look up the weather.", input_schema: WEATHER_TOOL.inputSchema }],
    });
    expect(completion).toEqual({
      text: "Hei!",
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 2 },
      stop: "end_turn",
      stopReason: "end_turn",
    });
  });

  it("sends a temperature to Claude only when set, clamped to Claude's 0-1 range", async () => {
    const answer = { content: [{ type: "text", text: "Hei!" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
    const { client, create } = fakeAnthropic([answer, answer, answer]);
    const provider = createLaneAProviderClient({ provider: "anthropic", apiKey: null, anthropicClient: client });
    const base = { model: "claude-haiku-4-5", system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 64 };

    await provider.complete(base);
    await provider.complete({ ...base, temperature: 0.6 });
    await provider.complete({ ...base, temperature: 1.4 });

    const sent = create.mock.calls.map((call) => (call as unknown[])[0] as Record<string, unknown>);
    expect(Object.hasOwn(sent[0]!, "temperature")).toBe(false);
    expect(sent[1]!.temperature).toBe(0.6);
    expect(sent[2]!.temperature).toBe(1);
  });

  it("translates tool_use blocks into tool calls and tool results back into tool_result blocks", () => {
    const completion = fromAnthropicMessage({
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } },
      ],
      usage: { input_tokens: 20, output_tokens: 8 },
      stop_reason: "tool_use",
    } as unknown as Anthropic.Message);
    expect(completion).toMatchObject({
      text: "Let me check.",
      toolCalls: [{ id: "toolu_1", name: "get_weather", input: { city: "Oslo" } }],
      stop: "tool_use",
      usage: { inputTokens: 20, outputTokens: 8 },
    });

    const replay = toAnthropicMessages([
      { role: "user", content: "weather?" },
      { role: "assistant", content: completion.text, toolCalls: completion.toolCalls },
      { role: "tool", results: [{ toolCallId: "toolu_1", name: "get_weather", content: "12°C", isError: false }] },
      // An assistant turn with tool calls and no text must not carry an empty text block (the API refuses it).
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_2", name: "lookup_issue", input: {} }] },
      { role: "tool", results: [{ toolCallId: "toolu_2", name: "lookup_issue", content: "boom", isError: true }] },
    ]);
    expect(replay).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12°C", is_error: false }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "lookup_issue", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }] },
    ]);
  });

  it("classifies the SDK's errors and scrubs the key from an API error message", async () => {
    const authErr = Anthropic.APIError.generate(401, { error: { message: "bad key" } }, "bad key", new Headers());
    const rateErr = Anthropic.APIError.generate(429, { error: { message: "slow down" } }, "slow down", new Headers());
    const otherErr = Anthropic.APIError.generate(500, { error: { message: `boom ${KEY}` } }, `boom ${KEY}`, new Headers());
    for (const [thrown, kind] of [
      [authErr, "auth"],
      [rateErr, "rate_limit"],
      [otherErr, "upstream"],
    ] as const) {
      const client = { messages: { create: vi.fn(async () => { throw thrown; }) } } as unknown as LaneAModelClient;
      const provider = createLaneAProviderClient({ provider: "anthropic", apiKey: KEY, anthropicClient: client });
      const err = await provider
        .complete({ model: "m", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaneAProviderError);
      expect((err as LaneAProviderError).kind).toBe(kind);
      expect((err as LaneAProviderError).message).not.toContain(KEY);
    }
  });
});

describe("helpers", () => {
  it("scrubLaneASecrets removes the key value and anything shaped like a key", () => {
    expect(scrubLaneASecrets(`x ${KEY} y sk-ant-api03-zzzzzzzz z Bearer abc.def AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ`, KEY)).toBe(
      "x [redacted] y [redacted] z Bearer [redacted] [redacted]",
    );
    // A too-short "key" is not used as a global replacement pattern.
    expect(scrubLaneASecrets("abc", "ab")).toBe("abc");
  });

  it("resolveLaneABaseUrl: fixed providers ignore a custom address, OpenRouter has a default, local has none", () => {
    expect(resolveLaneABaseUrl("openai", "http://evil.example/v1")).toBe("https://api.openai.com/v1");
    expect(resolveLaneABaseUrl("anthropic", "http://x")).toBeNull();
    expect(resolveLaneABaseUrl("openrouter", null)).toBe("https://openrouter.ai/api/v1");
    expect(resolveLaneABaseUrl("openrouter", " https://proxy.example/v1 ")).toBe("https://proxy.example/v1");
    expect(resolveLaneABaseUrl("local", null)).toBeNull();
    expect(resolveLaneABaseUrl("local", "http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });
});
