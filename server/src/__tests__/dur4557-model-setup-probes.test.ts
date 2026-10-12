import { describe, expect, it } from "vitest";
import { MODEL_PROBE_MAX_CALLS } from "@paperclipai/shared";
import { createModelSetupProbes, type ProbeEntry } from "../services/model-setup-probes.ts";

const local: ProbeEntry = {
  id: "e1", provider: "local", model: "qwen3:8b", baseUrl: "http://100.1.2.3:11434/v1",
  providerRouting: null, defaultThinking: "off", defaultTemperature: 0.3, defaultMaxOutputTokens: null,
};
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("model setup probes (DUR-4557)", () => {
  it("passes a healthy model, within the call cap", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      const tool = b.tools?.[0]?.function?.name;
      if (tool) return json({ choices: [{ message: { content: null, tool_calls: [{ function: { name: tool, arguments: '{"description":"a bike"}' } }] } }] });
      return json({ choices: [{ message: { content: "Bread: mix, rest, bake." } }] });
    }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(fetchImpl).runProbeSet(local);
    expect(r.ran).toBe(true);
    expect(r.probes.map((p) => p.ok)).toEqual([true, true, true, true]);
    expect(r.callsUsed).toBeLessThanOrEqual(MODEL_PROBE_MAX_CALLS);
    expect(bodies.every((b) => b.max_tokens === 200 && b.stream === false)).toBe(true);
    expect(r.probes[2]!.emptyReplies).toHaveLength(2);
  });

  it("flags no tool call, empty replies and refusals", async () => {
    const fetchImpl = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.tools) return json({ choices: [{ message: { content: "It is noon." } }] });
      if (b.messages[0].content.startsWith("Say hi")) return json({ choices: [{ message: { content: "" } }] });
      return json({ choices: [{ message: { content: "I'm sorry, but I can't help with that." } }] });
    }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(fetchImpl).runProbeSet(local);
    expect(r.probes.map((p) => p.ok)).toEqual([false, false, false, false]);
    expect(r.probes[2]!.emptyReplies!.every((e) => e.empty === 5)).toBe(true);
  });

  it("does not call a hosted model", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return json({}); }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(fetchImpl).runProbeSet({ ...local, provider: "openrouter", baseUrl: null });
    expect(r.ran).toBe(false);
    expect(called).toBe(false);
  });

  it("reads Ollama /api/show and flags a missing tools capability", async () => {
    const fetchImpl = (async (u: string) => {
      expect(u).toBe("http://100.1.2.3:11434/api/show");
      return json({ template: "x".repeat(5000), capabilities: ["completion"], model_info: { "qwen3.context_length": 40960 } });
    }) as unknown as typeof fetch;
    const c = await createModelSetupProbes(fetchImpl).fetchHostCapabilities(local, { toolCount: 12, systemPromptChars: 100_000 });
    expect(c.contextLength).toBe(40960);
    expect(c.template!.length).toBe(2000);
    expect(c.mismatches.join(" ")).toMatch(/tool support/);
    expect(c.mismatches.join(" ")).toMatch(/system prompt/);
  });

  it("reads OpenRouter per-host endpoints and flags pinned hosts lacking tools", async () => {
    const fetchImpl = (async (u: string) => {
      expect(u).toBe("https://openrouter.ai/api/v1/models/mistralai/mistral-small-3.2-24b-instruct/endpoints");
      return json({ data: { endpoints: [
        { provider_name: "DeepInfra", context_length: 128000, supported_parameters: ["tools", "temperature", "response_format"], pricing: { prompt: "0.00000005", completion: "0.0000001" } },
        { provider_name: "Venice", context_length: 32000, supported_parameters: ["temperature"] },
      ] } });
    }) as unknown as typeof fetch;
    const entry: ProbeEntry = { ...local, provider: "openrouter", baseUrl: null, model: "mistralai/mistral-small-3.2-24b-instruct:free", providerRouting: { only: ["DeepInfra", "Venice"] }, defaultThinking: null };
    const c = await createModelSetupProbes(fetchImpl).fetchHostCapabilities(entry, { toolCount: 5 });
    expect(c.hosts).toHaveLength(2);
    expect(c.hosts[0]!.promptPricePerM).toBeCloseTo(0.05);
    expect(c.mismatches.join(" ")).toMatch(/Venice/);
    expect(c.contextLength).toBe(32000);
  });
});
