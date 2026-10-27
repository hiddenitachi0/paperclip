// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderShotModels, modelText } from "../../../packages/plugins/media-studio/src/ui/render-shot-models";
import type { SogniVideoModelRow } from "../../../packages/plugins/media-studio/src/ui/video-model-picker";

/** Step 5: each shot says which video model it will use, one shot can be kept on another model, and one button puts them all back on the film's model. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/companies/c-1/video-storylines/sl-1";
const SOGNI_ROWS: SogniVideoModelRow[] = [
  { id: "ltx23-22b-fp8_i2v_distilled", name: "LTX-2.3 I2V", tags: [], premium: false, workersOnline: 58, clipSeconds: { min: 2, max: 21 }, takesStartImage: true, needsStartImage: true, maxReferences: 0, usdPerBaseRender: 0.194, creator: null },
];

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}
function button(within: Element, label: string): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

let clips: Array<Record<string, unknown>>;
let calls: Array<{ path: string; method: string; body?: string }>;

function clip(n: number, extra: Record<string, unknown> = {}) {
  return { shotId: `sh-${n}`, orderIndex: n - 1, prompt: "p", cameraNotes: null, durationSeconds: 5, status: "draft", hasClip: false, hasPoster: false, clipKind: "generated", providerId: "sogni", model: null, pinned: false, willUse: { providerId: "sogni", model: null }, ...extra };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body as string | undefined });
      if (path === `${BASE}/strip`) return new Response(JSON.stringify({ storylineId: "sl-1", providerId: "sogni", status: "draft", clips, gaps: [], models: [], budget: { capCents: null, spentCents: 0 } }));
      if (path === `${BASE}/shots/use-film-model`) {
        clips = clips.map((c) => ({ ...c, pinned: false, willUse: { providerId: "sogni", model: null } }));
        return new Response(JSON.stringify({ cleared: 1 }));
      }
      if (path.startsWith(`${BASE}/shots/`) && method === "PATCH") {
        const body = JSON.parse(init!.body as string) as { providerId: "fal" | "sogni" | null; model?: string | null };
        const id = path.split("/").pop();
        clips = clips.map((c) =>
          c.shotId !== id ? c : body.providerId ? { ...c, pinned: true, willUse: { providerId: body.providerId, model: body.model ?? null } } : { ...c, pinned: false, willUse: { providerId: "sogni", model: null } },
        );
        return new Response("{}");
      }
      return new Response("{}");
    }),
  );
}

describe("modelText", () => {
  it("names models in plain words", () => {
    expect(modelText({ providerId: "sogni", model: null }, null)).toBe("Sogni, its default model");
    expect(modelText({ providerId: "fal", model: null }, null)).toBe("Fal.ai, automatic (Kling)");
    expect(modelText({ providerId: "sogni", model: "ltx23-22b-fp8_i2v_distilled" }, SOGNI_ROWS)).toBe("Sogni, LTX-2.3 I2V");
    expect(modelText({ providerId: "fal", model: "fal-ai/kling-video/v3/pro/image-to-video" }, null)).toBe("Fal.ai, Kling 3 Pro, from a start picture");
  });
});

describe("RenderShotModels", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChanged = vi.fn();
  async function mount(editable = true) {
    await act(async () => {
      root.render(<RenderShotModels apiBase={BASE} editable={editable} filmProviderId="sogni" filmModel={null} sogniModels={SOGNI_ROWS} onChanged={onChanged} />);
    });
    await flush();
  }
  beforeEach(() => {
    calls = [];
    onChanged.mockClear();
    clips = [clip(1), clip(2), { shotId: "sh-3", orderIndex: 2, prompt: "p", durationSeconds: 5, status: "done", hasClip: true, hasPoster: true, clipKind: "uploaded_video", willUse: null }];
    installFetch();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows what each AI shot will use and skips your own videos", async () => {
    await mount();
    expect(host.querySelector('[data-testid="will-use-sh-1"]')?.textContent).toBe("Sogni, its default model");
    expect(host.querySelector('[data-testid="shot-model-sh-2"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="shot-model-sh-3"]')).toBeNull();
    expect(host.textContent).not.toContain("Kept on this model");
    expect((host.querySelector('[data-testid="use-film-model"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps one shot on a model, then follows the film again", async () => {
    await mount();
    await click(button(host.querySelector('[data-testid="shot-model-sh-2"]')!, "Keep this shot on a model"));
    const editor = host.querySelector('[data-testid="pin-editor-sh-2"]')!;
    await choose(editor.querySelector("select") as HTMLSelectElement, "fal");
    await click(button(editor, "Keep this shot on this model"));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe(`${BASE}/shots/sh-2`);
    expect(JSON.parse(patch.body!)).toEqual({ providerId: "fal", model: null });
    expect(host.querySelector('[data-testid="will-use-sh-2"]')?.textContent).toBe("Fal.ai, automatic (Kling)");
    expect(host.querySelector('[data-testid="pinned-sh-2"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pinned-sh-1"]')).toBeNull();
    expect(onChanged).toHaveBeenCalled();

    await click(button(host.querySelector('[data-testid="shot-model-sh-2"]')!, "Follow the film's model"));
    expect(JSON.parse(calls.filter((c) => c.method === "PATCH").at(-1)!.body!)).toEqual({ providerId: null });
    expect(host.querySelector('[data-testid="pinned-sh-2"]')).toBeNull();
  });

  it("'Use the film's model for all shots' clears every pin", async () => {
    clips = [clip(1, { pinned: true, willUse: { providerId: "fal", model: null } }), clip(2)];
    await mount();
    expect(host.querySelector('[data-testid="pinned-sh-1"]')).not.toBeNull();
    await click(host.querySelector('[data-testid="use-film-model"]') as HTMLButtonElement);
    expect(calls.some((c) => c.path === `${BASE}/shots/use-film-model` && c.method === "POST")).toBe(true);
    expect(host.querySelector('[data-testid="pinned-sh-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="shot-models-notice"]')?.textContent).toContain("Every shot follows the film's model again");
  });

  it("is switched off while the film cannot be edited", async () => {
    clips = [clip(1, { pinned: true, willUse: { providerId: "fal", model: null } })];
    await mount(false);
    const row = host.querySelector('[data-testid="shot-model-sh-1"]')!;
    expect(button(row, "Change model").disabled).toBe(true);
    expect(button(row, "Follow the film's model").disabled).toBe(true);
    expect((host.querySelector('[data-testid="use-film-model"]') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("Models cannot be changed while the film is being made");
  });

  it("explains a made clip that was made with a different model", async () => {
    clips = [clip(1, { status: "done", hasClip: true, providerId: "fal", model: null, willUse: { providerId: "sogni", model: null } })];
    await mount();
    expect(host.textContent).toContain("This clip was made with Fal.ai, automatic (Kling). Making it again would use the model above.");
  });

  it("shows a plain error when a change is refused", async () => {
    await mount();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Response("{}")); // reload is fine
    vi.stubGlobal("fetch", vi.fn(async (path: string) => (path.endsWith("/strip") ? new Response(JSON.stringify({ clips, gaps: [], budget: {} })) : new Response(JSON.stringify({ error: "This film is being made right now." }), { status: 409 }))));
    await click(button(host.querySelector('[data-testid="shot-model-sh-1"]')!, "Keep this shot on a model"));
    await click(button(host.querySelector('[data-testid="pin-editor-sh-1"]')!, "Keep this shot on this model"));
    expect(host.querySelector('[data-testid="shot-models-error"]')?.textContent).toContain("This film is being made right now.");
  });
});
