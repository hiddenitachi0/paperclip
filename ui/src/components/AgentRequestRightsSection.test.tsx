// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequestRights } from "../api/agentRequestRights";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../api/agentRequestRights", () => ({ agentRequestRightsApi: mockApi }));
const mockPushToast = vi.hoisted(() => vi.fn());
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));

import { AgentRequestRightsSection } from "./AgentRequestRightsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rights(overrides: Partial<AgentRequestRights> = {}): AgentRequestRights {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    position: null,
    deploysRequest: { permissionKey: "deploys:request", enabled: false, source: "none", positionGivesIt: false, grantedByUserId: null, updatedAt: null },
    mergesRequest: { permissionKey: "merges:request", enabled: true, source: "agent", positionGivesIt: false, grantedByUserId: null, updatedAt: null },
    canChange: true,
    ...overrides,
  };
}

describe("Agent settings: what this agent may ask for", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.set.mockReset();
    mockPushToast.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <AgentRequestRightsSection agentId="agent-1" />
      </QueryClientProvider>,
    ));
    await flush();
  }

  function toggle(testId: string) {
    return container.querySelector(`[data-testid="${testId}"] button[role="switch"]`) as HTMLButtonElement;
  }

  it("explains both switches in plain words and shows their current state", async () => {
    mockApi.get.mockResolvedValue(rights());
    await render();
    expect(container.textContent).toContain("Can ask to put changes live");
    expect(container.textContent).toContain("A person still approves every one");
    expect(container.textContent).toContain("Can ask to merge finished code");
    expect(container.textContent).not.toContain("deploys:request");
    expect(toggle("agent-request-rights-deploy").getAttribute("aria-checked")).toBe("false");
    expect(toggle("agent-request-rights-merge").getAttribute("aria-checked")).toBe("true");
  });

  it("switches the deploy ask-right on for an owner or admin", async () => {
    mockApi.get.mockResolvedValue(rights());
    mockApi.set.mockResolvedValue(rights({
      deploysRequest: { permissionKey: "deploys:request", enabled: true, source: "agent", positionGivesIt: false, grantedByUserId: "u", updatedAt: null },
    }));
    await render();
    await act(async () => toggle("agent-request-rights-deploy").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockApi.set).toHaveBeenCalledWith("agent-1", { deploysRequest: true });
    expect(toggle("agent-request-rights-deploy").getAttribute("aria-checked")).toBe("true");
  });

  it("switches the merge ask-right off", async () => {
    mockApi.get.mockResolvedValue(rights());
    mockApi.set.mockResolvedValue(rights());
    await render();
    await act(async () => toggle("agent-request-rights-merge").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockApi.set).toHaveBeenCalledWith("agent-1", { mergesRequest: false });
  });

  it("is read-only for anyone who is not the owner or an admin", async () => {
    mockApi.get.mockResolvedValue(rights({ canChange: false }));
    await render();
    expect(toggle("agent-request-rights-deploy").disabled).toBe(true);
    expect(toggle("agent-request-rights-merge").disabled).toBe(true);
    expect(container.textContent).toContain("Only the company's owner or an admin can change these two.");
  });

  it("says when a right comes with the agent's position, or was switched off despite it", async () => {
    mockApi.get.mockResolvedValue(rights({
      position: { id: "role-1", name: "Boss" },
      deploysRequest: { permissionKey: "deploys:request", enabled: true, source: "position", positionGivesIt: true, grantedByUserId: null, updatedAt: null },
      mergesRequest: { permissionKey: "merges:request", enabled: false, source: "turned_off", positionGivesIt: true, grantedByUserId: null, updatedAt: null },
    }));
    await render();
    expect(container.textContent).toContain("Comes with the position “Boss”. Switching it off here changes only this agent.");
    expect(container.textContent).toContain("The position “Boss” normally gives this, but it is switched off for this agent.");
    expect(toggle("agent-request-rights-deploy").disabled).toBe(false);
  });

  it("shows a plain message when the change is refused", async () => {
    const { ApiError } = await import("../api/client");
    mockApi.get.mockResolvedValue(rights());
    mockApi.set.mockRejectedValue(new ApiError("Only the company's owner or an admin can change what an agent may ask for.", 403, null));
    await render();
    await act(async () => toggle("agent-request-rights-deploy").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
      body: "Only the company's owner or an admin can change what an agent may ask for.",
      tone: "error",
    }));
  });
});
