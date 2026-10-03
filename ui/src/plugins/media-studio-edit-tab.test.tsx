// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";

/**
 * DUR-4063: the Edit tab (crop/rotate/resize/adjust/text/AI edits on an
 * existing picture). Canvas compositing needs a real 2D context, which jsdom
 * does not provide, so this covers the wiring around it (tab switch, the
 * Media Studio / Files picker, and which AI-edit buttons show up for which
 * configured services) rather than the canvas pipeline itself.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";

const actions: Record<string, ReturnType<typeof vi.fn>> = {};
const navigate = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    sdkUi: {
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

describe("Media Studio Edit tab (DUR-4063)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const key of Object.keys(actions)) delete actions[key];
    navigate.mockReset();
    actions["edit.capabilities"] = vi.fn(async () => ({ sogni: true, fal: false }));
    installBridge();
    fetchMock = vi.fn(async (path: string) => {
      if (typeof path === "string" && path.includes("/artifacts")) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(null, "", "/media-studio?tab=edit");
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("deep-links to the Edit tab and lists company pictures to open", async () => {
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();

    expect(container.textContent).toContain("Open a picture");
    const call = fetchMock.mock.calls.find(([path]) => typeof path === "string" && path.includes("/artifacts"));
    expect(call?.[0]).toBe(`/api/companies/${COMPANY}/artifacts?kind=image&limit=30`);
    expect(container.textContent).toContain("No pictures yet.");
  });

  it("only shows AI-edit buttons for services with a configured key", async () => {
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();

    // Upload a picture directly so the editor (and its AI-edit section) renders,
    // bypassing the canvas pipeline (jsdom has no 2D context) by stubbing Image.
    const OriginalImage = globalThis.Image;
    class StubImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 100;
      naturalHeight = 100;
      crossOrigin: string | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Image = StubImage;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = () => ({
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      strokeRect: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      putImageData: vi.fn(),
      fillText: vi.fn(),
      set filter(_v: string) {},
      set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {},
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textBaseline(_v: string) {},
    });

    try {
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(["x"], "photo.png", { type: "image/png" });
      Object.defineProperty(fileInput, "files", { value: [file] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();

      expect(container.textContent).toContain("Remove background");
      expect(container.textContent).toContain("Upscale");
      expect(container.textContent).not.toContain("Make variations");

      // Select-an-area tools show; replace/remove need a Fal key, which this
      // setup doesn't have, so only the explanation is offered.
      expect(container.textContent).toContain("Change one part of the picture");
      expect(container.textContent).toContain("Clear selection");
      expect(container.textContent).toContain("Find it");
      expect(container.textContent).not.toContain("Replace selected area");
      expect(container.textContent).toContain("Ask an admin to add a Fal.ai key");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Image = OriginalImage;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});
