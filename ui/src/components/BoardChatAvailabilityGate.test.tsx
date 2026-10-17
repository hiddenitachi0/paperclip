// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChatAvailabilityGate } from "./BoardChatAvailabilityGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ flag: true, mode: "local_trusted" as "local_trusted" | "authenticated" }));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableConferenceRoomChat: state.flag })) },
}));
vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn(async () => ({ status: "ok", deploymentMode: state.mode })) },
}));

describe("BoardChatAvailabilityGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    state.flag = true;
    state.mode = "local_trusted";
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
          <BoardChatAvailabilityGate>
            <div data-testid="chat">the chat</div>
          </BoardChatAvailabilityGate>
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("shows the chat where Board chat can run (single-operator local mode)", async () => {
    await renderGate();
    expect(container.querySelector("[data-testid=chat]")).not.toBeNull();
    expect(container.querySelector("[data-testid=board-chat-not-here]")).toBeNull();
  });

  it("explains instead of showing a chat that would fail on a shared, signed-in server", async () => {
    state.mode = "authenticated";
    await renderGate();
    expect(container.querySelector("[data-testid=chat]")).toBeNull();
    const note = container.querySelector("[data-testid=board-chat-not-here]");
    expect(note?.textContent).toContain(
      "Board chat only works when Paperclip runs on your own computer in single-user mode.",
    );
    expect(note?.textContent).toContain("use the Ask tab on the right edge");
  });

  it("renders nothing until it is known whether Board chat can run (no flash)", async () => {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root!.render(
        <QueryClientProvider client={queryClient}>
          <BoardChatAvailabilityGate>
            <div data-testid="chat">the chat</div>
          </BoardChatAvailabilityGate>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toBe("");
  });
});
