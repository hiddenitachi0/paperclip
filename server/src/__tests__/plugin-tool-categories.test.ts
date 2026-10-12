import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

/**
 * A plugin tool's optional `category` (a plain group label such as
 * "Pictures") travels from the manifest, through the tool registry, to the
 * list an agent's Tools tab reads (GET /agents/:agentId/plugin-tool-grants →
 * listToolsForCompany), where the tools are grouped under it. Media Studio
 * sets one on every tool.
 */

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getCompanySettings: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const { pluginToolExecutionService } = await import("../services/plugin-tool-execution.js");
const { createPluginToolRegistry } = await import("../services/plugin-tool-registry.js");
const { default: mediaStudioManifest } = await import("../../../packages/plugins/media-studio/src/manifest.js");
const { pluginManifestValidator } = await import("../services/plugin-manifest-validator.js");

const PLUGIN_DB_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY = "33333333-3333-4333-8333-333333333333";

function manifestWithTools(tools: PaperclipPluginManifestV1["tools"]): PaperclipPluginManifestV1 {
  return {
    id: "acme.groups",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Acme",
    description: "Grouped tools.",
    author: "Acme",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "./dist/worker.js" },
    tools,
  } as PaperclipPluginManifestV1;
}

describe("plugin tool categories", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.getCompanySettings.mockReset();
  });

  it("the registry keeps a declared category and leaves it out when none is set", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin(
      "acme.groups",
      manifestWithTools([
        { name: "draw", displayName: "Draw", description: "Draws.", parametersSchema: { type: "object" }, category: "Pictures" },
        { name: "ping", displayName: "Ping", description: "Pings.", parametersSchema: { type: "object" } },
      ]),
      PLUGIN_DB_ID,
    );
    expect(registry.getTool("acme.groups:draw")?.category).toBe("Pictures");
    expect(registry.getTool("acme.groups:ping")).not.toHaveProperty("category");
  });

  it("listToolsForCompany passes each tool's category through to the Tools tab", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: PLUGIN_DB_ID,
      pluginKey: "acme.groups",
      status: "ready",
      manifestJson: { displayName: "Acme" },
    });
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    const dispatcher = {
      listToolsForAgent: vi.fn(() => [
        { name: "acme.groups:draw", displayName: "Draw", description: "Draws.", parametersSchema: {}, pluginId: PLUGIN_DB_ID },
        { name: "acme.groups:ping", displayName: "Ping", description: "Pings.", parametersSchema: {}, pluginId: PLUGIN_DB_ID },
      ]),
      getTool: vi.fn((name: string) =>
        name === "acme.groups:draw"
          ? { pluginId: "acme.groups", pluginDbId: PLUGIN_DB_ID, name: "draw", namespacedName: name, category: "Pictures" }
          : { pluginId: "acme.groups", pluginDbId: PLUGIN_DB_ID, name: "ping", namespacedName: name },
      ),
    } as unknown as PluginToolDispatcher;

    const tools = await pluginToolExecutionService({} as never, dispatcher).listToolsForCompany(COMPANY);
    expect(tools).toEqual([
      expect.objectContaining({ name: "acme.groups:draw", category: "Pictures", pluginDisplayName: "Acme" }),
      expect.objectContaining({ name: "acme.groups:ping", pluginDisplayName: "Acme" }),
    ]);
    expect(tools[1]).not.toHaveProperty("category");
  });

  it("Media Studio puts every tool in Pictures, Picture editing or Video and sound, and the manifest stays valid", () => {
    const byCategory = new Map<string, string[]>();
    for (const tool of mediaStudioManifest.tools ?? []) {
      expect(tool.category, tool.name).toBeTruthy();
      byCategory.set(tool.category!, [...(byCategory.get(tool.category!) ?? []), tool.name]);
    }
    expect([...byCategory.keys()].sort()).toEqual(["Picture editing", "Pictures", "Video and sound"]);
    expect(byCategory.get("Pictures")).toEqual(["generate-image", "quick-picture", "list-looks", "sogni-enhance-prompt"]);
    expect(byCategory.get("Video and sound")).toEqual(["generate-video", "generate-audio", "check-media-job"]);
    expect(byCategory.get("Picture editing")).toEqual([
      "sogni-upscale-image",
      "sogni-remove-background",
      "sogni-restore-photo",
      "sogni-change-angle",
      "sogni-apply-style",
      "sogni-segment-image",
    ]);

    const parsed = pluginManifestValidator().parse(mediaStudioManifest);
    expect(parsed.success).toBe(true);
  });
});
