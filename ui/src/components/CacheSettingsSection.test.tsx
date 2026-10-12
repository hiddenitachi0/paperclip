// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CacheSettingsSection } from "./CacheSettingsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../api/cacheSettings", () => ({ cacheSettingsApi: api }));

const base = {
  companyId: "c1",
  enabled: false,
  schedulingEnabled: true,
  handoffEnabled: true,
  handoffTokenThreshold: 150000,
  cacheLifetimeMinutes: null,
};

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("CacheSettingsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("toggles the main switch and saves limits", async () => {
    api.get.mockResolvedValue(base);
    api.update.mockImplementation(async (_id, patch) => ({ ...base, ...patch }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <CacheSettingsSection companyId="c1" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flush();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="company-settings-cache-enabled-toggle"]')!;
    await act(async () => toggle.click());
    expect(api.update).toHaveBeenCalledWith("c1", { enabled: true });

    const input = container.querySelector<HTMLInputElement>('[data-testid="company-settings-cache-threshold-input"]')!;
    expect(input.value).toBe("150");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "200");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="company-settings-cache-save"]')!.click(),
    );
    expect(api.update).toHaveBeenLastCalledWith("c1", { handoffTokenThreshold: 200000, cacheLifetimeMinutes: null });
    root.unmount();
  });
});
