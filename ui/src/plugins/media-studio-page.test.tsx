// @vitest-environment jsdom

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage, SidebarLink } from "../../../packages/plugins/media-studio/src/ui/index";

/**
 * DUR-4060: Media Studio moved from Settings -> Plugins onto the main menu,
 * and its "Looks" settings page became a tab on Media Studio's own page. This
 * covers the new main-menu link and the tab switch, stubbed through the
 * plugin UI bridge like the other media-studio-*.test.tsx files.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";

const actions: Record<string, ReturnType<typeof vi.fn>> = {};
const navigate = vi.fn();

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    react: { createElement },
    sdkUi: {
      PluginConfigForm: ({ pluginId }: { pluginId: string }) => <div data-testid="config-form">{pluginId}</div>,
      usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn(async () => ({}))),
      useHostNavigation: () => ({
        navigate,
        linkProps: (to: string) => ({ href: to }),
      }),
    },
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("Media Studio main-menu link and page (DUR-4060)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const key of Object.keys(actions)) delete actions[key];
    navigate.mockReset();
    actions["looks.list"] = vi.fn(async () => ({ looks: [], canManage: true, maxReferenceFiles: 4 }));
    actions["looks.defaults.list"] = vi.fn(async () => ({ agents: [], defaults: {} }));
    installBridge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (typeof path === "string" && path.includes("/media-studio/direct/history")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (typeof path === "string" && path.includes("/media-studio/direct/estimate")) {
          return new Response(JSON.stringify({ kind: "picture", provider: "fal", estimatedCostCents: 8 }), { status: 200 });
        }
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(null, "", "/media-studio");
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("SidebarLink points at the top-level Media Studio route", async () => {
    root = createRoot(container);
    root.render(<SidebarLink context={{ companyId: COMPANY } as never} />);
    await flush();
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/media-studio");
    expect(link.textContent).toContain("Media Studio");
  });

  it("opens on the Create tab and switches to Looks, updating the URL", async () => {
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();

    expect(container.textContent).toContain("Make picture");
    expect(actions["looks.list"]).toHaveBeenCalledTimes(1);

    const looksTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent === "Looks")!;
    (looksTab as HTMLButtonElement).click();
    await flush();

    expect(actions["looks.list"]).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith("/media-studio?tab=looks", { replace: true });
  });

  it("deep-links straight to the Looks tab from ?tab=looks", async () => {
    window.history.replaceState(null, "", "/media-studio?tab=looks");
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();

    expect(actions["looks.list"]).toHaveBeenCalledTimes(1);
  });

  const tabLabels = () =>
    [...container.querySelectorAll('[role="tablist"][aria-label="Media Studio"] [role="tab"]')].map((el) => el.textContent);

  it("shows the Settings tab to an owner/admin, after the four creative tabs", async () => {
    actions["settings.access"] = vi.fn(async () => ({ canManage: true }));
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();
    expect(tabLabels()).toEqual(["Create", "Edit", "Looks", "Storylines", "Settings"]);
  });

  it("hides the Settings tab from everyone else", async () => {
    actions["settings.access"] = vi.fn(async () => ({ canManage: false }));
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();
    expect(tabLabels()).toEqual(["Create", "Edit", "Looks", "Storylines"]);
  });

  it("falls back to Create when a non-admin opens ?tab=settings", async () => {
    actions["settings.access"] = vi.fn(async () => ({ canManage: false }));
    window.history.replaceState(null, "", "/media-studio?tab=settings");
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();
    expect(container.querySelector('[data-testid="config-form"]')).toBeNull();
    expect(container.textContent).toContain("Make picture");
  });

  it("deep-links to the settings form for an admin from ?tab=settings", async () => {
    actions["settings.access"] = vi.fn(async () => ({ canManage: true }));
    window.history.replaceState(null, "", "/media-studio?tab=settings");
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();
    expect(container.querySelector('[data-testid="config-form"]')?.textContent).toBe("paperclip.media-studio");
  });

  it("deep-links to the Edit tab from ?tab=edit", async () => {
    window.history.replaceState(null, "", "/media-studio?tab=edit");
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();
    const selected = [...container.querySelectorAll('[role="tab"][aria-selected="true"]')].map((el) => el.textContent);
    expect(selected).toEqual(["Edit"]);
  });
});
