// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";

/**
 * The agent's Tools tab: the Tools-library checkboxes it always had, plus
 * "Tools from add-ons" — one tick per tool an installed add-on offers, written
 * to agents.plugin_tool_grants through the existing sync route. With no
 * add-on installed it says, in one line, where to install one. Add-on tools
 * are grouped by the label their add-on gives them, each group with a
 * "Turn all on/off" button, and long descriptions fold behind "More".
 */

const AGENT = "22222222-2222-4222-8222-222222222222";
const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockMcpApi = vi.hoisted(() => ({ listForAgent: vi.fn(), syncAgentSelection: vi.fn() }));
const mockPluginsApi = vi.hoisted(() => ({ agentToolGrants: vi.fn(), syncAgentToolGrants: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
  useBeforeUnload: () => {},
  Navigate: () => null,
}));
// The Markdown editor drags in a code sandbox library that cannot start in jsdom.
vi.mock("../components/MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("../api/mcpToolLibrary", () => ({ mcpToolLibraryApi: mockMcpApi }));
vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));

const { AgentToolsTab } = await import("./AgentDetail");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const generateImage = {
  name: "paperclip.media-studio:generate-image",
  toolName: "generate-image",
  displayName: "Generate image",
  description: "Make a picture from a short description.",
  parametersSchema: { type: "object", properties: {} },
  pluginId: "p1",
  pluginKey: "paperclip.media-studio",
  pluginDisplayName: "Media Studio",
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    companyId: COMPANY,
    name: "Front desk",
    role: "secretary",
    status: "active",
    adapterType: "claude_local",
    laneAEnabled: true,
    ...overrides,
  } as Agent;
}

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("AgentToolsTab add-on tools", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockMcpApi.listForAgent.mockResolvedValue([
      { id: "t1", name: "Fal.ai", description: "Generates images", enabled: true },
    ]);
    mockMcpApi.syncAgentSelection.mockResolvedValue({ id: AGENT, mcpToolIds: ["t1"] });
    mockPluginsApi.syncAgentToolGrants.mockResolvedValue({ id: AGENT, pluginToolGrants: [] });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: Agent) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentToolsTab agent={props} companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  const addOnCheckbox = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="add-on-tools"] button[role="checkbox"]');

  it("lists each add-on tool with its plugin's name and description, ticked when granted", async () => {
    mockPluginsApi.agentToolGrants.mockResolvedValue({
      grantedToolNames: [generateImage.name],
      unrestricted: false,
      availableTools: [generateImage],
    });
    const root = await render(agent());

    const section = container.querySelector('[data-testid="add-on-tools"]');
    expect(section?.textContent).toContain("Tools from add-ons");
    expect(section?.textContent).toContain("Generate image");
    expect(section?.textContent).toContain("from Media Studio");
    expect(section?.textContent).toContain("Make a picture from a short description.");
    expect(section?.textContent).toContain("A quick agent only gets the tools ticked here");
    expect(addOnCheckbox()?.getAttribute("aria-checked")).toBe("true");
    // The Tools-library list is still there above it.
    expect(container.textContent).toContain("Fal.ai");

    await act(async () => {
      root.unmount();
    });
  });

  it("ticking a tool writes the grant through the sync route; unticking removes it", async () => {
    mockPluginsApi.agentToolGrants
      // First load: nothing ticked. Every load after the tick: ticked.
      .mockResolvedValueOnce({ grantedToolNames: [], unrestricted: true, availableTools: [generateImage] })
      .mockResolvedValue({ grantedToolNames: [generateImage.name], unrestricted: false, availableTools: [generateImage] });
    const root = await render(agent());
    expect(addOnCheckbox()?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      addOnCheckbox()?.click();
    });
    await flushReact();
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledWith(AGENT, [generateImage.name]);
    // The list was re-read after the sync and now shows the tick.
    expect(mockPluginsApi.agentToolGrants).toHaveBeenCalledTimes(2);
    expect(addOnCheckbox()?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      addOnCheckbox()?.click();
    });
    await flushReact();
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenLastCalledWith(AGENT, []);
    // The Tools-library sync was never touched by an add-on tick.
    expect(mockMcpApi.syncAgentSelection).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("says where to install an add-on when none offers a tool", async () => {
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    const root = await render(agent({ laneAEnabled: false }));

    const empty = container.querySelector('[data-testid="add-on-tools-empty"]');
    expect(empty?.textContent).toContain("No add-on tools yet");
    expect(empty?.textContent).toContain("Instance settings → Plugins");
    expect(empty?.textContent).toContain("Media Studio");
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe("/company/settings/instance/plugins");
    // For a full agent the text says what "nothing ticked" means.
    expect(container.querySelector('[data-testid="add-on-tools"]')?.textContent).toContain(
      "While nothing is ticked, a full agent may use every add-on tool",
    );

    await act(async () => {
      root.unmount();
    });
  });
});

describe("AgentToolsTab layout and add-on tool groups", () => {
  let container: HTMLDivElement;

  function addOnTool(toolName: string, displayName: string, extra: Record<string, unknown> = {}) {
    return {
      ...generateImage,
      name: `paperclip.media-studio:${toolName}`,
      toolName,
      displayName,
      description: `${displayName} does one thing. It also does a second, longer thing.`,
      ...extra,
    };
  }

  const pictures = addOnTool("generate-image", "Generate image", { category: "Pictures" });
  const quick = addOnTool("quick-picture", "Quick picture", { category: "Pictures" });
  const upscale = addOnTool("sogni-upscale-image", "Upscale picture", { category: "Picture editing" });
  const video = addOnTool("generate-video", "Generate video", { category: "Video and sound" });
  const acme = {
    ...addOnTool("ping", "Ping"),
    name: "acme.tools:ping",
    pluginKey: "acme.tools",
    pluginDisplayName: "Acme",
  };
  const charts = { ...acme, name: "acme.tools:chart", toolName: "chart", displayName: "Draw chart", category: "Charts" };

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockMcpApi.listForAgent.mockResolvedValue([
      { id: "t1", name: "Fal.ai", description: "Generates images", enabled: true },
      { id: "t2", name: "Search", description: "Searches", enabled: false },
    ]);
    mockMcpApi.syncAgentSelection.mockResolvedValue({ id: AGENT, mcpToolIds: ["t1"] });
    mockPluginsApi.syncAgentToolGrants.mockResolvedValue({ id: AGENT, pluginToolGrants: [] });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: Agent) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentToolsTab agent={props} companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  const groups = () => [...container.querySelectorAll<HTMLElement>('[data-testid="add-on-tools-group"]')];
  const groupTitle = (group: HTMLElement) => group.querySelector("button span span")?.textContent;
  const groupNamed = (title: string) => groups().find((group) => groupTitle(group) === title)!;
  const toggleIn = (group: HTMLElement) =>
    group.querySelector<HTMLButtonElement>('[data-testid="add-on-tools-group-toggle"]')!;

  it("shows three titled sections in order: library, add-ons, tools with a key", async () => {
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    const root = await render(agent());

    const ids = [...container.querySelectorAll("section[data-testid]")].map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["library-tools", "add-on-tools", "agent-api-tools"]);
    const library = container.querySelector('[data-testid="library-tools"]')!;
    expect(library.textContent).toContain("Tools from the library");
    expect(library.textContent).toContain("Fal.ai");

    // Folding the library section away leaves a count in its heading.
    await act(async () => {
      library.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(library.getAttribute("data-state")).toBe("closed");
    expect(library.textContent).toContain("1 of 2 on");
    expect(window.localStorage.getItem("paperclip.settingsSection.agent.tools.library")).toBe("0");

    await act(async () => {
      root.unmount();
    });
  });

  it("groups add-on tools by their category: Pictures, Picture editing, Video and sound, then the rest A to Z", async () => {
    mockPluginsApi.agentToolGrants.mockResolvedValue({
      grantedToolNames: [quick.name],
      unrestricted: false,
      availableTools: [video, charts, acme, upscale, pictures, quick, { ...acme, name: "x:y", pluginDisplayName: "" }],
    });
    const root = await render(agent());

    expect(groups().map(groupTitle)).toEqual([
      "Pictures",
      "Picture editing",
      "Video and sound",
      "Acme",
      "Charts",
      "Other tools",
    ]);
    const picturesGroup = groupNamed("Pictures");
    expect(
      [...picturesGroup.querySelectorAll('button[role="checkbox"]')].map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Generate image from Media Studio", "Quick picture from Media Studio"]);
    // Each group remembers its own open/closed state and shows a count when closed.
    await act(async () => {
      picturesGroup.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(picturesGroup.textContent).toContain("1 of 2 on");
    expect(window.localStorage.getItem("paperclip.settingsSection.agent.tools.addOns.pictures")).toBe("0");

    await act(async () => {
      root.unmount();
    });
  });

  it("'Turn all on' ticks a whole group in one sync call; 'Turn all off' unticks only that group", async () => {
    mockPluginsApi.agentToolGrants
      .mockResolvedValueOnce({
        grantedToolNames: [quick.name, video.name],
        unrestricted: false,
        availableTools: [pictures, quick, video],
      })
      .mockResolvedValue({
        grantedToolNames: [quick.name, video.name, pictures.name],
        unrestricted: false,
        availableTools: [pictures, quick, video],
      });
    const root = await render(agent());

    expect(toggleIn(groupNamed("Pictures")).textContent).toBe("Turn all on");
    expect(toggleIn(groupNamed("Video and sound")).textContent).toBe("Turn all off");

    await act(async () => {
      toggleIn(groupNamed("Pictures")).click();
    });
    await flushReact();
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledTimes(1);
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledWith(AGENT, [quick.name, video.name, pictures.name]);
    expect(toggleIn(groupNamed("Pictures")).textContent).toBe("Turn all off");

    await act(async () => {
      toggleIn(groupNamed("Pictures")).click();
    });
    await flushReact();
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledTimes(2);
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenLastCalledWith(AGENT, [video.name]);
    // A group button never folds the group away.
    expect(groupNamed("Pictures").getAttribute("data-state")).toBe("open");

    await act(async () => {
      root.unmount();
    });
  });

  it("on a full agent with nothing ticked, a group button says 'Allow only these' and limits the agent to that group", async () => {
    mockPluginsApi.agentToolGrants
      .mockResolvedValueOnce({ grantedToolNames: [], unrestricted: true, availableTools: [pictures, quick, video] })
      .mockResolvedValue({
        grantedToolNames: [pictures.name, quick.name],
        unrestricted: false,
        availableTools: [pictures, quick, video],
      });
    const root = await render(agent({ laneAEnabled: false }));

    expect(toggleIn(groupNamed("Pictures")).textContent).toBe("Allow only these");
    expect(toggleIn(groupNamed("Pictures")).getAttribute("aria-label")).toBe("Allow only these: Pictures");
    expect(toggleIn(groupNamed("Video and sound")).textContent).toBe("Allow only these");

    await act(async () => {
      toggleIn(groupNamed("Pictures")).click();
    });
    await flushReact();
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledTimes(1);
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledWith(AGENT, [pictures.name, quick.name]);

    // Now only Pictures is ticked: unticking it would allow everything again, and the button says so.
    expect(toggleIn(groupNamed("Pictures")).textContent).toBe("Allow all add-on tools");
    expect(toggleIn(groupNamed("Video and sound")).textContent).toBe("Turn all on");

    await act(async () => {
      toggleIn(groupNamed("Pictures")).click();
    });
    await flushReact();
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenCalledTimes(2);
    expect(mockPluginsApi.syncAgentToolGrants).toHaveBeenLastCalledWith(AGENT, []);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows only a tool's first sentence until 'More' is pressed", async () => {
    mockPluginsApi.agentToolGrants.mockResolvedValue({
      grantedToolNames: [],
      unrestricted: true,
      availableTools: [pictures],
    });
    const root = await render(agent({ laneAEnabled: false }));

    const row = container.querySelector('[data-testid="add-on-tool"]')!;
    expect(row.textContent).toContain("Generate image does one thing.");
    expect(row.textContent).not.toContain("second, longer thing");
    const more = row.querySelector<HTMLButtonElement>('[data-testid="add-on-tool-more"]')!;
    expect(more.textContent).toBe("More");
    expect(more.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      more.click();
    });
    expect(row.textContent).toContain("It also does a second, longer thing.");
    expect(more.textContent).toBe("Less");

    // A full agent with nothing ticked may use them all, and the folded group says so.
    await act(async () => {
      groupNamed("Pictures").querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(groupNamed("Pictures").textContent).toContain("None ticked, so all 1 allowed");

    await act(async () => {
      root.unmount();
    });
  });
});
