// @vitest-environment jsdom
//
// DUR-3995: the settings card for Paperclip's own Claude key. What it must
// show (whether a key is set, the last four characters, when it changed, what
// Claude said) and what it must never show (the key).

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceServerAnthropicKeyStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerClaudeKeyCard } from "./ServerClaudeKeyCard";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceServerAnthropicKey", () => ({ instanceServerAnthropicKeyApi: mockApi }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));

const KEY = `sk-ant-api03-${"CardKey1".repeat(6)}AA`;

function status(overrides: Partial<InstanceServerAnthropicKeyStatus> = {}): InstanceServerAnthropicKeyStatus {
  return {
    configured: false,
    source: null,
    headline: "Paperclip has no Claude key of its own yet.",
    hint: null,
    fingerprint: null,
    savedAt: null,
    savedByUserId: null,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ?? null;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  flushSync(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ServerClaudeKeyCard", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ServerClaudeKeyCard />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    for (const fn of Object.values(mockApi)) fn.mockReset();
    mockPushToast.mockReset();
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount());
      root = null;
    }
    container.remove();
  });

  it("says plainly when no key is set, and offers only the paste field", async () => {
    mockApi.get.mockResolvedValue(status());
    await render();

    expect(container.textContent).toContain("Not set");
    expect(container.textContent).toContain("Paperclip has no Claude key of its own yet.");
    expect(findButton(container, "Remove key")).toBeNull();
    expect(findButton(container, "Test")).toBeNull();
    expect(container.querySelector("#server-claude-key")).not.toBeNull();
  });

  it("shows the last four characters, when it changed and what Claude said — never the key", async () => {
    mockApi.get.mockResolvedValue(
      status({
        configured: true,
        source: "stored",
        headline: "Paperclip has its own Claude key and Claude accepted it.",
        hint: "…y1AA",
        savedAt: "2026-09-22T10:00:00.000Z",
        lastTestAt: "2026-09-22T10:05:00.000Z",
        lastTestOk: true,
        lastTestMessage: "Claude answered. This key works.",
      }),
    );
    await render();

    expect(container.textContent).toContain("In place");
    expect(container.textContent).toContain("…y1AA");
    expect(container.textContent).toContain("Claude answered. This key works.");
    expect(container.textContent?.includes(KEY)).toBe(false);
    expect(findButton(container, "Test")).not.toBeNull();
    expect(findButton(container, "Remove key")).not.toBeNull();
  });

  it("only allows saving something shaped like a Claude key", async () => {
    mockApi.get.mockResolvedValue(status());
    await render();

    const input = container.querySelector("#server-claude-key") as HTMLInputElement;
    setInputValue(input, "hello");
    await flushReact();
    expect((findButton(container, "Save and test") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("it should start with sk-ant-");

    setInputValue(input, KEY);
    await flushReact();
    expect((findButton(container, "Save and test") as HTMLButtonElement).disabled).toBe(false);
  });

  it("tells the operator when Claude rejects a key it just saved", async () => {
    mockApi.get.mockResolvedValue(status());
    mockApi.save.mockResolvedValue({
      ok: false,
      message: "Claude did not accept this key (invalid x-api-key).",
      status: status({
        configured: true,
        source: "stored",
        headline: "A key is saved, but Claude did not accept it the last time it was tested.",
        hint: "…y1AA",
        savedAt: "2026-09-22T10:00:00.000Z",
        lastTestAt: "2026-09-22T10:00:00.000Z",
        lastTestOk: false,
        lastTestMessage: "Claude did not accept this key (invalid x-api-key).",
      }),
    });
    await render();

    setInputValue(container.querySelector("#server-claude-key") as HTMLInputElement, KEY);
    await flushReact();
    flushSync(() => (findButton(container, "Save and test") as HTMLButtonElement).click());
    await flushReact();

    expect(mockApi.save).toHaveBeenCalledWith(KEY);
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "warn", title: "Key saved, but Claude did not accept it" }),
    );
    expect(container.textContent).toContain("Needs attention");
    // The field is cleared: the key is never left sitting in the page.
    expect((container.querySelector("#server-claude-key") as HTMLInputElement).value).toBe("");
  });

  it("asks for confirmation before removing the key", async () => {
    mockApi.get.mockResolvedValue(
      status({ configured: true, source: "stored", headline: "A key is saved.", hint: "…y1AA", savedAt: "2026-09-22T10:00:00.000Z" }),
    );
    mockApi.remove.mockResolvedValue(status());
    await render();

    flushSync(() => (findButton(container, "Remove key") as HTMLButtonElement).click());
    await flushReact();
    expect(mockApi.remove).not.toHaveBeenCalled();

    flushSync(() => (findButton(container, "Yes, remove it") as HTMLButtonElement).click());
    await flushReact();
    expect(mockApi.remove).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Not set");
  });
});
