// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSettingsRoute } from "./PluginSettingsRoute";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const params = vi.hoisted(() => ({ pluginId: "" }));
const getPlugin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  useParams: () => params,
}));
vi.mock("@/api/plugins", () => ({ pluginsApi: { get: getPlugin } }));
vi.mock("./PluginSettings", () => ({ PluginSettings: () => <div>Generic plugin settings</div> }));

async function render(pluginId: string): Promise<HTMLElement> {
  params.pluginId = pluginId;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(container).render(
    <QueryClientProvider client={client}>
      <PluginSettingsRoute />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return container;
}

describe("PluginSettingsRoute", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    getPlugin.mockReset();
  });

  it("sends Media Studio's plugin key to its Settings tab", async () => {
    const c = await render("paperclip.media-studio");
    expect(c.textContent).toBe("Navigate:/media-studio?tab=settings");
  });

  it("sends Media Studio's internal id (as linked from the plugin list) to its Settings tab", async () => {
    getPlugin.mockResolvedValue({ id: "abc", pluginKey: "paperclip.media-studio" });
    const c = await render("11111111-2222-4333-8444-555555555555");
    expect(c.textContent).toBe("Navigate:/media-studio?tab=settings");
  });

  it("keeps the generic settings page for other plugins", async () => {
    getPlugin.mockResolvedValue({ id: "xyz", pluginKey: "someone.else" });
    const c = await render("11111111-2222-4333-8444-555555555555");
    expect(c.textContent).toBe("Generic plugin settings");
  });
});
