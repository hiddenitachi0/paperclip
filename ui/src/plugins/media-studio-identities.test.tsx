// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdentitiesPanel,
  IdentitySettingsPanel,
  addSourcePicture,
  draftToParams,
  identityToDraft,
  makeMainSource,
  removeSourcePicture,
  withNewCrops,
  type Identity,
} from "../../../packages/plugins/media-studio/src/ui/identities-panel";
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
        const body = path.includes("/model-directory")
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

describe("analysis model readiness", () => {
  const ready = { kind: "ready", ready: true, badge: "✅ Ready", local: true, runLabel: "Local — installed", detail: "Installed on office-pc.", warning: null, rank: 0 };
  const missing = {
    kind: "not_installed",
    ready: false,
    badge: "⚠️ Not installed on office-pc",
    local: true,
    runLabel: "Local — not installed",
    detail: "Not installed on office-pc.",
    warning: "This model is not installed on office-pc. Install it there (ollama pull llava:34b), then press Refresh status on the Models page.",
    rank: 3,
  };
  const hostedKey = { kind: "key_per_use", ready: false, badge: "🔑 Needs its own key", local: false, runLabel: null, detail: "", warning: "Needs a key.", rank: 1 };

  it("shows each saved model's readiness from the host, ready ones first, and says what to do for a model that is not installed", async () => {
    actions["identitySettings.get"] = vi.fn(async () => ({ settings: { analysis: { entryId: "e-missing", label: "Big llava", keySecretId: null }, hfTokenSecretId: null, hfNamespace: null }, canManage: true }));
    const fetchMock = vi.fn(async (path: string) => {
      const body = path.includes("/model-directory")
        ? [
            { id: "e-missing", name: "Big llava", provider: "local", model: "llava:34b", baseUrl: null, specs: { vision: true }, readiness: missing },
            { id: "e-or", name: "Qwen VL", provider: "openrouter", model: "qwen/qwen2.5-vl-72b-instruct", baseUrl: null, specs: { vision: true }, readiness: hostedKey },
            { id: "e-ready", name: "Llava", provider: "local", model: "llava:13b", baseUrl: "http://office-pc:11434/v1", specs: { vision: true }, readiness: ready },
          ]
        : [{ id: "s-1", name: "OpenRouter key" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    root = createRoot(container);
    await act(async () => root.render(<IdentitySettingsPanel companyId={COMPANY} />));
    await flush();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/model-directory?withReadiness=1"))).toBe(true);
    const select = container.querySelector('select[aria-label="Analysis model"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Pick a saved model…",
      "✅ Ready · Llava (llava:13b, Local — installed), can see pictures",
      "🔑 Needs its own key · Qwen VL (qwen/qwen2.5-vl-72b-instruct, OpenRouter), can see pictures",
      "⚠️ Not installed on office-pc · Big llava (llava:34b, Local — not installed), can see pictures",
    ]);
    const warning = container.querySelector('[data-testid="analysis-model-warning"]')!;
    expect(warning.textContent).toContain("ollama pull llava:34b");
    expect(warning.querySelector("a")!.getAttribute("href")).toBe("/company/settings/models");

    // A hosted model with no key picked yet: the warning says to pick the key below; picking one clears it.
    setValue(select, "e-or");
    await flush();
    expect(container.querySelector('[data-testid="analysis-model-warning"]')!.textContent).toMatch(/Needs a key: pick the OpenRouter key/);
    const keySelect = [...container.querySelectorAll("select")].find((el) => [...(el as HTMLSelectElement).options].some((o) => o.value === "s-1")) as HTMLSelectElement;
    setValue(keySelect, "s-1");
    await flush();
    expect(container.querySelector('[data-testid="analysis-model-warning"]')).toBeNull();

    // A ready one: no warning.
    setValue(select, "e-ready");
    await flush();
    expect(container.querySelector('[data-testid="analysis-model-warning"]')).toBeNull();
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
    actions["ageCheck.status"] = vi.fn(async (p: { fileIds: string[] }) => ({ pictures: p.fileIds.map((fileId) => ({ fileId, name: null, verdict: "adult" })) }));
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

  it("checks pictures not checked yet (with progress) before training, and refuses pictures that are not clearly adult", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `pic-${i}`);
    const trainingSet = {
      pictures: ids.map((fileId) => ({ fileId, source: "upload" as const, service: null, model: null, loras: [], prompt: null, seed: null, batchId: null })),
      selectedFileIds: ids,
      batches: [],
      presets: ["front view"],
    };
    const explanation = "Every picture is checked for apparent age before it leaves Paperclip. Pictures that are not clearly of an adult are never sent.";
    actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, identities: [identity({ trainingSet })], ageCheck: { explanation, costNote: "One call each.", model: "Vision" } }));
    actions["identities.generationOptions"] = vi.fn(async () => OPTIONS);
    // pic-0..7 already checked; pic-8 and pic-9 are not.
    const known: Record<string, string | null> = Object.fromEntries(ids.map((id, i) => [id, i < 8 ? "adult" : null]));
    actions["ageCheck.status"] = vi.fn(async (p: { fileIds: string[] }) => ({ pictures: p.fileIds.map((fileId) => ({ fileId, name: `${fileId}.png`, verdict: known[fileId] })) }));
    actions["ageCheck.run"] = vi.fn(async (p: { fileIds: string[] }) => {
      for (const id of p.fileIds) known[id] = id === "pic-9" ? "unclear" : "adult";
      return { pictures: p.fileIds.map((fileId) => ({ fileId, name: `${fileId}.png`, verdict: known[fileId] })) };
    });
    actions["lora.train"] = vi.fn(async () => ({}));
    root = createRoot(container);
    await act(async () => root.render(<IdentitiesPanel context={{ companyId: COMPANY } as never} />));
    await flush();
    await click(buttonNamed(container, /Maja/));
    expect(container.querySelector('[aria-label="Age check"]')!.textContent).toContain(explanation);
    expect(container.querySelector('[data-age="unchecked"]')!.textContent).toBe("Age not checked yet");
    const cost = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("Training costs about"))!.querySelector("input")!;
    await click(cost);
    await click(buttonNamed(container, "Train the LoRA"));
    // Only the two unchecked pictures were checked, one call each; pic-9 is refused and training never starts.
    expect(actions["ageCheck.run"]!.mock.calls.map((c) => c[0])).toEqual([{ fileIds: ["pic-8"] }, { fileIds: ["pic-9"] }]);
    expect(actions["lora.train"]).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Nothing was sent. This picture is not clearly of an adult: pic-9.png (not clearly an adult)");
    expect(container.querySelector('[data-age="unclear"]')!.textContent).toBe("Refused: not clearly an adult");
    // Without the refused picture it goes ahead, with no further checks.
    known["pic-9"] = "adult";
    await click(buttonNamed(container, "Train the LoRA"));
    expect(actions["ageCheck.run"]).toHaveBeenCalledTimes(2);
    expect(actions["lora.train"]).toHaveBeenCalledTimes(1);
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

// ─── Several pictures of one person, and Sogni's v0.3 alpha ──────────────────

const ALPHA = "krea2_identity_edit_sogni_v0_3_alpha";
const NAMES = {
  "krea-identity-edit": "Krea 2 Identity Edit v1.2 (keeps faces best)",
  [ALPHA]: "Krea 2 Identity Edit v0.3 (alpha, Sogni's own test version)",
  qwen: "Qwen Image Edit 2511 (3 pictures)",
};

function twoPictureIdentity(): Identity {
  return identity({
    sourcePictures: [
      { fileId: "orig", addedAt: "a" },
      { fileId: "full", addedAt: "b" },
    ],
    crops: [
      { role: "face", fileId: "face-1", sourceFileId: "orig", box: { x: 0.3, y: 0, w: 0.3, h: 0.3 } },
      { role: "body", fileId: "body-1", sourceFileId: "full", box: { x: 0.1, y: 0, w: 0.8, h: 1 } },
    ],
  });
}

async function openEditor(item: Identity, list: Record<string, unknown> = {}) {
  actions["identities.list"] = vi.fn(async () => ({ ...LIST_BASE, ...list, identities: [item] }));
  root = createRoot(container);
  await act(async () => root.render(<IdentitiesPanel context={{ companyId: COMPANY } as never} />));
  await flush();
  await click(buttonNamed(container, /Maja/));
  await click(buttonNamed(container, "Edit"));
}

describe("Identities tab: several pictures of the person", () => {
  it("an identity saved with one picture (no sourcePictures) opens with that picture and its boxes, and saves both fields", () => {
    const draft = identityToDraft(identity());
    expect(draft.sourceFileIds).toEqual(["orig"]);
    expect(draft.activeSource).toBe("orig");
    expect(draft.boxes).toEqual({ orig: [{ role: "face", box: { x: 0.3, y: 0, w: 0.3, h: 0.3 } }] });
    expect(draftToParams(draft)).toMatchObject({ originalFileId: "orig", sourceFileIds: ["orig"] });
  });

  it("adds, removes and reorders pictures; a new crop replaces the same kind from any picture", () => {
    let draft = identityToDraft(twoPictureIdentity());
    expect(draft.boxes).toEqual({ orig: [{ role: "face", box: expect.any(Object) }], full: [{ role: "body", box: expect.any(Object) }] });
    draft = addSourcePicture(draft, "third");
    expect(draft).toMatchObject({ sourceFileIds: ["orig", "full", "third"], activeSource: "third" });
    expect(addSourcePicture(draft, "orig").sourceFileIds).toHaveLength(3);
    draft = makeMainSource(draft, "full");
    expect(draftToParams(draft)).toMatchObject({ originalFileId: "full", sourceFileIds: ["full", "orig", "third"] });
    draft = removeSourcePicture(draft, "third");
    expect(draft.activeSource).toBe("full");
    draft = withNewCrops(draft, [{ role: "face", fileId: "face-2", sourceFileId: "full", box: null }]);
    expect(draft.crops.map((c) => [c.role, c.fileId, c.sourceFileId])).toEqual([
      ["body", "body-1", "full"],
      ["face", "face-2", "full"],
    ]);
  });

  it("the crop editor crops from the picked picture, explains which picture to use, and shows each picture's age check", async () => {
    actions["ageCheck.status"] = vi.fn(async (p: { fileIds: string[] }) => ({ pictures: p.fileIds.map((fileId) => ({ fileId, name: null, verdict: fileId === "full" ? "adult" : null })) }));
    actions["identities.crop"] = vi.fn(async () => ({ crops: [{ role: "body", box: { x: 0.1, y: 0, w: 0.8, h: 1 }, imageDataUrl: "data:image/png;base64,AAAA" }] }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        String(path).endsWith("/files")
          ? new Response(JSON.stringify({ id: "body-2" }), { status: 200, headers: { "Content-Type": "application/json" } })
          : // The page's Blob (jsdom), so FormData takes it.
            { ok: true, blob: async () => new Blob(["x"], { type: "image/png" }) },
      ),
    );
    actions["identities.save"] = vi.fn(async () => ({ identity: twoPictureIdentity(), identities: [twoPictureIdentity()] }));
    await openEditor(twoPictureIdentity());
    expect(container.textContent).toContain("Use a close-up for the face and a full-body photo for the body.");
    const pictures = container.querySelector('[aria-label="The person\'s pictures"]')!;
    expect(pictures.textContent).toContain("Picture 1 (main)");
    expect(pictures.textContent).toContain("Crops: Body");
    expect(actions["ageCheck.status"]).toHaveBeenCalledWith({ fileIds: ["orig", "full"] });
    expect(container.querySelector('[data-source="full"] [data-age="adult"]')!.textContent).toBe("Age checked: adult");
    expect(container.querySelector('[data-source="orig"] [data-age="unchecked"]')!.textContent).toBe("Age not checked yet");
    expect(buttonNamed(container, "Upload another picture")).toBeTruthy();
    const editor = () => container.querySelector('[aria-label="Crop editor"] img') as HTMLImageElement;
    expect(editor().getAttribute("src")).toContain("orig");
    await click(container.querySelector('[aria-label="Crop from picture 2"]') as HTMLButtonElement);
    expect(editor().getAttribute("src")).toContain("full");
    expect(container.querySelector('[aria-label="Crop editor"] [aria-label="body box"]')).not.toBeNull();
    expect(container.textContent).toContain("Cropping from picture 2");
    await click(buttonNamed(container, "Make crops"));
    expect(actions["identities.crop"]).toHaveBeenCalledWith({ fileId: "full", boxes: [{ role: "body", box: { x: 0.1, y: 0, w: 0.8, h: 1 } }] });
    await click(buttonNamed(container, "Save identity"));
    expect(actions["identities.save"]).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFileIds: ["orig", "full"], crops: expect.arrayContaining([expect.objectContaining({ role: "body", fileId: "body-2", sourceFileId: "full" })]) }),
    );
  });

  it("analysing another picture fills only empty fields and asks about the differing ones", async () => {
    actions["identities.analyse"] = vi.fn(async () => ({
      ok: true,
      fileId: "full",
      sheet: { hair: "short red hair", body: "tall" },
      crops: { face: { x: 0.4, y: 0, w: 0.2, h: 0.2 }, body: { x: 0, y: 0, w: 1, h: 1 }, outfit: null },
      model: "Vision model",
      merged: { hair: "blonde", body: "tall" },
      filled: ["body"],
      conflicts: [{ key: "hair", label: "Hair", current: "blonde", suggested: "short red hair" }],
    }));
    await openEditor(twoPictureIdentity());
    await click(container.querySelector('[aria-label="Crop from picture 2"]') as HTMLButtonElement);
    await click(buttonNamed(container, "Analyse this picture"));
    expect(actions["identities.analyse"]).toHaveBeenCalledWith({ fileId: "full", currentSheet: { hair: "blonde" }, merge: "fill-empty" });
    expect(container.textContent).toContain("Filled 1 empty field.");
    const hair = () => [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Hair"))!.querySelector("input")!;
    const body = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Body and proportions"))!.querySelector("input")!;
    expect(hair().value).toBe("blonde");
    expect(body.value).toBe("tall");
    const ask = container.querySelector('[aria-label="Different descriptions"]')!;
    expect(ask.textContent).toContain('now "blonde", this picture: "short red hair"');
    await click(buttonNamed(container, "Use the new text"));
    expect(hair().value).toBe("short red hair");
    expect(container.querySelector('[aria-label="Different descriptions"]')).toBeNull();
  });

  it("offers Sogni's v0.3 alpha by a plain name for the identity's model and in Generate with", async () => {
    actions["identities.generationOptions"] = vi.fn(async () => ({ ...OPTIONS, models: { ...OPTIONS.models, sogni: ["krea-identity-edit", ALPHA, "qwen"] }, modelNames: NAMES }));
    actions["identities.save"] = vi.fn(async () => ({ identity: identity(), identities: [identity()] }));
    await openEditor(identity(), { editModels: ["krea-identity-edit", ALPHA, "qwen"], editModelNames: NAMES });
    expect(container.textContent).toContain("v0.3 is Sogni's own alpha");
    const select = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Sogni model") && !l.textContent?.includes("extra"))!.querySelector("select")!;
    expect([...select.options].map((o) => o.textContent)).toEqual([NAMES["krea-identity-edit"], NAMES[ALPHA], NAMES.qwen]);
    expect(select.value).toBe("krea-identity-edit");
    await act(async () => setValue(select, ALPHA));
    await click(buttonNamed(container, "Save identity"));
    expect(actions["identities.save"]).toHaveBeenCalledWith(expect.objectContaining({ preferredModels: expect.objectContaining({ sogni: ALPHA }) }));
    // Candidates and training batches: the same plain names.
    await flush();
    const generate = container.querySelector('[aria-label="Candidates"] [aria-label="Generate with"]')!;
    const model = [...generate.querySelectorAll("select")][1] as HTMLSelectElement;
    expect([...model.options].map((o) => o.textContent)).toContain(NAMES[ALPHA]);
  });
});
