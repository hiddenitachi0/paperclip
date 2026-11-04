// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  ask: vi.fn(async () => ({ issueId: "t1", identifier: "DUR-1" })),
  addComment: vi.fn(async () => ({})),
  task: null as unknown,
  comments: [] as unknown[],
  approval: null as unknown,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("../api/trading", () => ({ tradingApi: { askTrader: mocks.ask } }));
vi.mock("../api/issues", () => ({
  issuesApi: { get: async () => mocks.task, listComments: async () => mocks.comments, addComment: mocks.addComment },
}));
vi.mock("../api/approvals", () => ({ approvalsApi: { get: async () => mocks.approval } }));

import { ThemeProvider } from "../context/ThemeContext";
import { TradingStrategyChat, CHAT_READ_ONLY } from "./TradingStrategyChat";

const draft = {
  id: "v2", strategyId: "s1", version: 2, spec: null, guidelines: "", status: "draft", proposedByType: "agent", proposedById: "a1",
  approvedAt: null, supersededAt: null, approvalId: "ap1", createdAt: "2026-11-04T10:00:00Z",
};

async function render(props: Partial<React.ComponentProps<typeof TradingStrategyChat>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <TradingStrategyChat companyId="c1" strategyId="s1" canManage versions={[]} {...props} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return { container, root };
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  mocks.ask.mockClear();
  mocks.addComment.mockClear();
  mocks.task = { id: "t1", title: "Trading question: hi", description: "Why did it buy?", status: "todo", createdAt: "2026-11-04T09:00:00Z" };
  mocks.comments = [];
  mocks.approval = { payload: { proposerNote: { summary: "Tighter stop", reasons: "Three losses in a row" } } };
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("TradingStrategyChat", () => {
  it("opens a conversation with the first message and remembers it", async () => {
    const { container, root } = await render();
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    await act(async () => typeInto(input, "Why did it buy yesterday?"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mocks.ask).toHaveBeenCalledWith("c1", { question: "Why did it buy yesterday?", strategyId: "s1" });
    expect(localStorage.getItem("paperclip.trading-chat.c1.s1")).toBe("t1");
    expect(container.querySelector('[data-testid="chat-messages"]')?.textContent).toContain("Why did it buy?");
    expect(container.querySelector('[data-testid="chat-waiting"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("sends a follow-up as a reply in the same conversation and shows the Trader's answer", async () => {
    localStorage.setItem("paperclip.trading-chat.c1.s1", "t1");
    mocks.comments = [{ id: "c1", body: "Because the price crossed its average.", authorType: "agent", createdAt: "2026-11-04T09:30:00Z", deletedAt: null }];
    const { container, root } = await render();
    expect(container.querySelector('[data-from="trader"]')?.textContent).toContain("Because the price crossed its average.");
    expect(container.querySelector('[data-testid="chat-waiting"]')).toBeNull();
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
    await act(async () => typeInto(input, "Make it stay out when wild"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.click());
    expect(mocks.addComment).toHaveBeenCalledWith("t1", "Make it stay out when wild", undefined);
    expect(mocks.ask).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("shows the server's reason in plain words when the Trader cannot be asked", async () => {
    const { ApiError } = await import("../api/client");
    mocks.ask.mockRejectedValueOnce(new ApiError("No Trader agent has been chosen for this company yet.", 422, null));
    const { container, root } = await render();
    await act(async () => typeInto(container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!, "Hello Trader"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container.querySelector('[data-testid="chat-error"]')?.textContent).toContain("No Trader agent has been chosen");
    await act(async () => root.unmount());
  });

  it("lists the Trader's waiting drafts with the reason and a link to the card", async () => {
    const { container, root } = await render({ versions: [draft as never] });
    const card = container.querySelector('[data-testid="chat-draft"]')!;
    expect(card.textContent).toContain("Waiting for your approval");
    expect(card.querySelector('[data-testid="chat-draft-why"]')?.textContent).toContain("Three losses in a row");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/approvals/ap1");
    await act(async () => root.unmount());
  });

  it("is read-only for people who cannot manage trading", async () => {
    const { container, root } = await render({ canManage: false });
    expect(container.querySelector('[data-testid="chat-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-read-only"]')?.textContent).toBe(CHAT_READ_ONLY);
    await act(async () => root.unmount());
  });
});
