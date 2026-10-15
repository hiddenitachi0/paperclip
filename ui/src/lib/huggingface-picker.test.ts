import { describe, expect, it } from "vitest";
import { buildHuggingFaceModelId } from "@paperclipai/shared";
import type { HuggingFaceModelEntry, HuggingFaceProviderEntry } from "../api/laneA";
import { cheapestToolProvider, filterHuggingFacePickerModels, huggingFaceChoiceSupportsTools } from "./huggingface-picker";

const host = (provider: string, tools: boolean, inP: number | null, outP: number | null): HuggingFaceProviderEntry => ({
  provider, status: "live", supportsTools: tools, supportsStructuredOutput: false, contextLength: 32000,
  inputUsdPerMillion: inP, outputUsdPerMillion: outP, firstTokenLatencyMs: null, throughput: null,
});
const models: HuggingFaceModelEntry[] = [
  { id: "Qwen/Qwen3-14B", providers: [host("deepinfra", true, 0.1, 0.3), host("novita", false, 0.05, 0.1), host("nebius", true, 0.2, 0.5)] },
  { id: "meta-llama/Llama-3", providers: [host("novita", false, 0.05, 0.1)] },
];

describe("huggingface picker helpers", () => {
  it("tools-only drops hosts and models without tools", () => {
    const out = filterHuggingFacePickerModels(models, { search: "", toolsOnly: true });
    expect(out.map((m) => m.id)).toEqual(["Qwen/Qwen3-14B"]);
    expect(out[0]!.providers.map((p) => p.provider)).toEqual(["deepinfra", "nebius"]);
  });
  it("clearing the filter shows everything; search narrows", () => {
    expect(filterHuggingFacePickerModels(models, { search: "", toolsOnly: false })).toHaveLength(2);
    expect(filterHuggingFacePickerModels(models, { search: "LLAMA", toolsOnly: false }).map((m) => m.id)).toEqual(["meta-llama/Llama-3"]);
  });
  it("picks the cheapest tool-capable host", () => {
    expect(cheapestToolProvider(models[0]!)?.provider).toBe("deepinfra");
    expect(cheapestToolProvider(models[1]!)).toBeNull();
  });
  it("builds the stored id with the shared builder", () => {
    expect(buildHuggingFaceModelId("Qwen/Qwen3-14B", "deepinfra")).toBe("Qwen/Qwen3-14B:deepinfra");
    expect(buildHuggingFaceModelId("Qwen/Qwen3-14B", "cheapest")).toBe("Qwen/Qwen3-14B:cheapest");
  });
  it("tool honesty: false only for a known host without tools", () => {
    expect(huggingFaceChoiceSupportsTools(models, "Qwen/Qwen3-14B", "novita")).toBe(false);
    expect(huggingFaceChoiceSupportsTools(models, "Qwen/Qwen3-14B", "deepinfra")).toBe(true);
    expect(huggingFaceChoiceSupportsTools(models, "Qwen/Qwen3-14B", "cheapest")).toBeNull();
    expect(huggingFaceChoiceSupportsTools(models, "Qwen/Qwen3-14B", null)).toBeNull();
  });
});
