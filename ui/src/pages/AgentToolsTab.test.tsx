// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";

/**
 * The agent's Tools tab: the Tools-library checkboxes it always had, plus
 * "Tools from add-ons" — one tick per tool an installed add-on offers, written
 * to agents.plugin_tool_grants through the existing sync route. With no
 * add-on installed it says, in one line, where to install one.
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
