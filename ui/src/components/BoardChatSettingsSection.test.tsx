// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChatSettingsSection } from "./BoardChatSettingsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  mode: "authenticated" as "local_trusted" | "authenticated",
  role: { role: "owner" as string | null, isInstanceAdmin: false, localBoard: false },
  settings: { companyId: "c1", enabled: false, dailyMessageCap: 40, messagesToday: 3, enabledAt: null, enabledByUserId: null },
}));
const mockApi = vi.hoisted(() => ({
  getSettings: vi.fn(async () => state.settings),
  updateSettings: vi.fn(async (_companyId: string, patch: Record<string, unknown>) => ({ ...state.settings, ...patch })),
}));
vi.mock("../api/boardChat", () => ({ boardChatApi: mockApi }));
vi.mock("../api/health", () => ({ healthApi: { get: vi.fn(async () => ({ status: "ok", deploymentMode: state.mode })) } }));
vi.mock("../hooks/useCompanyRole", () => ({
  useCompanyRole: () => ({ ...state.role, canManageConnections: true, isLoading: false }),
}));
vi.mock("../hooks/useConferenceRoomChatEnabled", () => ({
  useConferenceRoomChatEnabled: () => ({ enabled: true, loaded: true }),
}));

describe("BoardChatSettingsSection", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    state.mode = "authenticated";
    state.role = { role: "owner", isInstanceAdmin: false, localBoard: false };
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root!.render(
        <QueryClientProvider client={client}>
          <BoardChatSettingsSection companyId="c1" />
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("is hidden on a local single-user Paperclip", async () => {
    state.mode = "local_trusted";
    await render();
    expect(container.querySelector("[data-testid=company-settings-board-chat-section]")).toBeNull();
  });

  it("explains the risk and lets the owner switch it on (off by default)", async () => {
    await render();
    expect(container.querySelector("[data-testid=board-chat-risk-text]")?.textContent).toContain(
      "nothing happens until that person clicks Approve",
    );
    const toggle = container.querySelector("[data-testid=company-settings-board-chat-toggle]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(false);
    await act(async () => {
      toggle.click();
    });
    expect(mockApi.updateSettings).toHaveBeenCalledWith("c1", { enabled: true });
    expect(container.textContent).toContain("3 used today");
  });

  it("does not let an admin switch it", async () => {
    state.role = { role: "admin", isInstanceAdmin: false, localBoard: false };
    await render();
    const toggle = container.querySelector("[data-testid=company-settings-board-chat-toggle]") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(container.textContent).toContain("Only the company's owner can turn Board chat on or off.");
  });
});
