// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";

/**
 * DUR-4440: every paid button in the Edit tab shows its price, asks before
 * spending (unless the price is under the person's "don't ask" amount), keeps
 * a running total for the session, and explains spending-limit refusals in
 * plain words.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PREF_KEY = "media-studio:edit-skip-confirm-cents:local";

const actions: Record<string, ReturnType<typeof vi.fn>> = {};
let fetchMock: ReturnType<typeof vi.fn>;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`No button containing "${text}"`);
  return found as HTMLButtonElement;
}

describe("Media Studio Edit tab pricing (DUR-4440)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let OriginalImage: typeof Image;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(async () => {
    for (const key of Object.keys(actions)) delete actions[key];
    window.localStorage.clear();
    actions["edit.capabilities"] = vi.fn(async () => ({ sogni: true, fal: true }));
    actions["edit.sogni"] = vi.fn(async () => ({ imageDataUrl: "data:image/png;base64,AAAA" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn(async () => ({}))),
        useHostNavigation: () => ({ navigate: vi.fn(), linkProps: (to: string) => ({ href: to }) }),
      },
    };
    fetchMock = vi.fn(async (path: string) => {
      if (typeof path === "string" && path.includes("/direct/estimate")) {
        return new Response(JSON.stringify({ kind: "picture", provider: "fal", estimatedCostCents: 8 }), { status: 200 });
      }
      if (typeof path === "string" && path.includes("/artifacts")) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(null, "", "/media-studio?tab=edit");

    OriginalImage = globalThis.Image;
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
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = () => ctx;
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,BBBB";
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Image = OriginalImage;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  async function openEditor() {
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    await flush();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [new File(["x"], "photo.png", { type: "image/png" })] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }

  const estimateCalls = () => fetchMock.mock.calls.filter(([p]) => String(p).includes("/direct/estimate")).length;

  it("shows the price on every paid button", async () => {
    await openEditor();
    for (const label of [
      "Find it",
      "Replace selected area",
      "Remove selected object",
      "Remove background",
      "Upscale",
      "Restore / clean up (whole picture)",
      "Make variations",
      "Edit with a prompt",
    ]) {
      expect(button(container, label).textContent).toContain("≈ $0.08");
    }
  });

  it("asks first when the price is not under the don't-ask amount, and cancelling calls nothing", async () => {
    window.localStorage.setItem(PREF_KEY, "5");
    await openEditor();
    const callsBefore = fetchMock.mock.calls.length;

    await act(async () => button(container, "Upscale").click());
    expect(container.textContent).toContain("This edit costs money");
    expect(container.textContent).toContain("about $0.08");
    expect(actions["edit.sogni"]).not.toHaveBeenCalled();

    await act(async () => button(container, "Cancel").click());
    await flush();
    expect(container.textContent).not.toContain("This edit costs money");
    expect(actions["edit.sogni"]).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(estimateCalls()).toBe(1);
  });

  it("runs the edit after confirming and adds it to the session total", async () => {
    window.localStorage.setItem(PREF_KEY, "5");
    await openEditor();
    expect(container.textContent).toContain("This session: $0.00");
    await act(async () => button(container, "Upscale").click());
    await act(async () => button(container, "Yes, do it").click());
    await flush();
    expect(actions["edit.sogni"]).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("This session: $0.08");
  });

  it("skips the question for edits under the remembered amount (default $0.10)", async () => {
    await openEditor();
    await act(async () => button(container, "Upscale").click());
    await flush();
    expect(container.textContent).not.toContain("This edit costs money");
    expect(actions["edit.sogni"]).toHaveBeenCalledTimes(1);
  });

  it("lets an admin change the amount and remembers it", async () => {
    window.localStorage.setItem(PREF_KEY, "5");
    await openEditor();
    const input = container.querySelector('input[aria-label^="Don\'t ask again"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "0.2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(window.localStorage.getItem(PREF_KEY)).toBe("20");
    await act(async () => button(container, "Upscale").click());
    await flush();
    expect(container.textContent).not.toContain("This edit costs money");
    expect(actions["edit.sogni"]).toHaveBeenCalledTimes(1);
  });

  it("explains a spending-limit refusal in plain words", async () => {
    actions["edit.sogni"] = vi.fn(async () => {
      throw Object.assign(new Error("Request failed: direct_create_cap spentCents=900 capCents=1000"), { details: { reason: "direct_create_cap" } });
    });
    await openEditor();
    await act(async () => button(container, "Upscale").click());
    await flush();
    expect(container.textContent).toContain("monthly spending limit");
    expect(container.textContent).not.toContain("direct_create_cap");
  });
});
