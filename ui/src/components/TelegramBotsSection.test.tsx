// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotSummary } from "@paperclipai/shared";
import { TelegramBotsSection } from "./TelegramBotsSection";

/**
 * DUR-3978 slice 2. Three things this screen must not get wrong:
 * the token field is never pre-filled, the operator only ever sees the masked
 * hint, and "Remove" asks before it removes a bot.
 */

const mockTelegramBotsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  rotateToken: vi.fn(),
  test: vi.fn(),
  setAllowedUsers: vi.fn(),
  remove: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/telegramBots", () => ({ telegramBotsApi: mockTelegramBotsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const BOT = "33333333-3333-4333-8333-333333333333";

const bot: TelegramBotSummary = {
  id: BOT,
  companyId: COMPANY,
  agentId: AGENT,
  agentName: "Daglig leder",
  name: "Daglig leder",
  tokenHint: "8100000001:••••ng01",
  uiBase: null,
  allowedTelegramUserIds: ["111111"],
  enabled: true,
  lastCheckAt: "2026-09-16T10:00:00.000Z",
  lastCheckOk: true,
  lastCheckUsername: "durkan_ceo_bot",
  lastCheckError: null,
  createdAt: "2026-09-16T09:00:00.000Z",
};

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

describe("TelegramBotsSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockTelegramBotsApi.list.mockResolvedValue([bot]);
    mockAgentsApi.list.mockResolvedValue([
      { id: AGENT, name: "Daglig leder" },
      { id: "44444444-4444-4444-8444-444444444444", name: "Fork Lead" },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: { readOnly?: boolean } = {}) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TelegramBotsSection companyId={COMPANY} {...props} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function button(label: string) {
    return Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === label,
    );
  }

  it("shows the masked hint and never a token, and leaves the token field empty", async () => {
    const root = await render();

    expect(container.textContent).toContain("Telegram bots");
    expect(container.textContent).toContain("8100000001:••••ng01");
    expect(container.textContent).toContain("Answers as @durkan_ceo_bot");
    expect(container.textContent).not.toContain("AAH");

    const tokenField = container.querySelector<HTMLInputElement>("#telegram-bot-token");
    expect(tokenField).not.toBeNull();
    expect(tokenField!.value).toBe("");
    // A password field, so a shoulder or a screenshot does not carry it away.
    expect(tokenField!.type).toBe("password");

    await act(async () => {
      root.unmount();
    });
  });

  it("asks before it removes a bot, and removes it only after the operator says yes", async () => {
    mockTelegramBotsApi.remove.mockResolvedValue({ ok: true });
    const root = await render();

    await act(async () => {
      button("Remove")?.click();
    });
    await flushReact();

    expect(mockTelegramBotsApi.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The bot stops answering");

    await act(async () => {
      button("Yes, remove the bot")?.click();
    });
    await flushReact();

    expect(mockTelegramBotsApi.remove).toHaveBeenCalledWith(COMPANY, BOT);

    await act(async () => {
      root.unmount();
    });
  });

  it("can be stepped back from: Cancel removes nothing", async () => {
    const root = await render();

    await act(async () => {
      button("Remove")?.click();
    });
    await flushReact();
    await act(async () => {
      button("Cancel")?.click();
    });
    await flushReact();

    expect(mockTelegramBotsApi.remove).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("The bot stops answering");

    await act(async () => {
      root.unmount();
    });
  });

  it("only offers agents that do not already have a bot", async () => {
    const root = await render();

    const options = Array.from(
      container.querySelectorAll<HTMLOptionElement>("#telegram-bot-agent option"),
    ).map((option) => option.textContent);

    expect(options).toEqual(["Choose an agent…", "Fork Lead"]);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows who may use the bot and can take someone off the list", async () => {
    mockTelegramBotsApi.setAllowedUsers.mockResolvedValue({ ...bot, allowedTelegramUserIds: [] });
    const root = await render();

    expect(container.textContent).toContain("Who may use this bot");
    expect(container.textContent).toContain("111111");

    const removeUser = container.querySelector<HTMLButtonElement>('button[aria-label="Remove 111111"]');
    await act(async () => {
      removeUser?.click();
    });
    await flushReact();

    expect(mockTelegramBotsApi.setAllowedUsers).toHaveBeenCalledWith(COMPANY, BOT, []);

    await act(async () => {
      root.unmount();
    });
  });

  it("read-only (operator/viewer): shows the bots and their status, but no way to change anything", async () => {
    const root = await render({ readOnly: true });
    const text = container.textContent ?? "";

    expect(text).toContain("Telegram bots");
    expect(text).toContain("8100000001:••••ng01");
    expect(text).toContain("Answers as @durkan_ceo_bot");
    expect(text).toContain("111111");
    expect(text).toContain("Only the company owner or an admin can connect or change bots.");
    expect(container.querySelector("#telegram-bot-token")).toBeNull();
    expect(container.querySelector("#telegram-bot-agent")).toBeNull();
    for (const label of ["Remove", "Replace token", "Test", "Connect", "Add"]) {
      expect(button(label), label).toBeUndefined();
    }
    expect(container.querySelector('button[aria-label="Remove 111111"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("says the list could not be loaded instead of pretending there are no bots", async () => {
    mockTelegramBotsApi.list.mockRejectedValue(new Error("Database unavailable"));
    const root = await render();

    expect(container.querySelector('[data-testid="telegram-bots-error"]')?.textContent).toContain(
      "Could not load the bots: Database unavailable",
    );
    expect(container.textContent).not.toContain("No bots connected yet.");

    await act(async () => {
      root.unmount();
    });
  });
});
