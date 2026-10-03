// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaStudioLooksPage,
  clampStrength,
  draftToSaveParams,
  filterSogniModels,
  modelFilterNotice,
  type LookDraft,
} from "../../../packages/plugins/media-studio/src/ui/index";
import {
  lorasForModel,
  parseSogniLoraCatalog,
  parseSogniModelCatalog,
} from "../../../packages/plugins/media-studio/src/sogni-catalog";
import loraCatalog from "../../../server/src/__tests__/fixtures/sogni/loras-comfy.json";
import modelCatalog from "../../../server/src/__tests__/fixtures/sogni/model-catalog-image.json";

/**
 * Media Studio's looks page with Sogni: the searchable model picker (from
 * Sogni's live catalog), the LoRA section with a strength slider bounded by
 * each LoRA's own range, and the Sensitive content filter switch. The plugin's
 * actions are stubbed through the plugin UI bridge; the model and LoRA data are
 * trimmed copies of Sogni's real public answers (server test fixtures).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const DARK_BEAST_V9 = "dark_beast_z_image_turbo_v9_bf16";
const MODELS = parseSogniModelCatalog(modelCatalog)!.models;
const LORAS = parseSogniLoraCatalog(loraCatalog)!;
const MODELS_WITH_LORA_FLAG = MODELS.map((model) => ({ ...model, hasLoras: LORAS.models.includes(model.id) }));

const actions: Record<string, ReturnType<typeof vi.fn>> = {};

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    sdkUi: { usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn()) },
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

describe("Media Studio looks page with Sogni models and LoRAs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const key of Object.keys(actions)) delete actions[key];
    actions["looks.list"] = vi.fn(async () => ({ looks: [], canManage: true, maxReferenceFiles: 4 }));
    actions["looks.save"] = vi.fn(async () => ({ looks: [] }));
    actions["looks.delete"] = vi.fn(async () => ({ looks: [] }));
    actions["sogni.models"] = vi.fn(async () => ({ models: MODELS_WITH_LORA_FLAG, live: true, maxLoras: 8, note: null }));
    actions["sogni.loras"] = vi.fn(async ({ modelId }: { modelId: string }) => ({
      modelId,
      loras: lorasForModel(LORAS, modelId),
      maxLoras: 8,
      personal: "not-allowed",
      note: "Your own LoRAs are not shown: they need an active Sogni Unlimited plan.",
    }));
    installBridge();
    // No pictures in Files for these tests.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ artifacts: [] }), { status: 200 })));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  async function openNewSogniLook() {
    root = createRoot(container);
    root.render(<MediaStudioLooksPage context={{ companyId: COMPANY } as never} />);
    await flush();
    buttonNamed(container, "Add a look").click();
    await flush();
    const service = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "sogni"))!;
    setValue(service, "sogni");
    await flush();
  }

  const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];

  it("lists Sogni's models with workers online and LoRA badges, and searching narrows the list", async () => {
    await openNewSogniLook();
    expect(actions["sogni.models"]).toHaveBeenCalledTimes(1);
    const darkBeast = options().find((o) => o.textContent?.includes("Dark Beast Z-Image Turbo v9"))!;
    expect(darkBeast.textContent).toContain("85 workers online");
    expect(darkBeast.textContent).toContain("Filter off only");
    expect(options().find((o) => o.textContent?.startsWith("Krea 2 Turbo"))!.textContent).toContain("LoRAs");
    // Other builds of a model (here the Mac 4-bit one) stay hidden unless asked for.
    expect(options().some((o) => o.textContent?.includes("[MLX 4bit]"))).toBe(false);

    setValue(container.querySelector<HTMLInputElement>('input[aria-label="Search Sogni models"]')!, "krea");
    await flush();
    expect(options().map((o) => o.querySelector("span")!.textContent)).toEqual([
      "Dark Beast KREA 2 黑兽",
      "Krea 2 Identity Edit",
      "Krea 2 Turbo",
    ]);
  });

  it("picks Krea 2 Turbo, adds a LoRA with a slider bounded by its range, and saves the look", async () => {
    await openNewSogniLook();
    options().find((o) => o.textContent?.startsWith("Krea 2 Turbo"))!.click();
    await flush();
    expect(actions["sogni.loras"]).toHaveBeenLastCalledWith({ modelId: "krea2_turbo_fp8_scaled" });
    expect(container.querySelector('[aria-label="Chosen model"]')!.textContent).toContain(
      "Picture size: width 512 to 2048 (usually 1024), height 512 to 2048 (usually 1024).",
    );
    const loraSection = container.querySelector('[aria-label="LoRAs"]')!;
    expect(loraSection.textContent).toContain("Sogni does not add a LoRA's trigger words for you");
    expect(loraSection.textContent).toContain("Your own LoRAs are not shown");

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="LoRA to add"]')!;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Pick a LoRA to add…",
      "Detail Enhancer",
      "Warm Light",
      "Editorial <-> Candid",
      "Realism Engine v3 (filter off only)",
    ]);
    setValue(picker, "krea2-detail-enhancer");
    await flush();
    buttonNamed(container, "Add LoRA").click();
    await flush();

    const slider = container.querySelector<HTMLInputElement>('input[type="range"][aria-label="Strength of Detail Enhancer"]')!;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(["-5", "5", "0.1", "1"]);
    expect(loraSection.textContent).toContain("Strength -5 to 5; its maker recommends -2 to 5.");
    expect(loraSection.querySelector<HTMLAnchorElement>("a")!.href).toBe("https://civitai.com/models/2729908?modelVersionId=3068874");
    setValue(slider, "3");
    await flush();

    // The filter is on unless an owner turns it off.
    const filter = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(filter.checked).toBe(true);
    expect(container.textContent).toContain("Pictures made with the filter off can be explicit");

    setValue(container.querySelector<HTMLInputElement>('input[placeholder="Catalogue"]')!, "Catalogue");
    await flush();
    buttonNamed(container, "Save look").click();
    await flush();
    expect(actions["looks.save"]).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Catalogue",
        provider: "sogni",
        model: "krea2_turbo_fp8_scaled",
        loras: [{ id: "krea2-detail-enhancer", strength: 3 }],
        guidance: null,
        size: null,
        safeContentFilter: true,
      }),
    );
  });

  it("says Dark Beast Z-Image Turbo v9 needs the filter off and has no LoRAs, and saves the filter off when switched", async () => {
    await openNewSogniLook();
    options().find((o) => o.textContent?.includes("Dark Beast Z-Image Turbo v9"))!.click();
    await flush();
    expect(container.textContent).toContain("This model only works with the Sensitive content filter off.");
    expect(container.querySelector('[aria-label="LoRAs"]')!.textContent).toContain(
      "Sogni has no LoRAs for Dark Beast Z-Image Turbo v9 right now.",
    );
    const filter = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    filter.click();
    await flush();
    expect(filter.checked).toBe(false);
    setValue(container.querySelector<HTMLInputElement>('input[placeholder="Catalogue"]')!, "After dark");
    await flush();
    buttonNamed(container, "Save look").click();
    await flush();
    expect(actions["looks.save"]).toHaveBeenCalledWith(
      expect.objectContaining({ model: DARK_BEAST_V9, loras: [], safeContentFilter: false }),
    );
  });
});

describe("Media Studio looks page: default look per agent", () => {
  let container: HTMLDivElement;
  let root: Root;
  const MAJA = "33333333-3333-4333-8333-333333333333";
  const OLE = "34343434-3434-4343-8343-343434343434";
  const savedLooks = [
    { id: "look-night", name: "Maja Night", style: "", model: null, seed: null, referenceFileIds: [], updatedAt: "x" },
    { id: "look-cat", name: "Catalogue", style: "", model: null, seed: null, referenceFileIds: [], updatedAt: "x" },
  ];

  function stubActions(canManage: boolean) {
    for (const key of Object.keys(actions)) delete actions[key];
    actions["looks.list"] = vi.fn(async () => ({ looks: savedLooks, canManage, maxReferenceFiles: 4 }));
    actions["looks.delete"] = vi.fn(async () => ({ looks: [savedLooks[1]], defaults: {} }));
    actions["looks.defaults.list"] = vi.fn(async () => ({
      agents: [
        { id: MAJA, name: "Maja", title: "Social media" },
        { id: OLE, name: "Ole", title: null },
      ],
      defaults: { [MAJA]: "look-night" },
      canManage,
    }));
    actions["looks.defaults.set"] = vi.fn(async ({ agentId, lookId }: { agentId: string; lookId: string | null }) => ({
      defaults: lookId ? { [MAJA]: "look-night", [agentId]: lookId } : {},
    }));
    installBridge();
  }

  async function render() {
    root = createRoot(container);
    root.render(<MediaStudioLooksPage context={{ companyId: COMPANY } as never} />);
    await flush();
  }

  const selectFor = (name: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="Default look for ${name}"]`)!;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ artifacts: [] }), { status: 200 })));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("lists the agents with a select of saved looks or None, and saves a change at once", async () => {
    stubActions(true);
    await render();
    const section = container.querySelector('[aria-label="Default look per agent"]')!;
    expect(section.textContent).toContain("When this agent makes a picture without naming a look, it uses this one.");
    expect(selectFor("Maja").value).toBe("look-night");
    expect(selectFor("Ole").value).toBe("");
    expect([...selectFor("Ole").options].map((o) => o.textContent)).toEqual(["None", "Maja Night", "Catalogue"]);
    expect(selectFor("Ole").disabled).toBe(false);

    setValue(selectFor("Ole"), "look-cat");
    await flush();
    expect(actions["looks.defaults.set"]).toHaveBeenCalledWith({ agentId: OLE, lookId: "look-cat" });
    expect(selectFor("Ole").value).toBe("look-cat");

    setValue(selectFor("Maja"), "");
    await flush();
    expect(actions["looks.defaults.set"]).toHaveBeenLastCalledWith({ agentId: MAJA, lookId: null });
    expect(selectFor("Maja").value).toBe("");
  });

  it("clears a deleted look as a default on the page", async () => {
    stubActions(true);
    vi.stubGlobal("confirm", () => true);
    await render();
    expect(selectFor("Maja").value).toBe("look-night");
    buttonNamed(container, "Delete").click();
    await flush();
    expect(actions["looks.delete"]).toHaveBeenCalledWith({ id: "look-night" });
    expect(selectFor("Maja").value).toBe("");
  });

  it("shows the defaults to a member but does not let them change them", async () => {
    stubActions(false);
    await render();
    expect(selectFor("Maja").value).toBe("look-night");
    expect(selectFor("Maja").disabled).toBe(true);
    expect(container.textContent).toContain("Only the company's owner or an admin can change an agent's default look.");
  });

  it("shows why the agents could not be loaded instead of saying there are none", async () => {
    stubActions(true);
    actions["looks.defaults.list"] = vi.fn(async () => {
      throw new Error("The agents could not be read.");
    });
    await render();
    const section = container.querySelector('[aria-label="Default look per agent"]')!;
    expect(section.textContent).toContain("The agents could not be read.");
    expect(section.textContent).not.toContain("This company has no agents yet.");
    expect(section.textContent).not.toContain("Loading the agents");
    // The looks themselves still show.
    expect(container.textContent).toContain("Catalogue");
  });
});

describe("looks page helpers", () => {
  it("searches by name, id or tag, and hides other builds unless asked", () => {
    expect(filterSogniModels(MODELS, "uncensored spicy", false).map((m) => m.id)).toEqual([
      "dark_beast_krea2_fp8",
      DARK_BEAST_V9,
    ]);
    expect(filterSogniModels(MODELS, "turbo_bf16", false).map((m) => m.id)).toEqual(["z_image_turbo_bf16"]);
    expect(filterSogniModels(MODELS, "z_image_turbo_4", false)).toEqual([]);
    expect(filterSogniModels(MODELS, "z_image_turbo_4", true).map((m) => m.id)).toEqual(["z_image_turbo_4bit"]);
  });

  it("keeps a strength inside the LoRA's range and a Fal look free of Sogni settings", () => {
    expect(clampStrength(12, { min: -10, max: 10 })).toBe(10);
    expect(clampStrength(Number.NaN, { min: 0, max: 2 })).toBe(0);
    const draft: LookDraft = {
      id: null,
      name: "A",
      style: "",
      provider: "fal",
      model: "",
      seed: "",
      referenceFileIds: [],
      loras: [{ id: "krea2-candid", name: "Candid", strength: 3 }],
      guidance: "2",
      negativePrompt: "blur",
      width: "1280",
      height: "720",
      safeContentFilter: false,
    };
    expect(draftToSaveParams(draft)).toMatchObject({ loras: [], guidance: null, negativePrompt: null, size: null, safeContentFilter: true });
    expect(draftToSaveParams({ ...draft, provider: "sogni" })).toMatchObject({
      loras: [{ id: "krea2-candid", strength: 3 }],
      guidance: "2",
      negativePrompt: "blur",
      size: "1280x720",
      safeContentFilter: false,
    });
    expect(modelFilterNotice(MODELS.find((m) => m.id === "one_obsession_v22_fp16") ?? null)).toBeNull();
    expect(modelFilterNotice(MODELS.find((m) => m.id === "dark_beast_krea2_fp8")!)).toMatch(/only works with the Sensitive content filter off/);
  });
});
