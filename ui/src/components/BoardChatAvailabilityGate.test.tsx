// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChatAvailabilityGate } from "./BoardChatAvailabilityGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  flag: true,
  mode: "local_trusted" as "local_trusted" | "authenticated",
  availability: null as null | { available: boolean; reason: string | null; canChangeSettings: boolean },
}));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableConferenceRoomChat: state.flag })) },
}));
vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn(async () => ({ status: "ok", deploymentMode: state.mode })) },
}));
vi.mock("@/api/boardChat", () => ({
  boardChatApi: {
    getAvailability: vi.fn(async () =>
      state.availability ? { mode: "signed_in", message: null, dailyMessageCap: 40, messagesToday: 0, ...state.availability } : null,
    ),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompanyId: "company-1" }),
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));

describe("BoardChatAvailabilityGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    state.flag = true;
    state.mode = "local_trusted";
    state.availability = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  async function renderGate() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/PAP/board-chat"]}>
            <BoardChatAvailabilityGate>
              <div data-testid="chat">the chat</div>
            </BoardChatAvailabilityGate>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("shows the chat on a single-user local Paperclip, as before", async () => {
    await renderGate();
    expect(container.querySelector("[data-testid=chat]")).not.toBeNull();
    expect(container.querySelector("[data-testid=board-chat-not-here]")).toBeNull();
  });

  it("shows the chat on a signed-in Paperclip for the company's owner or admin", async () => {
    state.mode = "authenticated";
    state.availability = { available: true, reason: null, canChangeSettings: false };
    await renderGate();
    expect(container.querySelector("[data-testid=chat]")).not.toBeNull();
  });

  it("explains, with a way to switch it on, when the owner's company has Board chat off", async () => {
    state.mode = "authenticated";
    state.availability = { available: false, reason: "company_off", canChangeSettings: true };
    await renderGate();
    expect(container.querySelector("[data-testid=chat]")).toBeNull();
    const note = container.querySelector("[data-testid=board-chat-not-here]");
    expect(note?.textContent).toContain("Board chat is turned off for this company.");
    expect(note?.textContent).toContain("each one waits for your Approve");
    expect(container.querySelector("[data-testid=board-chat-settings-link]")).not.toBeNull();
  });

  it("tells a member plainly that Board chat is for owners and admins", async () => {
    state.mode = "authenticated";
    state.availability = { available: false, reason: "not_allowed", canChangeSettings: false };
    await renderGate();
    expect(container.querySelector("[data-testid=chat]")).toBeNull();
    const note = container.querySelector("[data-testid=board-chat-not-here]");
    expect(note?.textContent).toContain("Board chat is only for this company's owner and admins.");
    expect(note?.textContent).toContain("use the Ask tab on the right edge");
    expect(container.querySelector("[data-testid=board-chat-settings-link]")).toBeNull();
  });

  it("says it is not available on a server that cannot answer", async () => {
    state.mode = "authenticated";
    state.availability = null;
    await renderGate();
    expect(container.querySelector("[data-testid=board-chat-not-here]")?.textContent).toContain(
      "Board chat is not available on this Paperclip.",
    );
  });

  it("renders nothing until it is known whether Board chat can run (no flash)", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BoardChatAvailabilityGate>
              <div data-testid="chat">the chat</div>
            </BoardChatAvailabilityGate>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toBe("");
  });
});
