// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";
import {
  FAL_VIDEO_MODELS,
  VideoModelPicker,
  clipLengthsText,
  pictureSupportText,
  priceText,
  type SogniVideoModelRow,
} from "../../../packages/plugins/media-studio/src/ui/video-model-picker";

/**
 * Storylines: the video model as a list (Fal's Kling models, Sogni's live
 * catalogue, a custom id under Advanced) and step 2's picture settings
 * (picture service, model, look, and a shot's own look).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SOGNI_ROWS: SogniVideoModelRow[] = [
  { id: "seedance-2-0-fast", name: "Seedance 2.0 Fast", tags: ["premium"], premium: true, workersOnline: 9, clipSeconds: { values: [4, 5, 6, 7, 8] }, takesStartImage: true, needsStartImage: false, maxReferences: 9, usdPerBaseRender: 0.007, creator: null },
  { id: "ltx23-22b-fp8_i2v_distilled", name: "LTX-2.3 I2V", tags: [], premium: false, workersOnline: 58, clipSeconds: { min: 2, max: 21 }, takesStartImage: true, needsStartImage: true, maxReferences: 0, usdPerBaseRender: 0.194, creator: null },
];

async function flush() {
  for (let i = 0; i < 8; i += 1) {
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

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("video model details (pure)", () => {
  it("describes clip lengths, price and picture use in plain words", () => {
    expect(clipLengthsText({ values: [5, 10] })).toBe("5 or 10 seconds");
    expect(clipLengthsText({ values: [4, 5, 6, 7] })).toBe("4 to 7 seconds");
    expect(clipLengthsText({ min: 2, max: 21 })).toBe("2 to 21 seconds");
    expect(clipLengthsText(null)).toBe("not published");
    expect(priceText(FAL_VIDEO_MODELS[1]!)).toBe("about $0.05 per second");
    expect(priceText({ ...FAL_VIDEO_MODELS[0]!, centsPerSecond: null, usdPerBaseRender: 0.194 })).toContain("Sogni list price about $0.194");
    expect(pictureSupportText(FAL_VIDEO_MODELS[1]!)).toContain("Needs a start picture");
    expect(pictureSupportText(FAL_VIDEO_MODELS[2]!)).toContain("Text only");
    // Every Fal model the server can drive is a Kling model: 5- or 10-second clips.
    expect(FAL_VIDEO_MODELS.every((m) => m.clipSeconds && "values" in m.clipSeconds && m.clipSeconds.values.join() === "5,10")).toBe(true);
  });
});

describe("VideoModelPicker", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("Fal: a list with details, and a custom id under Advanced", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<VideoModelPicker provider="fal" value={null} sogniModels={null} onChange={onChange} />);
    });
    const select = host.querySelector('select[aria-label="Video model"]') as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(host.querySelector('[data-testid="video-model-details"]')?.textContent).toContain("Clip lengths: 5 or 10 seconds");
    await choose(select, "fal-ai/kling-video/v1.6/pro/text-to-video");
    expect(onChange).toHaveBeenLastCalledWith("fal-ai/kling-video/v1.6/pro/text-to-video");
    await type(host.querySelector('input[aria-label="Custom video model id"]') as HTMLInputElement, "fal-ai/some/other-model");
    await click(button(host, "Use this model id"));
    expect(onChange).toHaveBeenLastCalledWith("fal-ai/some/other-model");
  });

  it("shows a hand-typed id as Custom", async () => {
    await act(async () => {
      root.render(<VideoModelPicker provider="fal" value="fal-ai/some/other-model" sogniModels={null} onChange={() => {}} />);
    });
    expect(host.querySelector('[data-testid="video-model-details"]')?.textContent).toContain("Custom model: fal-ai/some/other-model");
  });

  it("Sogni: lists the catalogue with lengths, start/reference pictures and price", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<VideoModelPicker provider="sogni" value="ltx23-22b-fp8_i2v_distilled" sogniModels={SOGNI_ROWS} onChange={onChange} />);
    });
    const options = Array.from(host.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Sogni's default video model", "Seedance 2.0 Fast (premium)", "LTX-2.3 I2V"]);
    const details = host.querySelector('[data-testid="video-model-details"]')!.textContent!;
    expect(details).toContain("Clip lengths: 2 to 21 seconds");
    expect(details).toContain("Needs a start picture");
    expect(details).toContain("does not use character pictures");
    await choose(host.querySelector("select") as HTMLSelectElement, "seedance-2-0-fast");
    expect(onChange).toHaveBeenLastCalledWith("seedance-2-0-fast");
  });

  it("Sogni: waits for the catalogue before allowing a choice", async () => {
    await act(async () => {
      root.render(<VideoModelPicker provider="sogni" value={null} sogniModels={null} onChange={() => {}} />);
    });
    expect((host.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    expect(host.textContent).toContain("Loading Sogni's video models");
  });
});

// ─── On the page ───────────────────────────────────────────────────────────

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SL = "sl-1";
const BASE = `/api/companies/${COMPANY}/video-storylines`;

let storyline: Record<string, unknown>;
let calls: Array<{ path: string; method: string; body?: string }>;
let shotLook: string | null;
const actions: Record<string, ReturnType<typeof vi.fn>> = {};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body as string | undefined;
      calls.push({ path, method, body });
      if (path === `${BASE}/settings`) return json({ enabled: true });
      if (path === `${BASE}/settings/advanced`) return json({ enabled: false });
      if (path === BASE) return json([storyline]);
      if (path === `${BASE}/${SL}` && method === "PATCH") {
        Object.assign(storyline, JSON.parse(body!));
        return json({});
      }
      if (path === `${BASE}/${SL}/scenes`) return json([{ id: "sc-1", storylineId: SL, orderIndex: 0, title: "", notes: null, createdAt: "" }]);
      if (path === `${BASE}/${SL}/shots` && method === "GET") {
        return json([{ id: "sh-1", storylineId: SL, sceneId: "sc-1", orderIndex: 0, prompt: "Prompt", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], status: "draft", providerId: null, model: null, resultObjectKey: null, resultByteSize: null, estimatedCostCents: null, actualCostCents: null, attempt: 0, errorMessage: null, createdAt: "", pictureLookId: shotLook }]);
      }
      if (path === `${BASE}/${SL}/shots/sh-1` && method === "PATCH") {
        shotLook = JSON.parse(body!).pictureLookId;
        return json({});
      }
      if (path === `${BASE}/${SL}/progress`) return json(null);
      if (path === `${BASE}/${SL}/storyboard`) {
        const settings = (storyline.pictureSettings ?? {}) as { providerId?: string; model?: string; lookId?: string };
        const provider = settings.providerId ?? "sogni";
        return json({
          storylineId: SL,
          providerId: storyline.providerId,
          shots: [{ id: "sh-1", orderIndex: 0, storyboardStatus: "pending", stillObjectKey: null, stillContentType: null, stillByteSize: null, stillGeneratedAt: null, stillEstimatedCostCents: null, stillActualCostCents: null }],
          stillTotalCents: 0,
          allApproved: false,
          videoEstimatedTotalCents: 500,
          videoSpentCents: 0,
          approvalThresholdCents: null,
          pictureServices: { fal: false, sogni: true },
          picture: { providerId: provider, model: settings.model ?? null, lookId: settings.lookId ?? null, costPerPictureCents: provider === "sogni" ? 1 : 2 },
        });
      }
      return json({});
    }),
  );
}

describe("models and picture settings on the Storylines page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    calls = [];
    shotLook = null;
    storyline = {
      id: SL, companyId: COMPANY, projectId: null, title: "Film", status: "draft", providerId: "sogni", model: null, budgetCapCents: 1000, spentCents: 0,
      estimatedTotalCents: 500, estimatedTotalSeconds: 10, characterReferenceAssetIds: [], pictureSettings: {}, finalObjectKey: null, finalByteSize: null,
      finalDurationSeconds: null, stitchBlockedReason: null, errorMessage: null, createdAt: "", updatedAt: "",
    };
    actions["looks.list"] = vi.fn(async () => ({ looks: [{ id: "look-1", name: "Hero", style: "noir", model: null, provider: "sogni", referenceFileIds: [], referenceRoles: [], sheet: {}, loras: [], seed: null, updatedAt: "" }] }));
    actions["sogni.videoModels"] = vi.fn(async () => ({ models: SOGNI_ROWS, live: true, note: null }));
    actions["sogni.models"] = vi.fn(async () => ({ models: [{ id: "z_image_turbo_bf16", name: "Z-Image Turbo", tags: [], generates: true, takesReferences: false, workersOnline: 5, hasLoras: true, contentFilter: null }], live: true, note: null }));
    const fallback = vi.fn(async () => ({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginAction: (key: string) => actions[key] ?? fallback,
        useHostNavigation: () => ({ navigate: vi.fn(), linkProps: (to: string) => ({ href: to }) }),
      },
    };
    installFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(null, "", "/media-studio?tab=storylines");
    root = createRoot(container);
    await act(async () => {
      root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    });
    await flush();
    await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Film"))!);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("step 3: the video model is picked from Sogni's catalogue; switching service resets the model", async () => {
    await click(container.querySelector('[data-testid="step-render"]') as HTMLButtonElement);
    expect(actions["sogni.videoModels"]).toHaveBeenCalled();
    const picker = container.querySelector('[data-testid="video-model-picker"]')!;
    await choose(picker.querySelector('select[aria-label="Video model"]') as HTMLSelectElement, "seedance-2-0-fast");
    expect(JSON.parse(calls.filter((c) => c.method === "PATCH").at(-1)!.body!)).toEqual({ model: "seedance-2-0-fast" });
    await choose(container.querySelector('select[aria-label="Video service"]') as HTMLSelectElement, "fal");
    expect(JSON.parse(calls.filter((c) => c.method === "PATCH").at(-1)!.body!)).toEqual({ providerId: "fal", model: null });
  });

  it("step 2: picture service (only those with a key), model and look are saved; a shot can have its own look", async () => {
    // The guided flow opens on Pictures for this storyline.
    const settings = container.querySelector('[data-testid="picture-settings"]')!;
    expect(settings.textContent).toContain("Picture settings: Sogni, default model, no look (about $0.01 a picture)");
    const serviceOptions = Array.from((settings.querySelector('select[aria-label="Picture service"]') as HTMLSelectElement).options).map((o) => o.value);
    expect(serviceOptions).toEqual(["", "sogni"]);
    expect(actions["sogni.models"]).toHaveBeenCalled();

    await choose(settings.querySelector('select[aria-label="Look for storyboard pictures"]') as HTMLSelectElement, "look-1");
    expect(JSON.parse(calls.filter((c) => c.path === `${BASE}/${SL}` && c.method === "PATCH").at(-1)!.body!)).toEqual({ pictureSettings: { lookId: "look-1" } });
    expect(container.querySelector('[data-testid="picture-settings"]')!.textContent).toContain('look "Hero"');

    // The model comes from Sogni's picture catalogue (the Looks tab's picker).
    const option = Array.from(container.querySelectorAll('[role="listbox"][aria-label="Sogni models"] button')).find((b) => b.textContent?.includes("Z-Image Turbo")) as HTMLButtonElement;
    await click(option);
    expect(JSON.parse(calls.filter((c) => c.path === `${BASE}/${SL}` && c.method === "PATCH").at(-1)!.body!)).toEqual({ pictureSettings: { lookId: "look-1", model: "z_image_turbo_bf16" } });
  });

  it("step 2: per-shot look and the picture cost follow the chosen service", async () => {
    const tile = container.querySelector('[data-testid="storyboard-tile-sh-1"]')!;
    await choose(tile.querySelector("select") as HTMLSelectElement, "none");
    expect(JSON.parse(calls.find((c) => c.path === `${BASE}/${SL}/shots/sh-1` && c.method === "PATCH")!.body!)).toEqual({ pictureLookId: "none" });
    await click(container.querySelector('[data-testid="pictures-primary-make"]') as HTMLButtonElement);
    expect(container.querySelector('[data-testid="make-pictures-confirm"]')?.textContent).toContain("about $0.01 each");
  });
});
