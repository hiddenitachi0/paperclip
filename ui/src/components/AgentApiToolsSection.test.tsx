// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApiToolsSection } from "./AgentApiToolsSection";
import type { AgentApiToolListItem } from "../api/apiTools";

/**
 * DUR-4004: the "Tools with a key" section on an agent's Tools tab. One
 * checkbox per API tool; ticking sends the full list of ticked ids, exactly
 * like the MCP tool checkboxes above it.
 */

const AGENT = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";

const mockApiToolsApi = vi.hoisted(() => ({ listForAgent: vi.fn(), syncAgentSelection: vi.fn() }));
vi.mock("../api/apiTools", () => ({ apiToolsApi: mockApiToolsApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function tool(id: string, name: string, enabled: boolean, extra: Partial<AgentApiToolListItem> = {}): AgentApiToolListItem {
  return {
    id,
    companyId: COMPANY,
    name,
    key: name.toLowerCase(),
    description: `${name} does things`,
    baseUrl: "https://example.com",
    auth: { kind: "bearer", secretId: "33333333-3333-4333-8333-333333333333" },
    actions: [
      { name: "list", method: "GET", path: "/list", description: "", inputs: [] },
      { name: "create", method: "POST", path: "/create", description: "", inputs: [] },
    ],
    openapiUrl: null,
    dailyCap: 300,
    status: "active",
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    enabled,
    ...extra,
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("AgentApiToolsSection", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApiToolsApi.syncAgentSelection.mockResolvedValue({ id: AGENT, apiToolIds: [] });
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <AgentApiToolsSection agentId={AGENT} companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("says where to add one when the company has no API tools", async () => {
    mockApiToolsApi.listForAgent.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("Tools with a key");
    expect(container.textContent).toContain('No API tools yet. Add one on the Tools page ("Add tool", then "API with a key")');
    expect(container.querySelector('button[role="checkbox"]')).toBeNull();
  });

  it("lists each tool with its actions and state; ticking one sends the full list of ticked ids", async () => {
    mockApiToolsApi.listForAgent.mockResolvedValue([
      tool("a", "Fal", true),
      tool("b", "Fiken", false, { status: "disabled" }),
    ]);
    await render();
    const boxes = container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.getAttribute("aria-checked")).toBe("true");
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Fal does things 2 actions: list, create.");
    expect(container.textContent).toContain("switched off");
    expect(boxes[0]!.getAttribute("aria-label")).toBe("Give this agent Fal");

    await act(async () => boxes[1]!.click());
    await flush();
    expect(mockApiToolsApi.syncAgentSelection).toHaveBeenCalledWith(AGENT, ["a", "b"]);

    await act(async () => boxes[0]!.click());
    await flush();
    expect(mockApiToolsApi.syncAgentSelection).toHaveBeenLastCalledWith(AGENT, []);
  });
});
