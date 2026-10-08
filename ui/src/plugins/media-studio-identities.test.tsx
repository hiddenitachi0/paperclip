// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentitiesPanel, IdentitySettingsPanel, draftToParams, identityToDraft, type Identity } from "../../../packages/plugins/media-studio/src/ui/identities-panel";
import * as settingsPanel from "../../../packages/plugins/media-studio/src/ui/settings-panel";
import * as companySettings from "../../../packages/plugins/media-studio/src/company-settings";
import { RoomsPanel } from "../../../packages/plugins/media-studio/src/ui/rooms-panel";
import { MediaStudioLooksPage, draftToSaveParams, type LookDraft } from "../../../packages/plugins/media-studio/src/ui/index";
import * as helpers from "../../../packages/plugins/media-studio/src/ui/anchor-helpers";
import * as anchors from "../../../packages/plugins/media-studio/src/anchors";

/**
 * Media Studio's Identities and Rooms tabs, and the look editor's person
 * picker. The plugin's actions are stubbed through the plugin UI bridge.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const actions: Record<string, ReturnType<typeof vi.fn>> = {};

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    sdkUi: { usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn(async () => ({}))) },
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function buttonNamed(container: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

const LIST_BASE = {
  canManage: true,
  analysisReady: true,
  hfReady: true,
  consentText: { likeness: "This person is fictional/AI-generated, or I have their written consent to use their likeness.", adult: "This person is an adult (18+)." },
  seedExplanation: "Sogni's picture-editing models take no seed.",
  training: { steps: 1000, costCents: 300, minPictures: 10, maxPictures: 40, soulMin: 5, soulMax: 20, presets: ["front view", "profile view"] },
  editModels: ["qwen-lightning", "qwen", "krea-identity-edit"],
};

function identity(over: Partial<Identity> = {}): Identity {
  return {
    id: "id-1",
    name: "Maja",
    nickname: null,
    originalFileId: "orig",
    sheet: { hair: "blonde" },
    crops: [{ role: "face", fileId: "face-1", sourceFileId: "orig", box: { x: 0.3, y: 0, w: 0.3, h: 0.3 } }],
    canonicalFileId: null,
    canonicalAsReference: false,
    preferredModels: { sogni: "krea-identity-edit", sogniExtraSlot: "qwen", fal: null },
    lora: null,
    provenance: null,
    consent: { likeness: true, adult: true, confirmedBy: "owner-1", confirmedAt: "2026-10-08T10:00:00.000Z" },
    training: null,
    updatedAt: "x",
    ...over,
  };
}

const OPTIONS = {
  services: { sogni: true, fal: true, higgsfield: false },
  models: { sogni: ["krea-identity-edit", "qwen"], fal: ["fal-ai/nano-banana-2/edit", "fal-ai/flux-2-pro/edit"], higgsfield: ["soul"] },
  priceCents: { "fal-ai/nano-banana-2/edit": 8, "fal-ai/flux-2-pro/edit": 3 },
  priceNotes: { sogni: "Sogni credits.", fal: "Fal.ai's published price per picture.", higgsfield: "Not published." },
  reservedPerCallCents: 8,
  perCall: { sogni: 2, fal: 4, higgsfield: 4 },
  higgsfieldNote: "Higgsfield takes no reference pictures.",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const key of Object.keys(actions)) delete actions[key];
  installBridge();
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })));
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("anchor helpers", () => {
  it("action names match the worker's", () => {
    const worker = Object.entries(anchors).filter(([k]) => k.startsWith("ACTION_"));
    expect(worker.length).toBeGreaterThan(20);
    for (const [key, value] of worker) expect((helpers as Record<string, unknown>)[key]).toBe(value);
  });

  it("boxes move and resize inside the picture", () => {
    expect(helpers.moveBox({ x: 0.8, y: 0.8, w: 0.3, h: 0.3 }, 0.5, 0.5)).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
    expect(helpers.resizeBox({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 1, -1)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.02 });
  });

  it("finds the box around a mask's white pixels", () => {
    const w = 4;
    const h = 2;
    const data = new Uint8ClampedArray(w * h * 4);
    data[(1 * w + 2) * 4] = 255;
    expect(helpers.maskBox(data, w, h)).toEqual({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 });
    expect(helpers.maskBox(new Uint8ClampedArray(w * h * 4), w, h)).toBeNull();
  });
});

describe("Settings: analysis model and service keys", () => {
  it("the service-key action names match the worker's", () => {
    expect(settingsPanel.ACTION_SERVICE_KEYS_GET).toBe(companySettings.ACTION_SERVICE_KEYS_GET);
    expect(settingsPanel.ACTION_SERVICE_KEYS_SAVE).toBe(companySettings.ACTION_SERVICE_KEYS_SAVE);
  });

  it("the analysis model is picked only from the company's saved models (a local one included); nothing can be typed in", async () => {
    actions["identitySettings.get"] = vi.fn(async () => ({ settings: { analysis: null, hfTokenSecretId: null, hfNamespace: null }, canManage: true }));
    actions["identitySettings.save"] = vi.fn(async (p: any) => ({ settings: { analysis: p.analysis, hfTokenSecretId: null, hfNamespace: null } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const body = path.endsWith("/model-directory")
          ? [
              { id: "e-local", name: "Llava on the office PC", provider: "local", model: "llava:13b", baseUrl: "http://100.64.0.5:11434/v1", specs: { vision: true } },
              { id: "e-claude", name: "Claude Sonnet", provider: "anthropic", model: "claude-sonnet-5", baseUrl: null, specs: { vision: true } },
            ]
          : [{ id: "s-1", name: "Claude key" }];
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    root = createRoot(container);
    await act(async () => root.render(<IdentitySettingsPanel companyId={COMPANY} />));
    await flush();
    const select = container.querySelector('select[aria-label="Analysis model"]') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(["Pick a saved model…", "Llava on the office PC (llava:13b, own model server), can see pictures", "Claude Sonnet (claude-sonnet-5, Claude), can see pictures"]);
    expect(container.textContent).not.toMatch(/Type a model in|Address/);
    expect(container.textContent).toContain("own model server");
    setValue(select, "e-local");
    await flush();
    await click(buttonNamed(container, "Save settings"));
    expect(actions["identitySettings.save"]).toHaveBeenCalledWith({ analysis: { entryId: "e-local", label: "Llava on the office PC", keySecretId: null }, hfTokenSecretId: null, hfNamespace: null });
  });
});

describe("Identities tab", () => {
  it("a new identity cannot be saved until both confirmations are ticked, and sends them", async () => {
    actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, identities: [] }));
    actions["identities.save"] = vi.fn(async () => ({ identity: identity(), identities: [identity()] }));
    root = createRoot(container);
    await act(async () => root.render(<IdentitiesPanel context={{ companyId: COMPANY } as never} />));
    await flush();
    await click(buttonNamed(container, "New identity"));
    const name = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Name"))!.querySelector("input")!;
    await act(async () => setValue(name, "Maja"));
    const save = buttonNamed(container, "Save identity");
    expect(save.disabled).toBe(true);
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(container.textContent).toContain("written consent");
    expect(container.textContent).toContain("adult (18+)");
    await click(boxes[0]!);
    expect(buttonNamed(container, "Save identity").disabled).toBe(true);
    await click(boxes[1]!);
    expect(buttonNamed(container, "Save identity").disabled).toBe(false);
    await click(buttonNamed(container, "Save identity"));
    expect(actions["identities.save"]).toHaveBeenCalledWith(expect.objectContaining({ name: "Maja", consentLikeness: true, consentAdult: true }));
  });

  it("a member sees identities but no New button, and the consent shows on the details", async () => {
    actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, canManage: false, identities: [identity()] }));
    root = createRoot(container);
    await act(async () => root.render(<IdentitiesPanel context={{ companyId: COMPANY } as never} />));
    await flush();
    expect(container.textContent).toContain("Only an owner or admin can add identities.");
    await click(buttonNamed(container, /Maja/));
    expect(container.textContent).toContain("Confirmed by owner-1");
    expect(container.textContent).not.toContain("Make 4 candidates");
  });

  it("training needs the price confirmed before it starts", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `pic-${i}`);
    const trainingSet = {
      pictures: ids.map((fileId) => ({ fileId, source: "generated" as const, service: "sogni", model: "krea-identity-edit", loras: [], prompt: "front view", seed: null, batchId: "b1" })),
      selectedFileIds: ids,
      batches: [{ id: "b1", service: "sogni", model: "krea-identity-edit", count: 10, createdAt: "x" }],
      presets: ["front view"],
    };
    actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, identities: [identity({ trainingSet })] }));
    actions["identities.generationOptions"] = vi.fn(async () => OPTIONS);
    actions["lora.train"] = vi.fn(async () => ({ identity: identity({ trainingSet, training: { status: "training", trainedFileIds: ids, triggerWord: "maja_person", steps: 1000, estimatedCostCents: 300, resultUrl: null, error: null } }) }));
    root = createRoot(container);
    await act(async () => root.render(<IdentitiesPanel context={{ companyId: COMPANY } as never} />));
    await flush();
    await click(buttonNamed(container, /Maja/));
    const train = buttonNamed(container, "Train the LoRA");
    expect(train.disabled).toBe(true);
    expect(container.textContent).toContain("$3.00");
    // Each picture says how it was made.
    expect(container.querySelector('[aria-label="Training set"]')!.textContent).toContain("sogni krea-identity-edit");
    const cost = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("Training costs about"))!.querySelector("input")!;
    await click(cost);
    await click(buttonNamed(container, "Train the LoRA"));
    expect(actions["lora.train"]).toHaveBeenCalledWith(expect.objectContaining({ identityId: "id-1", confirmCostCents: 300 }));
    // Higgsfield's Soul ID needs its key; 10 ticked is inside 5-20.
    expect(buttonNamed(container, "Make a Soul ID").disabled).toBe(true);
    expect(buttonNamed(container, "Download 10 pictures").disabled).toBe(false);
  });

  it("Generate with offers only services with a key, models per service, and the estimate", async () => {
    actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, identities: [identity()] }));
    actions["identities.generationOptions"] = vi.fn(async () => OPTIONS);
    actions["sogni.loras"] = vi.fn(async () => ({ loras: [{ id: "l1", name: "Film look", min: 0, max: 1, default: 0.6, personal: false }], checks: [] }));
    actions["trainingSet.generate"] = vi.fn(async () => ({ pictures: [] }));
    root = createRoot(container);
    await act(async () => root.render(<IdentitiesPanel context={{ companyId: COMPANY } as never} />));
    await flush();
    await click(buttonNamed(container, /Maja/));
    const panel = container.querySelector('[aria-label="Training set"] [aria-label="Generate with"]')!;
    const [serviceSelect] = [...panel.querySelectorAll("select")] as HTMLSelectElement[];
    expect([...serviceSelect!.options].map((o) => o.value)).toEqual(["sogni", "fal"]);
    expect(panel.textContent).toContain("24 pictures in 12 calls");
    expect(panel.textContent).toContain("Film look");
    await act(async () => setValue(serviceSelect!, "fal"));
    await flush();
    const after = container.querySelector('[aria-label="Training set"] [aria-label="Generate with"]')!;
    expect(after.textContent).toContain("About $1.92 at Fal.ai");
  });

  it("an existing identity's edit form keeps its crops and sends no consent again", () => {
    const params = draftToParams(identityToDraft(identity()));
    expect(params).toMatchObject({ id: "id-1", crops: [{ role: "face", fileId: "face-1" }] });
    expect(params).not.toHaveProperty("consentAdult");
  });
});

describe("look editor: person picker", () => {
  it("saves the identity and 'same outfit'", () => {
    const draft = { id: null, name: "L", style: "", provider: "", model: "", seed: "", referenceFileIds: [], loras: [], guidance: "", negativePrompt: "", width: "", height: "", safeContentFilter: true, identityId: "id-1", identitySameOutfit: true } as LookDraft;
    expect(draftToSaveParams(draft)).toMatchObject({ identityId: "id-1", identitySameOutfit: true });
    expect(draftToSaveParams({ ...draft, identityId: "" })).toMatchObject({ identityId: null, identitySameOutfit: false });
  });

  it("lists the company's identities in the look editor", async () => {
    actions["looks.list"] = vi.fn(async () => ({ looks: [], canManage: true, maxReferenceFiles: 4 }));
    actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, identities: [identity()] }));
    actions["looks.defaults.list"] = vi.fn(async () => ({ agents: [], defaults: {} }));
    actions["lookRules.list"] = vi.fn(async () => ({ owners: [], sets: {} }));
    root = createRoot(container);
    await act(async () => root.render(<MediaStudioLooksPage context={{ companyId: COMPANY } as never} />));
    await flush();
    await click(buttonNamed(container, "Add a look"));
    const section = container.querySelector('[aria-label="Person (identity)"]')!;
    expect(section.textContent).toContain("Maja");
  });
});

describe("Rooms tab", () => {
  it("places the picked products into the picked area", async () => {
    const room = {
      id: "r1",
      name: "Living room",
      photoFileId: "photo",
      cameraNote: null,
      zones: [{ id: "z1", name: "Left wall", maskFileId: "mask" }],
      products: [{ id: "p1", name: "Sofa", fileId: "sofa", cutoutFileId: null }],
      updatedAt: "x",
    };
    actions["rooms.list"] = vi.fn(async () => ({ rooms: [room], canManage: false }));
    actions["rooms.place"] = vi.fn(async () => ({ imageDataUrl: "data:image/png;base64,AAAA", provider: "sogni" }));
    root = createRoot(container);
    await act(async () => root.render(<RoomsPanel context={{ companyId: COMPANY } as never} />));
    await flush();
    expect(container.textContent).toContain("Anyone in the company can place products.");
    await click(buttonNamed(container, /Living room/));
    const area = container.querySelector('[aria-label="Place product"] select') as HTMLSelectElement;
    await act(async () => setValue(area, "z1"));
    await click([...container.querySelectorAll('[aria-label="Place product"] input[type="checkbox"]')][0] as HTMLInputElement);
    await click(buttonNamed(container, "Place product"));
    expect(actions["rooms.place"]).toHaveBeenCalledWith(expect.objectContaining({ roomId: "r1", zoneId: "z1", productIds: ["p1"], service: "sogni" }));
    expect(container.querySelector('img[alt="Room with product"]')).not.toBeNull();
  });
});
