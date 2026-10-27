import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PluginMediaLora, PluginMediaSetup } from "../src/protocol.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-media-library",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test media library",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: {},
  };
}

function setup(overrides: Partial<PluginMediaSetup>): PluginMediaSetup {
  return {
    id: "setup-1",
    companyId: "company-a",
    name: "Action",
    description: "",
    kind: "video",
    provider: "sogni",
    family: "h3",
    mode: "flf2v",
    modelId: "minimax-h3-fl2va-fp8_flf2v",
    editModelId: null,
    loras: [{ loraId: "lora-1", strength: 0.8, name: "Better Motion", ref: "h3-better-motion", source: "catalog", triggerWords: [], contentTag: "sfw" }],
    params: { promptExpansion: false },
    contentRating: "sfw",
    status: "approved",
    tags: [],
    favorite: false,
    notes: "",
    builtinKey: "action",
    billing: "sogni-unlimited",
    billingLabel: "Covered by the Sogni Unlimited plan",
    triggerWords: [],
    problems: [],
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

const betterMotion: PluginMediaLora = {
  id: "lora-1",
  companyId: "company-a",
  provider: "sogni",
  source: "catalog",
  ref: "h3-better-motion",
  name: "Better Motion",
  notes: "",
  triggerWords: [],
  family: "h3",
  compatibleModelIds: ["minimax-h3-fl2va-fp8_flf2v"],
  effectiveContentTag: "sfw",
  strengthMin: 0,
  strengthMax: 1.5,
  strengthDefault: 0.6,
  recommendedMin: 0.4,
  recommendedMax: 0.8,
};

// Film studio Phase 1: the test harness's stand-in for the host's read-only
// media library (ctx.mediaLibrary), for plugin tests.
describe("createTestHarness ctx.mediaLibrary", () => {
  it("refuses a plugin without media.library.read", async () => {
    const harness = createTestHarness({ manifest: manifest([]) });
    await expect(harness.ctx.mediaLibrary.listSetups("company-a")).rejects.toThrow(/media\.library\.read/);
    await expect(harness.ctx.mediaLibrary.resolve("company-a", "setup-1")).rejects.toThrow(/media\.library\.read/);
  });

  it("reads seeded rows of one company only, with the agent view and resolve", async () => {
    const harness = createTestHarness({ manifest: manifest(["media.library.read"]) });
    harness.seed({
      mediaSetups: [
        setup({}),
        setup({ id: "setup-2", name: "Natural", status: "draft" }),
        setup({ id: "setup-3", name: "Old", status: "archived" }),
        setup({ id: "setup-b", companyId: "company-b", name: "Theirs" }),
      ],
      mediaLoras: [betterMotion, { ...betterMotion, id: "lora-b", companyId: "company-b" }],
    });

    const lib = harness.ctx.mediaLibrary;
    expect((await lib.listSetups("company-a")).map((s) => s.name)).toEqual(["Action", "Natural"]);
    expect((await lib.listSetups("company-a", { approvedOnly: true })).map((s) => s.name)).toEqual(["Action"]);
    expect(await lib.getSetup("company-a", "setup-b")).toBeNull();
    expect(await lib.getSetup("company-a", "setup-2", { approvedOnly: true })).toBeNull();
    expect((await lib.listLoras("company-a")).map((l) => l.id)).toEqual(["lora-1"]);
    expect(await lib.getProjectDefaults("company-a")).toMatchObject({ defaultContentRating: "sfw", defaultContinuityMode: "stills" });

    const resolved = await lib.resolve("company-a", "setup-1", { approvedOnly: true });
    expect(resolved).toMatchObject({ usable: true, modelId: "minimax-h3-fl2va-fp8_flf2v", loras: [{ ref: "h3-better-motion", strength: 0.8 }] });
    expect(await lib.resolve("company-a", "setup-b")).toBeNull();
    expect(await lib.resolve("company-a", "setup-3")).toMatchObject({ usable: false, problems: [expect.stringMatching(/archived/)] });
  });
});
