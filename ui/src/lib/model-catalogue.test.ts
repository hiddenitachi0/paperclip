import { describe, expect, it } from "vitest";
import type { ModelDirectoryEntry } from "@paperclipai/shared";
import {
  availabilityLabel,
  baseModelsInUse,
  catalogueFileName,
  cloudProvidersInUse,
  countsLine,
  describeSpecs,
  duplicateLabel,
  filterEntries,
  findDuplicates,
  formatContextTokens,
  groupEntries,
  hasActiveFilters,
  importPreview,
  laneLabel,
  makersInUse,
  noteFirstLine,
  parseCatalogueFile,
  parseTags,
  tagsInUse,
  tagsIssue,
  whereLabel,
} from "./model-catalogue";

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

const gemmaSmall = entry({ name: "Gemma small", maker: "Google", baseModel: "Gemma 4 12B", lane: "quick", availability: "installed", tags: ["vision"] });
const gemmaFav = entry({ name: "Zeta gemma", maker: "google", baseModel: "gemma 4 12b", favorite: true, lane: "both" });
const gemmaBig = entry({ name: "Gemma big", maker: "Google", baseModel: "Gemma 4 27B", provider: "huggingface", availability: "cloud" });
const googleLoose = entry({ name: "Google loose", maker: "Google" });
const qwen = entry({ name: "Qwen coder", maker: "Alibaba", baseModel: "Qwen3", provider: "openrouter", lane: "full", tags: ["code", "tools"], note: "Great for code\nsecond line" });
const nomaker = entry({ name: "Mystery", provider: "openai" });
const archived = entry({ name: "Old llama", maker: "Meta", archivedAt: "2026-10-02T00:00:00Z", tags: ["old"] });
const ALL = [gemmaSmall, gemmaFav, gemmaBig, googleLoose, qwen, nomaker, archived];

describe("labels", () => {
  it("says where, what for and status in plain words", () => {
    expect(whereLabel("local")).toBe("On your PC");
    expect(whereLabel("openrouter")).toBe("OpenRouter");
    expect(whereLabel("huggingface")).toBe("Hugging Face");
    expect(laneLabel("quick")).toBe("Quick chat");
    expect(laneLabel("full")).toBe("Full runs");
    expect(laneLabel("both")).toBe("Both");
    expect(laneLabel(null)).toBe("Not set");
    expect(availabilityLabel("installed")).toBe("Installed");
    expect(availabilityLabel("downloading")).toBe("Downloading");
    expect(availabilityLabel("planned")).toBe("Planned");
    expect(availabilityLabel("cloud")).toBe("Cloud");
    expect(availabilityLabel(null)).toBe("Not set");
  });
});

describe("groupEntries", () => {
  it("groups by maker then base model, case-insensitively, with Other and No base model last", () => {
    const groups = groupEntries(ALL, "maker");
    expect(groups.map((g) => g.title)).toEqual(["Alibaba", "Google", "Meta", "Other"]);
    const google = groups[1]!;
    expect(google.key).toBe("maker-google");
    expect(google.subgroups!.map((s) => s.title)).toEqual(["Gemma 4 12B", "Gemma 4 27B", "No base model"]);
    expect(google.subgroups!.map((s) => s.unset)).toEqual([false, false, true]);
    // Favourite first inside its base model, then by name.
    expect(google.subgroups![0]!.entries.map((e) => e.name)).toEqual(["Zeta gemma", "Gemma small"]);
    expect(google.entries.map((e) => e.name)).toEqual(["Zeta gemma", "Gemma small", "Gemma big", "Google loose"]);
    expect(groups[3]!.key).toBe("maker-other");
    expect(groups[3]!.entries.map((e) => e.name)).toEqual(["Mystery"]);
  });

  it("groups by where it runs: your PC, OpenRouter, Hugging Face, then the rest", () => {
    const groups = groupEntries(ALL, "where");
    expect(groups.map((g) => g.title)).toEqual(["On your PC", "OpenRouter", "Hugging Face", "OpenAI"]);
    expect(groups.map((g) => g.key)).toEqual(["where-local", "where-openrouter", "where-huggingface", "where-openai"]);
    expect(groups[0]!.subgroups).toBeUndefined();
    // Archived entries sort after active ones.
    expect(groups[0]!.entries.at(-1)!.name).toBe("Old llama");
  });

  it("groups by what it's for with Not set last", () => {
    const groups = groupEntries(ALL, "use");
    expect(groups.map((g) => g.title)).toEqual(["Quick chat", "Full runs", "Both", "Not set"]);
    expect(groups.map((g) => g.key)).toEqual(["use-quick", "use-full", "use-both", "use-unset"]);
  });

  it("puts everything in one sorted group when not grouping, and nothing when empty", () => {
    const groups = groupEntries(ALL, "none");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries[0]!.name).toBe("Zeta gemma");
    expect(groupEntries([], "none")).toEqual([]);
    expect(groupEntries([], "maker")).toEqual([]);
  });
});

describe("filterEntries", () => {
  it("hides archived entries unless asked", () => {
    expect(filterEntries(ALL, {}).map((e) => e.name)).not.toContain("Old llama");
    expect(filterEntries(ALL, { showArchived: true }).map((e) => e.name)).toContain("Old llama");
  });

  it("searches name, model id, maker, base model, tags and note; every word must match", () => {
    expect(filterEntries(ALL, { search: "GREAT code" }).map((e) => e.name)).toEqual(["Qwen coder"]);
    expect(filterEntries(ALL, { search: "alibaba" }).map((e) => e.name)).toEqual(["Qwen coder"]);
    expect(filterEntries(ALL, { search: "27b" }).map((e) => e.name)).toEqual(["Gemma big"]);
    expect(filterEntries(ALL, { search: "vision" }).map((e) => e.name)).toEqual(["Gemma small"]);
    expect(filterEntries(ALL, { search: gemmaBig.model }).map((e) => e.name)).toEqual(["Gemma big"]);
    expect(filterEntries(ALL, { search: "gemma nothing" })).toEqual([]);
  });

  it("filters by where, use, status and tags", () => {
    expect(filterEntries(ALL, { where: "local" }).map((e) => e.name)).toEqual(["Gemma small", "Zeta gemma", "Google loose"]);
    expect(filterEntries(ALL, { where: "cloud" }).map((e) => e.name)).toEqual(["Gemma big", "Qwen coder", "Mystery"]);
    expect(filterEntries(ALL, { where: "openrouter" }).map((e) => e.name)).toEqual(["Qwen coder"]);
    // "Quick chat" also shows models marked for both.
    expect(filterEntries(ALL, { use: "quick" }).map((e) => e.name)).toEqual(["Gemma small", "Zeta gemma"]);
    expect(filterEntries(ALL, { use: "full" }).map((e) => e.name)).toEqual(["Zeta gemma", "Qwen coder"]);
    expect(filterEntries(ALL, { use: "both" }).map((e) => e.name)).toEqual(["Zeta gemma"]);
    expect(filterEntries(ALL, { use: "unset" }).map((e) => e.name)).toEqual(["Gemma big", "Google loose", "Mystery"]);
    expect(filterEntries(ALL, { availability: "cloud" }).map((e) => e.name)).toEqual(["Gemma big"]);
    expect(filterEntries(ALL, { availability: "unset" })).toHaveLength(4);
    expect(filterEntries(ALL, { tags: ["code", "tools"] }).map((e) => e.name)).toEqual(["Qwen coder"]);
    expect(filterEntries(ALL, { tags: ["code", "vision"] })).toEqual([]);
  });

  it("knows when any filter is on", () => {
    expect(hasActiveFilters({ showArchived: true })).toBe(false);
    expect(hasActiveFilters({ search: "  " })).toBe(false);
    expect(hasActiveFilters({ search: "x" })).toBe(true);
    expect(hasActiveFilters({ tags: ["a"] })).toBe(true);
    expect(hasActiveFilters({ where: "cloud" })).toBe(true);
  });
});

describe("suggestions", () => {
  it("lists tags, makers and base models in use", () => {
    expect(tagsInUse(ALL)).toEqual(["code", "old", "tools", "vision"]);
    expect(makersInUse(ALL)).toEqual(["Alibaba", "Google", "Meta"]);
    expect(baseModelsInUse(ALL)).toEqual(["Gemma 4 12B", "Gemma 4 27B", "Qwen3"]);
    expect(baseModelsInUse(ALL, "alibaba")).toEqual(["Qwen3"]);
    expect(cloudProvidersInUse(ALL)).toEqual(["openrouter", "huggingface", "openai"]);
  });
});

describe("findDuplicates", () => {
  it("matches provider + model id + address, ignoring case and a trailing slash", () => {
    const a = entry({ name: "A", model: "Qwen3:14b", baseUrl: "http://100.1.1.1:11434/v1/" });
    const b = entry({ name: "B", model: "qwen3:14b", baseUrl: "HTTP://100.1.1.1:11434/v1" });
    const c = entry({ name: "C", model: "qwen3:14b", baseUrl: "http://100.1.1.1:11434/v1" });
    const otherAddress = entry({ name: "D", model: "qwen3:14b", baseUrl: "http://100.9.9.9:11434/v1" });
    const otherProvider = entry({ name: "E", model: "qwen3:14b", provider: "openrouter", baseUrl: null });
    const dupes = findDuplicates([a, b, c, otherAddress, otherProvider]);
    expect(dupes.get(a.id)).toEqual(["B", "C"]);
    expect(dupes.get(b.id)).toEqual(["A", "C"]);
    expect(dupes.has(otherAddress.id)).toBe(false);
    expect(dupes.has(otherProvider.id)).toBe(false);
    expect(duplicateLabel(["B"])).toBe("Same model as B");
    expect(duplicateLabel(["B", "C"])).toBe("Same model as B +1");
  });
});

describe("texts", () => {
  it("describes specs in one short line", () => {
    expect(
      describeSpecs({ params: "27B", quant: "Q4_K_M", sizeGb: 16.5, fitsLocalGpu: "tight", tools: "yes", vision: true }),
    ).toBe("27B · Q4_K_M · 16.5 GB · fits your GPU: tight · tools: yes · vision");
    expect(describeSpecs({ contextTokens: 131072, thinking: "toggle", vision: false })).toBe("128K context · thinking on/off");
    expect(describeSpecs({ thinking: "yes", sizeGb: 4 })).toBe("4 GB · thinking");
    expect(describeSpecs(null)).toBe("");
    expect(describeSpecs({})).toBe("");
    expect(formatContextTokens(32768)).toBe("32K");
    expect(formatContextTokens(128000)).toBe("128K");
    expect(formatContextTokens(1_000_000)).toBe("1M");
    expect(formatContextTokens(512)).toBe("512");
  });

  it("takes the first line of a note", () => {
    expect(noteFirstLine("\n  Great for code\n\nmore")).toEqual({ first: "Great for code", more: true });
    expect(noteFirstLine("One line")).toEqual({ first: "One line", more: false });
    expect(noteFirstLine(null)).toEqual({ first: "", more: false });
  });

  it("counts active models by place, archived separately", () => {
    expect(countsLine(ALL)).toBe("6 models · 3 on your PC · 3 in the cloud · 1 archived");
    expect(countsLine([gemmaSmall])).toBe("1 model · 1 on your PC · 0 in the cloud");
    expect(countsLine(ALL, 2)).toBe("6 models · 3 on your PC · 3 in the cloud · 1 archived · 2 shown");
  });

  it("reads comma-separated tags and checks them", () => {
    expect(parseTags("Uncensored, vision, , VISION ")).toEqual(["uncensored", "vision"]);
    expect(parseTags("")).toEqual([]);
    expect(tagsIssue(["a"])).toBeNull();
    expect(tagsIssue(Array.from({ length: 13 }, (_, i) => `t${i}`))).toContain("at most 12");
    expect(tagsIssue(["x".repeat(33)])).toContain("too long");
  });
});

describe("export / import", () => {
  it("names the export file after the company and the day", () => {
    expect(catalogueFileName("Nordstrand Interiørdesign AS", new Date(2026, 9, 8))).toBe(
      "paperclip-models-nordstrand-interiordesign-as-2026-10-08.json",
    );
    expect(catalogueFileName(null, new Date(2026, 0, 2))).toBe("paperclip-models-company-2026-01-02.json");
  });

  it("reads an exported file or a bare list", () => {
    const one = { name: "Qwen", provider: "openrouter", model: "qwen/qwen3-14b", tags: ["Code", "code"] };
    const file = parseCatalogueFile(JSON.stringify({ version: 1, exportedAt: "2026-10-08T00:00:00Z", entries: [one] }));
    expect(file).toEqual({ ok: true, entries: [expect.objectContaining({ name: "Qwen", tags: ["code"] })] });
    expect(parseCatalogueFile(JSON.stringify([one])).ok).toBe(true);
  });

  it("reads back an entry exactly as Export writes it", () => {
    const exported = {
      name: "Maja local",
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://100.1.1.1:11434/v1",
      providerRouting: null,
      defaultThinking: null,
      defaultTemperature: null,
      defaultMaxOutputTokens: null,
      note: null,
      maker: null,
      baseModel: null,
      lane: null,
      availability: null,
      tags: [],
      specs: null,
      favorite: false,
      backupNames: [],
      archived: true,
    };
    const file = parseCatalogueFile(JSON.stringify({ version: 1, exportedAt: "2026-10-08T00:00:00Z", entries: [exported] }));
    expect(file.ok).toBe(true);
  });

  it("explains what is wrong with a bad file", () => {
    expect(parseCatalogueFile("not json")).toEqual({ ok: false, error: expect.stringContaining("not a list of models") });
    expect(parseCatalogueFile("{}")).toEqual({ ok: false, error: expect.stringContaining("not a list of models") });
    expect(parseCatalogueFile('{"entries":[]}')).toEqual({ ok: false, error: "This file has no models in it." });
    expect(parseCatalogueFile('{"version":9,"entries":[{}]}')).toEqual({
      ok: false,
      error: expect.stringContaining("different version"),
    });
    const bad = parseCatalogueFile(JSON.stringify({ entries: [{ name: "Broken", provider: "nowhere", model: "m" }] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^Model 1 \("Broken"\)/);
    const twice = parseCatalogueFile(
      JSON.stringify([
        { name: "Same", provider: "openrouter", model: "a/b" },
        { name: "same", provider: "openrouter", model: "a/c" },
      ]),
    );
    expect(!twice.ok && twice.error).toContain("listed twice");
  });

  it("previews which names are new and which are already here", () => {
    expect(importPreview([{ name: "A" }, { name: "maja LOCAL" }], [{ name: "Maja local" }])).toEqual({
      fresh: ["A"],
      existing: ["maja LOCAL"],
    });
  });
});
