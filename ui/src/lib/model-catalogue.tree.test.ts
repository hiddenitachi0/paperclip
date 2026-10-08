import { describe, expect, it } from "vitest";
import type { KnownModelFamily, ModelDirectoryEntry } from "@paperclipai/shared";
import {
  buildModelTree,
  claudeIdentity,
  compareEntriesBy,
  criteriaInUse,
  draftFromInstalled,
  entryIdentity,
  filterEntries,
  findKnownMatch,
  gpuFit,
  localAddressesInUse,
  localAddressOf,
  modelIdChoices,
  pickerGroups,
  prefillForModel,
  pickerOptionLabel,
  ratingFor,
  ratingsAverage,
  ratingsIssue,
  ratingsLine,
  runOptionLabel,
  tooBigAdvice,
} from "./model-catalogue";

/** A small made-up known list, so these tests do not depend on the real catalogue data. */
const KNOWN: KnownModelFamily[] = [
  {
    id: "meta-llama-3.2",
    maker: "Meta",
    family: "Llama 3.2",
    license: "Llama 3.2 Community",
    variants: [
      {
        variant: "1B",
        paramsB: 1,
        minVramGb: 2,
        ollama: [{ tag: "llama3.2:1b", quant: "Q8_0", sizeGb: 1.3 }],
        openrouter: [],
        huggingface: [],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
      },
      {
        variant: "3B",
        paramsB: 3,
        minVramGb: 3.5,
        ollama: [{ tag: "llama3.2:3b", quant: "Q4_K_M", sizeGb: 2, aliases: ["llama3.2:latest"] }],
        openrouter: [
          { id: "meta-llama/llama-3.2-3b-instruct", toolHosts: ["deepinfra"], checkedOn: "2026-10-08" },
        ],
        huggingface: [],
        tools: "yes",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
      },
    ],
  },
  {
    id: "alibaba-qwen3",
    maker: "Alibaba",
    family: "Qwen3",
    variants: [
      {
        variant: "14B",
        paramsB: 14,
        minVramGb: 10,
        ollama: [{ tag: "qwen3:14b", quant: "Q4_K_M", sizeGb: 9.3 }],
        openrouter: [{ id: "qwen/qwen3-14b", toolHosts: ["nebius"], checkedOn: "2026-10-08" }],
        huggingface: [{ model: "Qwen/Qwen3-14B:featherless-ai" }],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
      },
      {
        variant: "32B",
        paramsB: 32,
        minVramGb: 20,
        ollama: [{ tag: "qwen3:32b", quant: "Q4_K_M", sizeGb: 20 }],
        openrouter: [{ id: "qwen/qwen3-32b", toolHosts: ["deepinfra", "together"], checkedOn: "2026-10-08" }],
        huggingface: [],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
      },
    ],
  },
  {
    id: "qwen3-abliterated",
    maker: "huihui-ai",
    family: "Qwen3 abliterated",
    derivedFrom: "alibaba-qwen3",
    uncensored: true,
    variants: [
      {
        variant: "30B A3B",
        paramsB: 30,
        minVramGb: 19,
        ollama: [],
        openrouter: [{ id: "x/qwen3-30b-abliterated", toolHosts: ["featherless"], checkedOn: "2026-10-08" }],
        huggingface: [],
        tools: "partial",
        vision: false,
        thinking: "toggle",
        contextTokens: 32768,
      },
    ],
  },
];

let seq = 0;
function entry(over: Partial<ModelDirectoryEntry> & { name: string }): ModelDirectoryEntry {
  seq += 1;
  return {
    id: `id-${seq}`,
    companyId: "c",
    provider: "local",
    model: `model-${seq}`,
    baseUrl: null,
    providerRouting: null,
    defaultThinking: null,
    defaultTemperature: null,
    defaultMaxOutputTokens: null,
    backupEntryIds: [],
    note: null,
    maker: null,
    baseModel: null,
    lane: null,
    availability: null,
    tags: [],
    specs: null,
    favorite: false,
    archivedAt: null,
    family: null,
    variant: null,
    ratings: [],
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const PC = "http://100.1.1.1:11434/v1";
const llamaLocal = entry({
  name: "Maja local",
  model: "llama3.2:latest",
  baseUrl: PC,
  availability: "installed",
  ratings: [
    { criterion: "Tool calling", score: 8 },
    { criterion: "Responsiveness", score: 6 },
  ],
});
const llamaCloud = entry({
  name: "Llama 3.2 3B",
  provider: "openrouter",
  model: "meta-llama/llama-3.2-3b-instruct",
  providerRouting: { only: ["deepinfra"], order: [], ignore: [] },
});
const qwenLocal = entry({ name: "Qwen", model: "qwen3:14b", baseUrl: PC, availability: "planned" });
const custom = entry({ name: "My tune", provider: "openrouter", model: "someone/thing", maker: "Acme", family: "Thing", variant: "7B" });
const loose = entry({ name: "Loose", provider: "openrouter", model: "who/knows" });

describe("known models", () => {
  it("matches local tags by alias and cloud ids with or without a suffix", () => {
    expect(findKnownMatch("local", "llama3.2:latest", KNOWN)?.variant.variant).toBe("3B");
    expect(findKnownMatch("local", "LLAMA3.2:1b", KNOWN)?.variant.variant).toBe("1B");
    expect(findKnownMatch("openrouter", "qwen/qwen3-32b:free", KNOWN)?.variant.variant).toBe("32B");
    expect(findKnownMatch("huggingface", "Qwen/Qwen3-14B:featherless-ai", KNOWN)?.family.family).toBe("Qwen3");
    expect(findKnownMatch("local", "qwen/qwen3-32b", KNOWN)).toBeNull();
    expect(findKnownMatch("openrouter", "nothing/here", KNOWN)).toBeNull();
  });

  it("fills maker, family and size from the known list, but the entry's own words win", () => {
    expect(entryIdentity(llamaLocal, KNOWN)).toMatchObject({ maker: "Meta", family: "Llama 3.2", variant: "3B" });
    expect(entryIdentity(custom, KNOWN)).toMatchObject({ maker: "Acme", family: "Thing", variant: "7B" });
    expect(entryIdentity({ ...loose, baseModel: "Old base", specs: { params: "8B" } }, KNOWN)).toMatchObject({
      maker: null,
      family: "Old base",
      variant: "8B",
    });
  });

  it("says whether a size fits the graphics card", () => {
    expect(gpuFit(3.5, 12)).toBe("yes");
    expect(gpuFit(11, 12)).toBe("tight");
    expect(gpuFit(20, 12)).toBe("no");
    expect(gpuFit(null, 12)).toBeNull();
    expect(gpuFit(3, null)).toBeNull();
  });

  it("advises OpenRouter hosts when a size is too big", () => {
    const big = KNOWN[1]!.variants[1]!;
    expect(tooBigAdvice(big, 12)).toBe(
      "Too big for your PC (needs ~20 GB, you have 12 GB) - run it on OpenRouter: deepinfra, together",
    );
    expect(tooBigAdvice(big, 24)).toBeNull();
    expect(tooBigAdvice(big, null)).toBeNull();
  });
});

describe("buildModelTree", () => {
  const tree = buildModelTree([llamaLocal, llamaCloud, qwenLocal, custom, loose], { known: KNOWN, gpuVramGb: 12 });

  it("groups Maker -> Model family -> Size, with Other last", () => {
    expect(tree.map((maker) => maker.title)).toEqual(["Acme", "Alibaba", "Meta", "Other"]);
    const meta = tree.find((maker) => maker.title === "Meta")!;
    expect(meta.key).toBe("maker-meta");
    expect(meta.families.map((family) => family.title)).toEqual(["Llama 3.2"]);
    const llama = meta.families[0]!;
    // 1B shows although only 3B is saved.
    expect(llama.variants.map((variant) => variant.title)).toEqual(["1B", "3B"]);
    expect(llama.variants[1]!.entries.map((e) => e.name)).toEqual(["Llama 3.2 3B", "Maja local"]);
    const other = tree.find((maker) => maker.title === "Other")!;
    expect(other.families[0]!.title).toBe("Model not set");
    expect(other.families[0]!.variants[0]!.title).toBe("Unspecified");
  });

  it("offers the ollama pull command for a size that is not installed, and no extra rows for saved ways", () => {
    const llama = tree.find((maker) => maker.title === "Meta")!.families[0]!;
    const [oneB, threeB] = llama.variants;
    expect(oneB!.entries).toHaveLength(0);
    expect(oneB!.fit).toBe("yes");
    expect(oneB!.pullCommand).toBe("ollama pull llama3.2:1b");
    expect(oneB!.knownOptions.map((o) => o.label)).toEqual(["On your PC · llama3.2:1b (Q8_0, 1.3 GB)"]);
    expect(threeB!.installedLocally).toBe(true);
    expect(threeB!.pullCommand).toBeNull();
    // Both the local tag (saved as its alias) and the OpenRouter id are saved already.
    expect(threeB!.knownOptions).toEqual([]);
  });

  it("drafts a known way to run a size with address, hosts and facts", () => {
    const qwen = tree.find((maker) => maker.title === "Alibaba")!.families[0]!;
    const fourteen = qwen.variants.find((v) => v.title === "14B")!;
    const router = fourteen.knownOptions.find((o) => o.provider === "openrouter")!;
    expect(router.label).toBe("OpenRouter · nebius");
    expect(router.draft).toMatchObject({
      name: "Qwen3 14B via OpenRouter",
      provider: "openrouter",
      model: "qwen/qwen3-14b",
      providerRouting: { only: ["nebius"] },
      maker: "Alibaba",
      family: "Qwen3",
      variant: "14B",
      availability: "cloud",
      specs: { params: "14B", tools: "yes", thinking: "toggle" },
    });
    expect(fourteen.knownOptions.find((o) => o.provider === "huggingface")!.label).toBe("Hugging Face · featherless-ai");
    const thirtyTwo = qwen.variants.find((v) => v.title === "32B")!;
    expect(thirtyTwo.fit).toBe("no");
    expect(thirtyTwo.pullCommand).toBeNull();
    expect(thirtyTwo.tooBigAdvice).toContain("run it on OpenRouter: deepinfra, together");
    const local = thirtyTwo.knownOptions.find((o) => o.provider === "local")!;
    expect(local.draft).toMatchObject({ baseUrl: PC, availability: "planned", specs: { fitsLocalGpu: "no", pullCommand: "ollama pull qwen3:32b" } });
  });

  it("lists bigger sizes of the family (and of the original for a fine-tune) as upgrades", () => {
    const qwen = tree.find((maker) => maker.title === "Alibaba")!.families[0]!;
    const fourteen = qwen.variants.find((v) => v.title === "14B")!;
    expect(fourteen.upgrades.map((u) => `${u.family} ${u.variant}`)).toEqual(["Qwen3 32B"]);
    // A fine-tune's upgrades include the bigger sizes of the original model.
    const tuned = entry({ name: "Tuned", provider: "openrouter", model: "x/qwen3-30b-abliterated" });
    const tunedTree = buildModelTree([tuned], { known: KNOWN, gpuVramGb: 12 });
    expect(tunedTree[0]!.families[0]!.variants[0]!.upgrades.map((u) => `${u.family} ${u.variant}`)).toEqual(["Qwen3 32B"]);
    const big = fourteen.upgrades.find((u) => u.variant === "32B")!;
    expect(big.local).toBeNull(); // too big for 12 GB
    expect(big.openrouter?.hosts).toEqual(["deepinfra", "together"]);
    expect(big.saved).toBe(false);
    // On a 24 GB card it can run at home too.
    const roomy = buildModelTree([qwenLocal], { known: KNOWN, gpuVramGb: 24 });
    expect(roomy[0]!.families[0]!.variants[0]!.upgrades.find((u) => u.variant === "32B")!.local?.model).toBe("qwen3:32b");
    // Sizes without a saved entry get no upgrade panel.
    expect(qwen.variants.find((v) => v.title === "32B")!.upgrades).toEqual([]);
  });

  it("leaves the known extras out when asked, and only offers the chosen providers", () => {
    const bare = buildModelTree([llamaLocal], { known: KNOWN, includeKnown: false });
    expect(bare[0]!.families[0]!.variants.map((v) => v.title)).toEqual(["3B"]);
    const localOnly = buildModelTree([qwenLocal], { known: KNOWN, knownProviders: ["local"] });
    const options = localOnly[0]!.families[0]!.variants.flatMap((v) => v.knownOptions);
    expect(options.every((o) => o.provider === "local")).toBe(true);
  });

  it("sorts sizes by best score when sorting by rating", () => {
    const a = entry({ name: "A", maker: "M", family: "F", variant: "7B", ratings: [{ criterion: "Coding", score: 4 }] });
    const b = entry({ name: "B", maker: "M", family: "F", variant: "70B", ratings: [{ criterion: "Coding", score: 9 }] });
    const byName = buildModelTree([a, b], { known: [] });
    expect(byName[0]!.families[0]!.variants.map((v) => v.title)).toEqual(["7B", "70B"]);
    const byRating = buildModelTree([a, b], { known: [], sort: "rating", criterion: "coding" });
    expect(byRating[0]!.families[0]!.variants.map((v) => v.title)).toEqual(["70B", "7B"]);
  });
});

describe("local addresses and installed models", () => {
  it("finds the addresses in use, most used first, with a default", () => {
    const other = entry({ name: "Other PC", baseUrl: "http://10.0.0.2:11434/v1/" });
    expect(localAddressesInUse([llamaLocal, qwenLocal, other, llamaCloud])).toEqual([PC, "http://10.0.0.2:11434/v1"]);
    expect(localAddressOf([llamaCloud])).toBe("http://100.124.232.68:11434/v1");
  });

  it("drafts an installed model, using the known facts when it is a known tag", () => {
    const known = draftFromInstalled({ name: "llama3.2:1b", sizeGb: 1.3, parameterSize: "1.2B", quantization: "Q8_0" }, PC, {
      known: KNOWN,
      gpuVramGb: 12,
    });
    expect(known).toMatchObject({
      provider: "local",
      model: "llama3.2:1b",
      baseUrl: PC,
      maker: "Meta",
      family: "Llama 3.2",
      variant: "1B",
      availability: "installed",
    });
    const unknown = draftFromInstalled({ name: "mystery:7b", sizeGb: 4, parameterSize: "7.2B", quantization: "Q4_0" }, PC, {
      known: KNOWN,
    });
    expect(unknown).toMatchObject({
      name: "mystery:7b on your PC",
      variant: "7.2B",
      availability: "installed",
      specs: { params: "7.2B", quant: "Q4_0", sizeGb: 4 },
    });
  });
});

describe("labels", () => {
  it("says how a saved entry runs", () => {
    expect(runOptionLabel(llamaLocal)).toBe("On your PC · llama3.2:latest");
    expect(runOptionLabel(llamaCloud)).toBe("OpenRouter · deepinfra");
    expect(runOptionLabel(loose)).toBe("OpenRouter · any host");
    expect(runOptionLabel({ provider: "huggingface", model: "a/b:novita", providerRouting: null })).toBe("Hugging Face · novita");
  });

  it("makes two Llama 3.2 entries distinguishable in the agent pickers", () => {
    expect(pickerOptionLabel(llamaLocal, KNOWN)).toBe("3B · On your PC (llama3.2:latest) — Maja local");
    expect(pickerOptionLabel(llamaCloud, KNOWN)).toBe("3B · OpenRouter");
    const groups = pickerGroups([llamaLocal, llamaCloud, custom, loose], KNOWN);
    expect(groups.map((g) => g.label)).toEqual(["Acme · Thing", "Meta · Llama 3.2", "Other"]);
    expect(groups[1]!.options.map((o) => o.label)).toEqual([
      "3B · OpenRouter",
      "3B · On your PC (llama3.2:latest) — Maja local",
    ]);
    expect(groups[2]!.options[0]!.label).toBe("OpenRouter — Loose");
  });

  it("adds the name when two options would read the same", () => {
    const twin = entry({ name: "llama 3.2 3b", provider: "openrouter", model: "meta-llama/llama-3.2-3b-instruct" });
    const renamed = { ...llamaCloud, name: "Llama 3.2" };
    const groups = pickerGroups([renamed, twin], KNOWN);
    expect(groups[0]!.options.map((o) => o.label).sort()).toEqual([
      "3B · OpenRouter — Llama 3.2",
      "3B · OpenRouter — llama 3.2 3b",
    ]);
  });
});

describe("ratings", () => {
  it("reads, averages and lists scores", () => {
    expect(ratingFor(llamaLocal, "tool CALLING")).toBe(8);
    expect(ratingFor(llamaLocal, "Coding")).toBeNull();
    expect(ratingsAverage(llamaLocal.ratings)).toBe(7);
    expect(ratingsAverage([])).toBeNull();
    expect(ratingsLine(llamaLocal.ratings)).toBe("Tool calling 8 · Responsiveness 6");
    expect(criteriaInUse([llamaLocal, entry({ name: "x", ratings: [{ criterion: "tool calling", score: 1 }, { criterion: "Coding", score: 5 }] })])).toEqual([
      "Coding",
      "Responsiveness",
      "Tool calling",
    ]);
  });

  it("filters by 'best for' and sorts best first", () => {
    const coder = entry({ name: "Coder", ratings: [{ criterion: "Coding", score: 9 }] });
    const weak = entry({ name: "Weak", ratings: [{ criterion: "Coding", score: 3 }] });
    expect(filterEntries([coder, weak, llamaLocal], { criterion: "coding" }).map((e) => e.name)).toEqual(["Coder", "Weak"]);
    expect([weak, llamaLocal, coder].sort(compareEntriesBy("rating", "Coding")).map((e) => e.name)).toEqual([
      "Coder",
      "Weak",
      "Maja local",
    ]);
    expect([coder, llamaLocal].sort(compareEntriesBy("rating")).map((e) => e.name)).toEqual(["Coder", "Maja local"]);
  });

  it("explains bad score rows", () => {
    expect(ratingsIssue([{ criterion: "Coding", score: 7 }, { criterion: "", score: "" }])).toBeNull();
    expect(ratingsIssue([{ criterion: "Coding", score: 7 }, { criterion: "coding", score: 3 }])).toContain("two scores");
    expect(ratingsIssue([{ criterion: "Coding", score: 11 }])).toContain("0 to 10");
    expect(ratingsIssue([{ criterion: "Coding", score: "7.5" }])).toContain("whole number");
  });
});

describe("add dialog prefill", () => {
  it("reads Claude ids, old and new spellings", () => {
    expect(claudeIdentity("claude-sonnet-5")).toEqual({ family: "Claude Sonnet", variant: "5" });
    expect(claudeIdentity("claude-haiku-4-5-20251001")).toEqual({ family: "Claude Haiku", variant: "4.5" });
    expect(claudeIdentity("claude-opus-5-5")).toEqual({ family: "Claude Opus", variant: "5.5" });
    expect(claudeIdentity("gpt-4.1")).toBeNull();
  });

  it("offers the right ids per provider, installed tags first for your PC", () => {
    expect(modelIdChoices("anthropic", { known: KNOWN }).map((c) => c.value)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
    const local = modelIdChoices("local", { known: KNOWN, installedTags: ["llama3.2:latest", "mystery:7b"] });
    expect(local.slice(0, 2)).toEqual([
      { value: "llama3.2:latest", label: "Installed on your PC" },
      { value: "mystery:7b", label: "Installed on your PC" },
    ]);
    // llama3.2:3b is the same file as the installed llama3.2:latest, so it is not offered twice.
    expect(local.map((c) => c.value)).not.toContain("llama3.2:3b");
    expect(local.map((c) => c.value)).toContain("llama3.2:1b");
    const router = modelIdChoices("openrouter", { known: KNOWN });
    expect(router.find((c) => c.value === "qwen/qwen3-32b")?.label).toBe("Qwen3 32B");
    expect(modelIdChoices("huggingface", { known: KNOWN }).map((c) => c.value)).toEqual(["Qwen/Qwen3-14B:featherless-ai"]);
  });

  it("fills a Claude setup", () => {
    expect(prefillForModel("anthropic", "claude-sonnet-5", { known: KNOWN })).toMatchObject({
      name: "Claude Sonnet 5",
      maker: "Anthropic",
      family: "Claude Sonnet",
      variant: "5",
      lane: "both",
      availability: "cloud",
      note: expect.stringContaining("no key to add"),
    });
  });

  it("fills known local and OpenRouter models, and marks installed tags", () => {
    expect(prefillForModel("local", "llama3.2:1b", { known: KNOWN, localAddress: PC, gpuVramGb: 12, installedTags: ["llama3.2:1b"] })).toMatchObject({
      name: "Llama 3.2 1B on your PC",
      maker: "Meta",
      family: "Llama 3.2",
      variant: "1B",
      baseUrl: PC,
      availability: "installed",
      specs: { params: "1B", quant: "Q8_0", sizeGb: 1.3, fitsLocalGpu: "yes", pullCommand: "ollama pull llama3.2:1b" },
    });
    expect(prefillForModel("local", "qwen3:14b", { known: KNOWN }).availability).toBe("planned");
    expect(prefillForModel("openrouter", "qwen/qwen3-32b", { known: KNOWN })).toMatchObject({
      providerRouting: { only: ["deepinfra", "together"] },
      availability: "cloud",
      variant: "32B",
    });
    expect(prefillForModel("openrouter", "who/knows", { known: KNOWN })).toEqual({
      availability: "cloud",
      lane: "quick",
      name: "who/knows via OpenRouter",
    });
  });
});
