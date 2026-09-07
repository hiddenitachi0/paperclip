// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceClaudeAuthStatus, InstanceClaudeSignInSession } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceClaudeAuth } from "./InstanceClaudeAuth";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  saveToken: vi.fn(),
  check: vi.fn(),
  remove: vi.fn(),
  startSignIn: vi.fn(),
  getSignIn: vi.fn(),
  submitSignInCode: vi.fn(),
  cancelSignIn: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceClaudeAuth", () => ({ instanceClaudeAuthApi: mockApi }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));

const TOKEN = `sk-ant-oat01-${"Page1234".repeat(10)}-AA`;

function status(overrides: Partial<InstanceClaudeAuthStatus> = {}): InstanceClaudeAuthStatus {
  return {
    configured: false,
    health: "not_configured",
    headline: "Not signed in.",
    fingerprint: null,
    source: null,
    savedAt: null,
    savedByUserId: null,
    expiresAt: null,
    expiresInDays: null,
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckMessage: null,
    lastUsedAt: null,
    lastAuthFailureAt: null,
    cli: { command: "claude", version: "2.1.263 (Claude Code)" },
    automaticSignIn: { supported: true, reason: null },
    activeSignIn: null,
    ...overrides,
  };
}

function session(overrides: Partial<InstanceClaudeSignInSession> = {}): InstanceClaudeSignInSession {
  return {
    id: "sess-1",
    status: "starting",
    loginUrl: null,
    message: "Starting…",
    startedAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
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

function click(element: Element | null) {
  expect(element).not.toBeNull();
  flushSync(() => {
    (element as HTMLElement).click();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  flushSync(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ?? null;
}

describe("InstanceClaudeAuth page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceClaudeAuth />
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

  it("walks the operator through sign in: button → link → code, never showing a token", async () => {
    mockApi.get.mockResolvedValue(status());
    mockApi.startSignIn.mockResolvedValue(session());
    mockApi.getSignIn.mockResolvedValue(
      session({ status: "awaiting_code", loginUrl: "https://claude.com/cai/oauth/authorize?x=1", message: "Open the link." }),
    );
    mockApi.submitSignInCode.mockResolvedValue(session({ status: "exchanging", message: "Checking…" }));
    await renderPage();

    expect(container.textContent).toContain("Not signed in");
    click(findButton(container, "Sign in with Claude"));
    await flushReact();
    expect(mockApi.startSignIn).toHaveBeenCalledTimes(1);
    await flushReact();

    const link = container.querySelector('a[href="https://claude.com/cai/oauth/authorize?x=1"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");

    const codeInput = container.querySelector<HTMLInputElement>('input[aria-label="Code from Claude"]');
    expect(codeInput).not.toBeNull();
    setInputValue(codeInput!, "  abc#def  ");
    click(findButton(container, "Finish sign-in"));
    await flushReact();
    expect(mockApi.submitSignInCode).toHaveBeenCalledWith("sess-1", "abc#def");
    expect(container.textContent).not.toContain(TOKEN);
  });

  it("shows an expired sign-in plainly and offers to sign in again", async () => {
    mockApi.get.mockResolvedValue(
      status({
        configured: true,
        health: "expired",
        headline: "This sign-in has expired. Sign in again so Claude agents keep working.",
        fingerprint: "abcdef012345",
        source: "signin",
        savedAt: "2025-09-01T10:00:00.000Z",
        expiresAt: "2026-09-01T10:00:00.000Z",
        expiresInDays: -6,
        lastCheckAt: "2026-09-01T10:00:00.000Z",
        lastCheckOk: true,
        lastCheckMessage: "Claude answered. This token works.",
      }),
    );
    await renderPage();
    expect(container.textContent).toContain("Expired");
    expect(container.textContent).toContain("Sign in again so Claude agents keep working");
    expect(findButton(container, "Sign in again")).not.toBeNull();
    expect(findButton(container, "Check now")).not.toBeNull();
    expect(container.textContent).toContain("2.1.263 (Claude Code)");
  });

  it("explains when automatic sign-in is unavailable and validates a pasted token before saving", async () => {
    mockApi.get.mockResolvedValue(
      status({ automaticSignIn: { supported: false, reason: "No 'script' tool here. Use the paste option below instead." } }),
    );
    mockApi.saveToken.mockResolvedValue(status({ configured: true, health: "ok", headline: "Signed in." }));
    await renderPage();

    expect(container.textContent).toContain("No 'script' tool here");
    expect(findButton(container, "Sign in with Claude")).toBeNull();

    click(findButton(container, "Paste it instead"));
    await flushReact();
    const tokenInput = container.querySelector<HTMLInputElement>("#claude-token");
    expect(tokenInput).not.toBeNull();

    setInputValue(tokenInput!, "sk-ant-api03-wrong");
    expect(container.textContent).toContain("does not look right yet");
    expect(findButton(container, "Test and save")?.hasAttribute("disabled")).toBe(true);

    setInputValue(tokenInput!, `  ${TOKEN}  `);
    click(findButton(container, "Test and save"));
    await flushReact();
    expect(mockApi.saveToken).toHaveBeenCalledWith(TOKEN);
    expect(container.textContent).not.toContain(TOKEN);
  });
});
