import { describe, expect, it } from "vitest";
import {
  KNOWN_MODEL_FAMILIES,
  KNOWN_MODELS_CHECKED_ON,
  findKnownFamily,
  findKnownVariant,
  upgradeOptions,
  variantFitsGpu,
  type KnownModelVariant,
} from "./known-models.js";

function variantOf(familyId: string, label: string): KnownModelVariant {
  const family = findKnownFamily(familyId);
  if (!family) throw new Error(`no family ${familyId}`);
  const variant = family.variants.find((v) => v.variant === label);
  if (!variant) throw new Error(`no variant ${familyId} ${label}`);
  return variant;
}

function fakeVariant(minVramGb: number | null): KnownModelVariant {
  return {
    variant: "test",
    paramsB: 1,
    minVramGb,
    ollama: [],
    openrouter: [],
    huggingface: [],
    tools: "yes",
    vision: false,
    thinking: "no",
    contextTokens: null,
  };
}

describe("KNOWN_MODEL_FAMILIES data", () => {
  it("has unique family ids that are lower-case slugs", () => {
    const ids = KNOWN_MODEL_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
  });

  it("covers the families the owner asked about", () => {
    for (const id of [
      "meta-llama-3.2",
      "meta-llama-3.1",
      "meta-llama-3.3",
      "meta-llama-4",
      "alibaba-qwen3",
      "alibaba-qwen3.6",
      "alibaba-qwen3.8",
      "google-gemma-3",
      "google-gemma-4",
      "mistralai-mistral-small-3.2",
      "mistralai-mistral-nemo",
      "deepseek",
      "nous-hermes-3",
      "microsoft-phi-4",
    ]) {
      expect(findKnownFamily(id), id).not.toBeNull();
    }
  });

  it("uses each Ollama tag or alias only once across the catalogue", () => {
    const seen = new Map<string, string>();
    for (const family of KNOWN_MODEL_FAMILIES) {
      for (const variant of family.variants) {
        for (const tag of variant.ollama) {
          for (const name of [tag.tag, ...(tag.aliases ?? [])]) {
            const key = name.toLowerCase();
            expect(seen.has(key), `${name} also in ${seen.get(key)}`).toBe(false);
            seen.set(key, `${family.id} ${variant.variant}`);
          }
        }
      }
    }
  });

  it("points every derivedFrom at an existing official family, and marks uncensored lines as derived", () => {
    for (const family of KNOWN_MODEL_FAMILIES) {
      if (family.derivedFrom) {
        const parent = findKnownFamily(family.derivedFrom);
        expect(parent, family.id).not.toBeNull();
        expect(parent?.derivedFrom, `${family.id} parent should be official`).toBeUndefined();
      }
      if (family.uncensored) expect(family.derivedFrom, family.id).toBeTruthy();
    }
  });

  it("has unique variant labels and sane numbers", () => {
    for (const family of KNOWN_MODEL_FAMILIES) {
      const labels = family.variants.map((v) => v.variant);
      expect(new Set(labels).size, family.id).toBe(labels.length);
      expect(family.variants.length, family.id).toBeGreaterThan(0);
      for (const v of family.variants) {
        const where = `${family.id} ${v.variant}`;
        expect(v.paramsB, where).toBeGreaterThan(0);
        if (v.minVramGb !== null) {
          expect(v.minVramGb, where).toBeGreaterThan(0);
          // The estimate must at least hold the smallest download.
          const smallest = Math.min(...v.ollama.map((t) => t.sizeGb));
          expect(v.minVramGb, where).toBeGreaterThan(smallest);
        } else {
          expect(v.ollama, where).toHaveLength(0);
        }
        if (v.contextTokens !== null) expect(v.contextTokens, where).toBeGreaterThan(0);
        for (const t of v.ollama) {
          expect(t.sizeGb, `${where} ${t.tag}`).toBeGreaterThan(0);
          expect(t.quant, `${where} ${t.tag}`).toBeTruthy();
          expect(t.tag, `${where} ${t.tag}`).toContain(":");
        }
        for (const o of v.openrouter) {
          expect(o.checkedOn, o.id).toBe(KNOWN_MODELS_CHECKED_ON);
          expect(o.id, where).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
          expect(new Set(o.toolHosts).size, o.id).toBe(o.toolHosts.length);
          if (o.toolHosts.length > 0) {
            expect(o.priceIn, o.id).toBeGreaterThanOrEqual(0);
            expect(o.priceOut, o.id).toBeGreaterThan(0);
          }
        }
        for (const h of v.huggingface) expect(h.model, where).toMatch(/^[^/\s]+\/[^/\s]+$/);
      }
    }
  });

  it("uses each OpenRouter id only once", () => {
    const ids = KNOWN_MODEL_FAMILIES.flatMap((f) => f.variants.flatMap((v) => v.openrouter.map((o) => o.id)));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findKnownVariant", () => {
  it("matches a bare Ollama name to its :latest alias", () => {
    for (const name of ["llama3.2", "llama3.2:latest", "llama3.2:3b", "LLAMA3.2:3B-instruct-q4_K_M"]) {
      const hit = findKnownVariant("local", name);
      expect(hit?.family.id, name).toBe("meta-llama-3.2");
      expect(hit?.variant.variant, name).toBe("3B");
    }
  });

  it("finds phi4:latest as Phi-4 14B and accepts 'ollama' as the provider", () => {
    const hit = findKnownVariant("ollama", "phi4:latest");
    expect(hit?.family.id).toBe("microsoft-phi-4");
    expect(hit?.variant.variant).toBe("14B");
    expect(findKnownVariant("Local", "phi4")?.variant.variant).toBe("14B");
  });

  it("finds namespaced and hf.co tags", () => {
    expect(findKnownVariant("local", "huihui_ai/qwen3-abliterated:14b-v2")?.family.id).toBe("huihui-qwen3-abliterated");
    expect(findKnownVariant("local", "huihui_ai/qwen3-abliterated")?.variant.variant).toBe("8B");
    expect(
      findKnownVariant("local", "hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:q8_0")?.family.id,
    ).toBe("llama-3.1-abliterated");
    expect(findKnownVariant("local", "gemma4")?.variant.variant).toBe("E4B");
  });

  it("returns null for unknown names and providers", () => {
    expect(findKnownVariant("local", "no-such-model:7b")).toBeNull();
    expect(findKnownVariant("local", "llama3.2:3b-made-up")).toBeNull();
    expect(findKnownVariant("anthropic", "llama3.2")).toBeNull();
    expect(findKnownVariant("local", "  ")).toBeNull();
  });

  it("matches OpenRouter ids, ignoring routing suffixes", () => {
    const hit = findKnownVariant("openrouter", "google/gemma-4-31b-it");
    expect(hit?.family.id).toBe("google-gemma-4");
    expect(hit?.variant.variant).toBe("31B");
    expect(findKnownVariant("OpenRouter", "Google/Gemma-4-26B-A4B-it:free")?.variant.variant).toBe("26B A4B (MoE)");
    expect(findKnownVariant("openrouter", "qwen/qwen3.8-27b:nitro")?.family.id).toBe("alibaba-qwen3.8");
    expect(findKnownVariant("openrouter", "qwen/qwen3.8-27b-nope")).toBeNull();
  });

  it("matches Hugging Face models with or without the provider suffix", () => {
    const withSuffix = findKnownVariant("huggingface", "huihui-ai/Huihui-Qwen3-14B-abliterated-v2:featherless-ai");
    const without = findKnownVariant("huggingface", "huihui-ai/huihui-qwen3-14b-abliterated-v2");
    expect(withSuffix?.family.id).toBe("huihui-qwen3-abliterated");
    expect(withSuffix?.variant.variant).toBe("14B");
    expect(without?.variant).toBe(withSuffix?.variant);
    expect(findKnownVariant("huggingface", "Qwen/Qwen3.8-27B:novita")?.family.id).toBe("alibaba-qwen3.8");
  });
});

describe("variantFitsGpu", () => {
  it("returns null when either side is unknown", () => {
    expect(variantFitsGpu(fakeVariant(8), null)).toBeNull();
    expect(variantFitsGpu(fakeVariant(8), undefined)).toBeNull();
    expect(variantFitsGpu(fakeVariant(8), 0)).toBeNull();
    expect(variantFitsGpu(fakeVariant(null), 12)).toBeNull();
  });

  it("says yes up to 85% of the card, tight up to 100%, no beyond", () => {
    expect(variantFitsGpu(fakeVariant(10.2), 12)).toBe("yes"); // exactly 85%
    expect(variantFitsGpu(fakeVariant(10.25), 12)).toBe("tight");
    expect(variantFitsGpu(fakeVariant(12), 12)).toBe("tight");
    expect(variantFitsGpu(fakeVariant(12.01), 12)).toBe("no");
  });

  it("matches the research for a 12 GB card", () => {
    expect(variantFitsGpu(variantOf("google-gemma-4", "12B"), 12)).toBe("yes");
    expect(variantFitsGpu(variantOf("alibaba-qwen3", "14B"), 12)).toBe("tight");
    expect(variantFitsGpu(variantOf("orcarouter-qwen3.8-uncensored", "27B"), 12)).toBe("tight");
    expect(variantFitsGpu(variantOf("meta-llama-4", "Scout (109B MoE)"), 12)).toBe("no");
    expect(variantFitsGpu(variantOf("deepseek", "V4 Flash (284B MoE)"), 12)).toBeNull();
  });
});

describe("upgradeOptions", () => {
  it("offers only bigger variants, smallest first", () => {
    const family = findKnownFamily("alibaba-qwen3")!;
    const from = variantOf("alibaba-qwen3", "14B");
    const ups = upgradeOptions(family, from);
    expect(ups.length).toBeGreaterThan(0);
    for (const u of ups) expect(u.variant.paramsB).toBeGreaterThan(from.paramsB);
    const sizes = ups.map((u) => u.variant.paramsB);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(ups.map((u) => u.variant.variant)).toEqual(["30B A3B (MoE)", "32B", "235B A22B (MoE)"]);
    expect(ups.every((u) => u.via === "openrouter")).toBe(true);
  });

  it("skips bigger variants without a tool host or local fit", () => {
    const family = findKnownFamily("meta-llama-3.2")!;
    // Llama 3.2 3B has no OpenRouter tool host and no larger size.
    expect(upgradeOptions(family, variantOf("meta-llama-3.2", "1B"))).toEqual([]);
    expect(upgradeOptions(family, variantOf("meta-llama-3.2", "1B"), { vramGb: 12 }).map((u) => u.via)).toEqual([
      "local",
    ]);
  });

  it("includes the official family a fine-tune derives from", () => {
    const family = findKnownFamily("huihui-qwen3-abliterated")!;
    const ups = upgradeOptions(family, variantOf("huihui-qwen3-abliterated", "8B"));
    const labels = ups.map((u) => `${u.family.id} ${u.variant.variant}`);
    expect(labels).toContain("alibaba-qwen3 14B");
    expect(labels).toContain("alibaba-qwen3 235B A22B (MoE)");
    expect(labels).not.toContain("alibaba-qwen3 4B");
    // The uncensored 14B has no cloud tool host and no card size was given, so it is not offered.
    expect(labels).not.toContain("huihui-qwen3-abliterated 14B");
    expect(new Set(ups.map((u) => u.variant)).size).toBe(ups.length);
  });

  it("prefers local when a bigger size fits the card", () => {
    const family = findKnownFamily("huihui-qwen3-abliterated")!;
    const ups = upgradeOptions(family, variantOf("huihui-qwen3-abliterated", "8B"), { vramGb: 12 });
    const byLabel = new Map(ups.map((u) => [`${u.family.id} ${u.variant.variant}`, u.via]));
    expect(byLabel.get("huihui-qwen3-abliterated 14B")).toBe("local");
    expect(byLabel.get("alibaba-qwen3 14B")).toBe("local"); // tight fit beats the cloud copy
    expect(byLabel.get("alibaba-qwen3 32B")).toBe("openrouter");
  });

  it("skips Hermes sizes without tool hosts but offers Llama 3.1 70B", () => {
    const family = findKnownFamily("nous-hermes-3")!;
    const ups = upgradeOptions(family, variantOf("nous-hermes-3", "8B"));
    expect(ups.map((u) => `${u.family.id} ${u.variant.variant}`)).toEqual(["meta-llama-3.1 70B"]);
  });
});
