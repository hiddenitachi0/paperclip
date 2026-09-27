import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

/**
 * The one plugin-tool execute path (services/plugin-tool-execution.ts),
 * shared by POST /api/plugins/tools/execute (full agents) and the quick-agent
 * chat (lane-a.ts). What must hold: the same checks in the same order as the
 * route always had — tool found, plugin on for the company, agent granted,
 * then the worker — and the two grant rules: a full agent with nothing set
 * gets everything (`empty_means_all`), a quick agent with nothing ticked gets
 * nothing (`ticked_only`).
 */

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getCompanySettings: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const { checkPluginToolGrant, grantPolicyForAgent, pluginToolExecutionService } = await import(
  "../services/plugin-tool-execution.js",
);

const PLUGIN_DB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PLUGIN_DB_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const TOOL = "paperclip.media-studio:generate-image";
const runContext = { agentId: "agent-1", runId: "run-1", companyId: COMPANY, projectId: "" };

function dispatcherStub(overrides: Partial<PluginToolDispatcher> = {}): PluginToolDispatcher {
  return {
    listToolsForAgent: vi.fn(() => [
      {
        name: TOOL,
        displayName: "Generate image",
        description: "Make a picture.",
        parametersSchema: { type: "object", properties: {} },
        pluginId: PLUGIN_DB_ID,
      },
      {
        name: "acme.other:ping",
        displayName: "Ping",
        description: "Ping.",
        parametersSchema: { type: "object", properties: {} },
        pluginId: OTHER_PLUGIN_DB_ID,
      },
    ]),
    getTool: vi.fn((name: string) =>
      name === TOOL
        ? { pluginId: "paperclip.media-studio", pluginDbId: PLUGIN_DB_ID, name: "generate-image", namespacedName: TOOL }
        : name === "acme.other:ping"
          ? { pluginId: "acme.other", pluginDbId: OTHER_PLUGIN_DB_ID, name: "ping", namespacedName: name }
          : null,
    ),
    executeTool: vi.fn(async () => ({ pluginId: "paperclip.media-studio", toolName: "generate-image", result: { content: "ok" } })),
    ...overrides,
  } as unknown as PluginToolDispatcher;
}

describe("checkPluginToolGrant", () => {
  it("full agent: an empty list means every tool; a list narrows to exactly those names", () => {
    expect(checkPluginToolGrant([], TOOL, "empty_means_all")).toBeNull();
    expect(checkPluginToolGrant([TOOL], TOOL, "empty_means_all")).toBeNull();
    expect(checkPluginToolGrant(["acme.other:ping"], TOOL, "empty_means_all")).toContain("not granted");
  });

  it("quick agent: only a ticked tool passes; an empty list means none", () => {
    expect(checkPluginToolGrant([], TOOL, "ticked_only")).toContain("not granted");
    expect(checkPluginToolGrant([TOOL], TOOL, "ticked_only")).toBeNull();
    expect(checkPluginToolGrant(["acme.other:ping"], TOOL, "ticked_only")).toContain("not granted");
  });
});

describe("grantPolicyForAgent", () => {
  it("is decided by the agent row alone: a quick agent (lane_a_enabled) is ticked-only, anything else empty-means-all", () => {
    expect(grantPolicyForAgent({ laneAEnabled: true })).toBe("ticked_only");
    expect(grantPolicyForAgent({ laneAEnabled: false })).toBe("empty_means_all");
    expect(grantPolicyForAgent({ laneAEnabled: null })).toBe("empty_means_all");
    expect(grantPolicyForAgent({})).toBe("empty_means_all");
  });
});

describe("pluginToolExecutionService.execute", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.getCompanySettings.mockReset();
    mockRegistry.getCompanySettings.mockResolvedValue(null);
  });

  it("404s an unknown tool before touching the company flag or the worker", async () => {
    const dispatcher = dispatcherStub();
    const outcome = await pluginToolExecutionService({} as never, dispatcher).execute({
      tool: "nope:missing",
      parameters: {},
      runContext,
      agent: { laneAEnabled: false, pluginToolGrants: [] },
    });
    expect(outcome).toEqual({ ok: false, status: 404, error: 'Tool "nope:missing" not found' });
    expect(mockRegistry.getCompanySettings).not.toHaveBeenCalled();
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("403s when the company has switched the plugin off, even for an unrestricted full agent", async () => {
    mockRegistry.getCompanySettings.mockResolvedValue({ enabled: false });
    const dispatcher = dispatcherStub();
    const outcome = await pluginToolExecutionService({} as never, dispatcher).execute({
      tool: TOOL,
      parameters: {},
      runContext,
      agent: { laneAEnabled: false, pluginToolGrants: [] },
    });
    expect(outcome).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("disabled for this company") });
    expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(PLUGIN_DB_ID, COMPANY);
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("runs an unrestricted full agent's call (empty grants) through the worker with the run context", async () => {
    const dispatcher = dispatcherStub();
    const outcome = await pluginToolExecutionService({} as never, dispatcher).execute({
      tool: TOOL,
      parameters: { prompt: "a cat" },
      runContext,
      agent: { laneAEnabled: false, pluginToolGrants: [] },
    });
    expect(outcome).toMatchObject({ ok: true, result: { result: { content: "ok" } } });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(TOOL, { prompt: "a cat" }, runContext);
  });

  it("refuses a quick agent's call when the tool is not ticked (empty grants = none), and runs it when it is — on every path, since the rule comes from the row", async () => {
    const dispatcher = dispatcherStub();
    const service = pluginToolExecutionService({} as never, dispatcher);
    const refused = await service.execute({
      tool: TOOL,
      parameters: {},
      runContext,
      agent: { laneAEnabled: true, pluginToolGrants: [] },
    });
    expect(refused).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("not granted") });
    expect(dispatcher.executeTool).not.toHaveBeenCalled();

    const ran = await service.execute({
      tool: TOOL,
      parameters: {},
      runContext,
      agent: { laneAEnabled: true, pluginToolGrants: [TOOL] },
    });
    expect(ran.ok).toBe(true);
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);
  });

  it("maps a worker that is down to 502 and any other failure to 500", async () => {
    const down = dispatcherStub({
      executeTool: vi.fn(async () => {
        throw new Error('worker for plugin "paperclip.media-studio" is not running');
      }),
    });
    expect(
      await pluginToolExecutionService({} as never, down).execute({
        tool: TOOL,
        parameters: {},
        runContext,
        agent: { laneAEnabled: false, pluginToolGrants: [] },
      }),
    ).toMatchObject({ ok: false, status: 502 });

    const broken = dispatcherStub({
      executeTool: vi.fn(async () => {
        throw new Error("schema validation failed");
      }),
    });
    expect(
      await pluginToolExecutionService({} as never, broken).execute({
        tool: TOOL,
        parameters: {},
        runContext,
        agent: { laneAEnabled: false, pluginToolGrants: [] },
      }),
    ).toMatchObject({ ok: false, status: 500, error: "schema validation failed" });
  });
});

describe("pluginToolExecutionService.listToolsForCompany", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.getCompanySettings.mockReset();
  });

  it("lists only tools of ready plugins that are on for the company, with the plugin's name for the screen", async () => {
    mockRegistry.getById.mockImplementation(async (id: string) =>
      id === PLUGIN_DB_ID
        ? { id, pluginKey: "paperclip.media-studio", status: "ready", manifestJson: { displayName: "Media Studio" } }
        : { id, pluginKey: "acme.other", status: "error", manifestJson: { displayName: "Other" } },
    );
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    const tools = await pluginToolExecutionService({} as never, dispatcherStub()).listToolsForCompany(COMPANY);
    expect(tools).toEqual([
      expect.objectContaining({
        name: TOOL,
        toolName: "generate-image",
        displayName: "Generate image",
        pluginKey: "paperclip.media-studio",
        pluginDisplayName: "Media Studio",
      }),
    ]);
  });

  it("drops a ready plugin's tools when the company has switched that plugin off", async () => {
    mockRegistry.getById.mockImplementation(async (id: string) => ({
      id,
      pluginKey: id === PLUGIN_DB_ID ? "paperclip.media-studio" : "acme.other",
      status: "ready",
      manifestJson: { displayName: id === PLUGIN_DB_ID ? "Media Studio" : "Other" },
    }));
    mockRegistry.getCompanySettings.mockImplementation(async (pluginId: string) =>
      pluginId === PLUGIN_DB_ID ? { enabled: false } : null,
    );
    const tools = await pluginToolExecutionService({} as never, dispatcherStub()).listToolsForCompany(COMPANY);
    expect(tools.map((tool) => tool.name)).toEqual(["acme.other:ping"]);
  });
});
