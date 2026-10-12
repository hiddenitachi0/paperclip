import { describe, expect, it } from "vitest";
import type { ModelHostCapabilities, ModelProbeSetResult } from "@paperclipai/shared";
import { createModelSetupProbes, type ProbeEntry } from "../services/model-setup-probes.ts";
import { decideChange, isNoWorse, mergeOps, proposeChanges, scoreProbes, findProblems, type ReviewEntry } from "../services/model-setup-reviewer-logic.ts";

const entry: ReviewEntry = { id: "e1", provider: "local", model: "qwen3:8b", baseUrl: "http://100.1.2.3:11434/v1", defaultThinking: null, defaultTemperature: null, defaultMaxOutputTokens: null };
const probeEntry: ProbeEntry = { ...entry, providerRouting: null };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const noCaps: ModelHostCapabilities = { entryId: "e1", source: "none", fetched: false, reason: null, contextLength: null, capabilities: [], supportedParameters: [], template: null, hosts: [], mismatches: [], sent: { tools: true, toolCount: null, reasoningEffort: null, temperature: null, maxTokens: 1, responseFormat: "json_object_when_asked", systemPromptChars: null, pinnedHosts: [] } };

// A fake model that returns only a <think> block unless it is told (by a converter) to strip it.
const thinkyFetch = (async (_u: string, init: any) => {
  const b = JSON.parse(init.body);
  const tool = b.tools?.[0]?.function?.name;
  if (tool) return json({ choices: [{ message: { content: null, tool_calls: [{ function: { name: tool, arguments: '{"description":"x"}' } }] } }] });
  // Thinking on (no reasoning_effort sent): the turn ends with only a <think> block.
  if (b.messages[0].content.startsWith("Say hi") && !b.reasoning_effort) return json({ choices: [{ message: { content: "<think>hmm</think>" } }] });
  if (b.messages[0].content.startsWith("Say hi")) return json({ choices: [{ message: { content: "Hi there, friend, hello." } }] });
  return json({ choices: [{ message: { content: "Mix, rest, bake." } }] });
}) as unknown as typeof fetch;

describe("model setup reviewer logic (DUR-4558)", () => {
  it("qwen3 empty replies: proposes strip-wrapper, the converter-aware rerun passes, and it is applied", async () => {
    const probes = createModelSetupProbes(thinkyFetch);
    const before = await probes.runProbeSet(probeEntry);
    expect(before.probes.find((p) => p.kind === "empty_reply")!.ok).toBe(false);
    const [p] = proposeChanges(entry, noCaps, before, []);
    expect(p!.code).toBe("qwen_empty_thinking");
    expect(p!.settingsPatch).toEqual({ defaultThinking: "off" });
    const after = await probes.runProbeSet({ ...probeEntry, defaultThinking: "off" }, mergeOps([], p!.addOps), { onlyThinking: "off" });
    expect(after.probes.find((x) => x.kind === "empty_reply")!.ok).toBe(true);
    expect(isNoWorse(before, after)).toBe(true);
    expect(decideChange(p!, before, after)).toBe("apply");
  });

  it("a rerun that is worse goes to a card; capability-dropping always goes to a card", async () => {
    const probes = createModelSetupProbes(thinkyFetch);
    const before = await probes.runProbeSet(probeEntry);
    const worse: ModelProbeSetResult = { ...before, probes: before.probes.map((p) => (p.kind === "tool_call" ? { ...p, ok: false } : p)) };
    const [p] = proposeChanges(entry, noCaps, before, []);
    expect(decideChange(p!, before, worse)).toBe("card");
    expect(decideChange({ ...p!, dropsCapability: true }, before, before)).toBe("card");
    expect(decideChange(p!, before, null)).toBe("card");
  });

  it("OpenRouter: reasoning_effort to a host list without it proposes drop_param, applied on host evidence", () => {
    const caps: ModelHostCapabilities = { ...noCaps, source: "openrouter", fetched: true, sent: { ...noCaps.sent, reasoningEffort: "none" }, mismatches: ["No host for this model supports thinking control, which is being sent."] };
    const ran: ModelProbeSetResult = { entryId: "e1", ran: false, reason: "needs a key", probes: [], callsUsed: 0, callsMax: 12 };
    const [p] = proposeChanges({ ...entry, provider: "openrouter" }, caps, ran, []);
    expect(p!.addOps).toEqual([{ op: "drop_param", param: "reasoning_effort" }]);
    expect(decideChange(p!, ran, null)).toBe("apply");
    expect(proposeChanges({ ...entry, provider: "openrouter" }, caps, ran, p!.addOps)).toEqual([]);
  });

  it("stale address: all calls fail -> a finding, never a proposal", async () => {
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(dead).runProbeSet(probeEntry);
    expect(proposeChanges(entry, noCaps, r, [])).toEqual([]);
    expect(findProblems(r, noCaps)[0]!.code).toBe("stale_address");
    expect(scoreProbes(r)).toMatchObject({ tools: 0, pictures: 0 });
  });

  it("small model picks the wrong tool for pictures -> plain description variant proposed", async () => {
    const f = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      const t = b.tools?.[0]?.function?.name;
      if (t === "make_picture") return json({ choices: [{ message: { content: "sure" } }] });
      if (t) return json({ choices: [{ message: { tool_calls: [{ function: { name: t, arguments: "{}" } }] } }] });
      return json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const r = await createModelSetupProbes(f).runProbeSet(probeEntry);
    const [p] = proposeChanges(entry, noCaps, r, []);
    expect(p!.code).toBe("tool_description_plain");
  });

  it("proposals carry no key/address/host/cost fields, and mergeOps refuses a non-allow-listed op", () => {
    expect(() => mergeOps([], [{ op: "run_code" } as any])).toThrow();
  });
});
