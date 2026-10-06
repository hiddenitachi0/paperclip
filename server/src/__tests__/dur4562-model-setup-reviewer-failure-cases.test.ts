import { describe, expect, it } from "vitest";
import {
  applyOutputConverters,
  applyRequestConverters,
  parseModelConverterOps,
  type ConverterCallRequest,
} from "@paperclipai/shared";
import { createModelSetupProbes, type ProbeEntry } from "../services/model-setup-probes.ts";

// DUR-4562: the four failure cases the model setup reviewer exists for. Each
// test checks the probe notices the case, then that the allow-listed converter
// a reviewer would propose fixes the request/output it was meant to fix.

const local: ProbeEntry = {
  id: "e1", provider: "local", model: "qwen3:8b", baseUrl: "http://100.1.2.3:11434/v1",
  providerRouting: null, defaultThinking: "off", defaultTemperature: null, defaultMaxOutputTokens: null,
};
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const baseRequest = (over: Partial<ConverterCallRequest> = {}): ConverterCallRequest => ({
  params: {}, tools: [], systemPrompt: "", textToolCallParsingEnabled: false, ...over,
});

describe("model setup reviewer failure cases (DUR-4562)", () => {
  it("qwen3: thinking ends the turn empty after a planning tool call -> probe flags it, converters recover the text", async () => {
    // Only a <think> block comes back: no visible text, no tool call.
    const fetchImpl = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.tools) return json({ choices: [{ message: { content: "<think>plan: call the tool</think>" } }] });
      return json({ choices: [{ message: { content: "" } }] });
    }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(fetchImpl).runProbeSet(local);
    const empty = r.probes.find((p) => p.kind === "empty_reply")!;
    expect(empty.ok).toBe(false);
    expect(empty.emptyReplies!.reduce((n, e) => n + e.empty, 0)).toBeGreaterThan(0);

    const ops = parseModelConverterOps([
      { op: "strip_output_wrapper", wrapper: "think" },
      { op: "system_prompt_hint", hint: "After planning, always call the tool or answer in words." },
      { op: "parse_text_tool_call" },
    ]);
    expect(applyOutputConverters("<think>plan: call the tool</think>\nDone.", ops)).toBe("Done.");
    expect(applyOutputConverters("<think>only planning</think>", ops)).toBe("");
    const { request } = applyRequestConverters(baseRequest({ systemPrompt: "Be brief." }), ops);
    expect(request.systemPrompt).toBe("Be brief.\n\nAfter planning, always call the tool or answer in words.");
    expect(request.textToolCallParsingEnabled).toBe(true);
  });

  it("reasoning_effort sent to an OpenRouter model that doesn't accept it -> capability fetch flags it, drop_param keeps tools", async () => {
    const fetchImpl = (async () => json({ data: { endpoints: [
      { provider_name: "HostA", context_length: 32000, supported_parameters: ["tools", "temperature", "response_format"] },
    ] } })) as unknown as typeof fetch;
    const entry: ProbeEntry = { ...local, provider: "openrouter", baseUrl: null, model: "vendor/plain-model", defaultThinking: "off" };
    const c = await createModelSetupProbes(fetchImpl).fetchHostCapabilities(entry, { toolCount: 4 });
    expect(c.sent.reasoningEffort).toBe("none");
    expect(c.mismatches.join(" ")).toMatch(/No host for this model supports thinking control/);

    const ops = parseModelConverterOps([{ op: "drop_param", param: "reasoning_effort" }]);
    const tool = { name: "get_current_time", description: "Returns the time." };
    const { request } = applyRequestConverters(baseRequest({ params: { reasoning_effort: "none", temperature: 0.3 }, tools: [tool] }), ops);
    expect(request.params).toEqual({ temperature: 0.3 });
    expect(request.tools).toEqual([tool]);
  });

  it("stale address after a provider switch -> probes see failures (not empties); a hosted entry is never probed", async () => {
    const dead = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const probes = createModelSetupProbes(dead);
    const r = await probes.runProbeSet(local);
    expect(r.ran).toBe(true);
    expect(r.probes.every((p) => !p.ok)).toBe(true);
    const empty = r.probes.find((p) => p.kind === "empty_reply")!;
    expect(empty.emptyReplies!.every((e) => e.empty === 0 && e.errors === e.runs)).toBe(true);
    expect(empty.summary).toMatch(/failed/);
    const caps = await probes.fetchHostCapabilities(local);
    expect(caps.fetched).toBe(false);
    expect(caps.reason).toMatch(/Couldn't reach Ollama/);

    // Switched to a hosted provider but the old local address was left behind: no call goes to it.
    let called = false;
    const spy = (async () => { called = true; return json({}); }) as unknown as typeof fetch;
    const switched = await createModelSetupProbes(spy).runProbeSet({ ...local, provider: "openrouter" });
    expect(switched.ran).toBe(false);
    expect(called).toBe(false);
  });

  it("tool description: small model picks list-looks over generate-image -> probe flags it, plain variant swaps the description", async () => {
    const fetchImpl = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.tools?.[0]?.function?.name === "make_picture") {
        return json({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "list_looks", arguments: "{}" } }] } }] });
      }
      if (b.tools) return json({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "get_current_time", arguments: "{}" } }] } }] });
      return json({ choices: [{ message: { content: "ok then" } }] });
    }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(fetchImpl).runProbeSet(local);
    const pic = r.probes.find((p) => p.kind === "picture_request")!;
    expect(pic.ok).toBe(false);
    expect(r.probes.find((p) => p.kind === "tool_call")!.ok).toBe(true);

    const tools = [
      { name: "generate-image", description: "Long, detailed description of image generation with many options.", plainDescription: "Make a new picture from words." },
      { name: "list-looks", description: "Lists saved looks.", plainDescription: "Show saved looks." },
    ];
    const ops = parseModelConverterOps([{ op: "tool_description_variant", variant: "plain" }]);
    const { request } = applyRequestConverters(baseRequest({ tools }), ops);
    expect(request.tools.map((t) => t.description)).toEqual(["Make a new picture from words.", "Show saved looks."]);
    expect(request.tools.map((t) => t.name)).toEqual(["generate-image", "list-looks"]);
  });
});
