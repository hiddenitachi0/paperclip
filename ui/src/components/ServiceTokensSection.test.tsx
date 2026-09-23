// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceTokensSection } from "./ServiceTokensSection";

/**
 * DUR-3997 slice 4: the "Keys for other systems" card on Connections. What it
 * must not get wrong: a viewer sees the keys and their reach but cannot mint
 * or revoke one; a failed list never reads as "no keys created yet".
 */

const mockServiceTokensApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/serviceTokens", () => ({
  serviceTokensApi: mockServiceTokensApi,
  LANE_A_TRANSFORM_SCOPES: ["lane_a:transform"],
}));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "22222222-2222-4222-8222-222222222222";

const token = {
  id: TOKEN_ID,
  companyId: COMPANY,
  name: "The dashboard",
  scopes: ["lane_a:transform"],
  lastUsedAt: "2026-09-22T10:00:00.000Z",
  createdAt: "2026-09-16T09:00:00.000Z",
  revokedAt: null,
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

describe("ServiceTokensSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockServiceTokensApi.list.mockResolvedValue([token]);
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
          <ServiceTokensSection companyId={COMPANY} {...props} />
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

  it("lists the keys with what each may do, and lets an owner create and revoke", async () => {
    mockServiceTokensApi.revoke.mockResolvedValue({ ok: true });
    const root = await render();
    const text = container.textContent ?? "";

    expect(text).toContain("Keys for other systems");
    expect(text).toContain("The dashboard");
    expect(text).toContain("Can only: ask quick agents to rewrite text");
    expect(container.querySelector("#service-token-name")).not.toBeNull();
    expect(button("Create key")).toBeDefined();

    await act(async () => {
      button("Revoke")?.click();
    });
    await flushReact();
    expect(mockServiceTokensApi.revoke).toHaveBeenCalledWith(COMPANY, TOKEN_ID);

    await act(async () => {
      root.unmount();
    });
  });

  it("read-only (operator/viewer): shows the keys but no Create or Revoke", async () => {
    const root = await render({ readOnly: true });
    const text = container.textContent ?? "";

    expect(text).toContain("The dashboard");
    expect(text).toContain("Only the company owner or an admin can create or revoke keys.");
    expect(container.querySelector("#service-token-name")).toBeNull();
    expect(button("Create key")).toBeUndefined();
    expect(button("Revoke")).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("says the list could not be loaded instead of pretending there are no keys", async () => {
    mockServiceTokensApi.list.mockRejectedValue(new Error("Database unavailable"));
    const root = await render();

    expect(container.querySelector('[data-testid="service-tokens-error"]')?.textContent).toContain(
      "Could not load the keys: Database unavailable",
    );
    expect(container.textContent).not.toContain("No keys created yet.");

    await act(async () => {
      root.unmount();
    });
  });
});
