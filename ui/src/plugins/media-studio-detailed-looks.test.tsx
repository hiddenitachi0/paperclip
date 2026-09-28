// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaStudioLooksPage,
  REFERENCE_ROLE_OPTIONS,
  SHEET_FIELD_OPTIONS,
  draftToSaveParams,
  referenceLimitFor,
  type LookDraft,
} from "../../../packages/plugins/media-studio/src/ui/index";
import { REFERENCE_ROLE_LABELS, SHEET_FIELDS } from "../../../packages/plugins/media-studio/src/look-prompt";

/**
 * The looks page's detailed looks: a role under each picked reference
 * picture, a collapsible character sheet, "Lock seed" with its hint, and
 * "Preview prompt". The plugin's actions are stubbed through the plugin UI
 * bridge; the company's pictures come from a stubbed Files list.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PIC_A = "66666666-6666-4666-8666-666666666666";
const PIC_B = "77777777-7777-4777-8777-777777777777";

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

const OLD_LOOK = {
  id: "look-old",
  name: "Catalogue",
  style: "catalogue style",
  model: null,
  seed: null,
  referenceFileIds: [PIC_A],
  referenceRoles: ["other"],
  sheet: {},
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("Media Studio looks page: detailed looks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const key of Object.keys(actions)) delete actions[key];
    actions["looks.list"] = vi.fn(async () => ({ looks: [OLD_LOOK], canManage: true, maxReferenceFiles: 4 }));
    actions["looks.save"] = vi.fn(async () => ({ looks: [] }));
    actions["looks.defaults.list"] = vi.fn(async () => ({ agents: [], defaults: {}, canManage: true }));
    actions["lookRules.list"] = vi.fn(async () => ({ owners: [], ruleSets: {}, canManage: true }));
    actions["looks.previewPrompt"] = vi.fn(async (params: Record<string, unknown>) => ({
      request: params.request,
      prompt: `${String(params.request)}\n\nCharacter (...): Hair: long, blonde.`,
      negativePrompt: null,
      service: "fal",
      model: "fal-ai/flux-pro/kontext/multi",
      references: [{ position: 1, role: "face", label: "Face" }],
      leftOut: ["Outfit"],
    }));
    installBridge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            artifacts: [
              { title: "Maja face", contentPath: `/api/attachments/${PIC_A}/content`, mediaKind: "image" },
              { title: "Maja dress", contentPath: `/api/attachments/${PIC_B}/content`, mediaKind: "image" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  async function openNewLook() {
    root = createRoot(container);
    root.render(<MediaStudioLooksPage context={{ companyId: COMPANY } as never} />);
    await flush();
    buttonNamed(container, "Add a look").click();
    await flush();
    setValue(container.querySelector<HTMLInputElement>('input[placeholder="Catalogue"]')!, "Maja");
    await flush();
  }

  const pickPicture = async (title: string) => {
    container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!.click();
    await flush();
  };

  it("keeps the page's labels the same as the worker's", () => {
    expect(REFERENCE_ROLE_OPTIONS).toEqual(Object.entries(REFERENCE_ROLE_LABELS).map(([value, label]) => ({ value, label })));
    expect(SHEET_FIELD_OPTIONS.map(({ key, label }) => ({ key, label }))).toEqual(SHEET_FIELDS.map(({ key, label }) => ({ key, label })));
  });

  it("shows a role under each picked picture and saves the roles in order", async () => {
    await openNewLook();
    await pickPicture("Maja face");
    await pickPicture("Maja dress");
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select[aria-label^="What picture"]')];
    expect(selects.map((s) => s.getAttribute("aria-label"))).toEqual(["What picture 1 is for", "What picture 2 is for"]);
    expect([...selects[0]!.options].map((o) => o.textContent)).toEqual(["Face", "Body", "Outfit", "Style/aesthetic", "Background", "Other"]);
    expect(selects.map((s) => s.value)).toEqual(["other", "other"]);
    setValue(selects[0]!, "face");
    await flush();
    setValue(container.querySelector<HTMLSelectElement>('select[aria-label="What picture 2 is for"]')!, "outfit");
    await flush();
    // Unpicking the first picture keeps the second one's role with it.
    await pickPicture("Maja face");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="What picture 1 is for"]')!.value).toBe("outfit");
    await pickPicture("Maja face");

    buttonNamed(container, "Save look").click();
    await flush();
    expect(actions["looks.save"]).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Maja", referenceFileIds: [PIC_B, PIC_A], referenceRoles: ["outfit", "other"] }),
    );
  });

  it("has a collapsible character sheet whose fields are saved", async () => {
    await openNewLook();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Character sheet (optional)");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flush();
    const labels = [...details.querySelectorAll("label > span")].map((s) => s.textContent);
    expect(labels).toEqual(SHEET_FIELDS.map((f) => f.label));
    setValue(details.querySelector<HTMLInputElement>('input[aria-label="Hair"]')!, "long, blonde");
    setValue(details.querySelector<HTMLInputElement>('input[aria-label="Face"]')!, "small, petite nose, red lips");
    await flush();
    buttonNamed(container, "Save look").click();
    await flush();
    expect(actions["looks.save"]).toHaveBeenCalledWith(
      expect.objectContaining({ sheet: { hair: "long, blonde", face: "small, petite nose, red lips" } }),
    );
  });

  it("locks the seed with a hint, and unlocking saves no seed", async () => {
    await openNewLook();
    expect(container.textContent).toContain("A fixed seed with the same character sheet gives the most consistent results.");
    const lock = container.querySelector<HTMLInputElement>('input[aria-label="Lock seed"]')!;
    expect(lock.checked).toBe(false);
    expect(container.querySelector('input[aria-label="Seed"]')).toBeNull();
    lock.click();
    await flush();
    const seed = container.querySelector<HTMLInputElement>('input[aria-label="Seed"]')!;
    expect(seed.value).toMatch(/^\d+$/);
    setValue(seed, "4242");
    await flush();
    buttonNamed(container, "Save look").click();
    await flush();
    expect(actions["looks.save"]).toHaveBeenLastCalledWith(expect.objectContaining({ seed: "4242" }));

    buttonNamed(container, "Add a look").click();
    await flush();
    setValue(container.querySelector<HTMLInputElement>('input[placeholder="Catalogue"]')!, "Other");
    await flush();
    buttonNamed(container, "Save look").click();
    await flush();
    expect(actions["looks.save"]).toHaveBeenLastCalledWith(expect.objectContaining({ seed: null }));
  });

  it("previews the prompt the look would send for a sample request", async () => {
    await openNewLook();
    await pickPicture("Maja face");
    setValue(container.querySelector<HTMLSelectElement>('select[aria-label="What picture 1 is for"]')!, "face");
    await flush();
    const sample = container.querySelector<HTMLInputElement>('input[aria-label="Sample request"]')!;
    expect(sample.value).toBe("reading a book by the window");
    setValue(sample, "wearing a red dress");
    await flush();
    buttonNamed(container, "Preview prompt").click();
    await flush();
    expect(actions["looks.previewPrompt"]).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Maja", referenceFileIds: [PIC_A], referenceRoles: ["face"], request: "wearing a red dress" }),
    );
    expect(container.querySelector('[aria-label="Prompt that would be sent"]')!.textContent).toBe(
      "wearing a red dress\n\nCharacter (...): Hair: long, blonde.",
    );
    expect(container.textContent).toContain("Sent to Fal.ai (fal-ai/flux-pro/kontext/multi) with picture 1 as face");
    expect(container.textContent).toContain("Left out because the request describes it: Outfit.");
    expect(actions["looks.save"]).not.toHaveBeenCalled();
  });

  it("opens an older look with every picture as Other and shows its role on the card", async () => {
    root = createRoot(container);
    root.render(<MediaStudioLooksPage context={{ companyId: COMPANY } as never} />);
    await flush();
    expect(container.querySelector("figcaption")!.textContent).toBe("Other");
    buttonNamed(container, "Edit").click();
    await flush();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="What picture 1 is for"]')!.value).toBe("other");
  });
});

describe("detailed look helpers", () => {
  it("saves one role per picture and only filled sheet fields; the limit follows the Sogni model", () => {
    const draft: LookDraft = {
      id: null,
      name: "A",
      style: "",
      provider: "fal",
      model: "",
      seed: "",
      referenceFileIds: [PIC_A, PIC_B],
      referenceRoles: ["face"],
      sheet: { hair: "  long ", face: "" },
      loras: [],
      guidance: "",
      negativePrompt: "",
      width: "",
      height: "",
      safeContentFilter: true,
    };
    expect(draftToSaveParams(draft)).toMatchObject({ referenceRoles: ["face", "other"], sheet: { hair: "long" } });
    expect(referenceLimitFor("fal", null, 4)).toBe(4);
    expect(referenceLimitFor("sogni", null, 4)).toBe(3);
    expect(referenceLimitFor("sogni", { referenceLimit: 16 } as never, 4)).toBe(16);
  });
});
