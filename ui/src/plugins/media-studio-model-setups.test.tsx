// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoraLibraryPanel } from "../../../packages/plugins/media-studio/src/ui/lora-library-panel";
import { ModelSetupsPanel } from "../../../packages/plugins/media-studio/src/ui/model-setups-panel";
import { ModelSetupsTab } from "../../../packages/plugins/media-studio/src/ui/model-setups-tab";
import { StorylineSetupPicker } from "../../../packages/plugins/media-studio/src/ui/setup-picker";

/**
 * Media Studio's Model setups tab: the setups list (draft / approved, safe for
 * work / mature), creating and editing a setup, the approve button for owners
 * and admins, the LoRA library with the server's refusals in plain words, and
 * the setup picker in a film's settings. Everyone who is not an owner or admin
 * only looks.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const STORYLINE = "22222222-2222-4222-8222-222222222222";
const LORA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LORA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SETUP_DRAFT = "33333333-3333-4333-8333-333333333333";
const SETUP_APPROVED = "44444444-4444-4444-8444-444444444444";
const SETUP_MATURE = "55555555-5555-4555-8555-555555555555";

const actions: Record<string, ReturnType<typeof vi.fn>> = {};

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    react: { createElement },
    sdkUi: {
      usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn(async () => ({}))),
      useHostNavigation: () => ({ navigate: vi.fn(), linkProps: (to: string) => ({ href: to }) }),
    },
  };
}

function lora(over: Record<string, unknown> = {}) {
  return {
    id: LORA_A,
    provider: "sogni",
    source: "catalog",
    ref: "h3-better-motion",
    name: "Better Motion",
    notes: "Smoother, more natural movement.",
    triggerWords: [],
    family: "h3",
    compatibleModelIds: [],
    contentTag: "sfw",
    effectiveContentTag: "sfw",
    contentNote: null,
    strengthMin: 0,
    strengthMax: 1.5,
    strengthDefault: 0.6,
    recommendedMin: 0.4,
    recommendedMax: 0.8,
    builtinKey: "sogni-h3-better-motion",
    archivedAt: null,
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  return {
    id: SETUP_DRAFT,
    kind: "video",
    name: "Natural",
    description: "Everyday movement.",
    provider: "sogni",
    family: "h3",
    mode: "flf2v",
    modelId: "minimax-h3-fl2va-fp8_flf2v",
    editModelId: null,
    loras: [{ loraId: LORA_A, strength: 0.6, name: "Better Motion", ref: "h3-better-motion", source: "catalog", triggerWords: [], contentTag: "sfw" }],
    params: { promptExpansion: false },
    contentRating: "sfw",
    matureReasons: [],
    status: "draft",
    approvedAt: null,
    tags: ["starter"],
    favorite: false,
    notes: "",
    builtinKey: "natural",
    billingLabel: "Covered by the Sogni Unlimited plan",
    triggerWords: [],
    problems: [],
    ...over,
  };
}

type Call = { method: string; path: string; body: unknown };
type Responder = (call: Call) => { status?: number; json?: unknown } | undefined;

let calls: Call[] = [];
function installFetch(responder: Responder) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const reply = responder(call) ?? { status: 404, json: { error: "Not found" } };
      if (reply.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
    }),
  );
}

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function button(within: Element, label: string | RegExp): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll("button")).find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? "")));
  if (!found) throw new Error(`No button ${String(label)}. Buttons: ${Array.from(within.querySelectorAll("button")).map((b) => b.textContent).join(" | ")}`);
  return found as HTMLButtonElement;
}
const hasButton = (within: Element, label: string) => Array.from(within.querySelectorAll("button")).some((b) => b.textContent?.trim() === label);

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
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const byLabel = <T extends Element>(root: Element, label: string) => root.querySelector(`[aria-label="${label}"]`) as unknown as T;

let container: HTMLDivElement;
let root: Root;
async function render(node: React.ReactNode) {
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

beforeEach(() => {
  for (const key of Object.keys(actions)) delete actions[key];
  installBridge();
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function setupsApi(opts: { canEdit: boolean; setups?: unknown[]; loras?: unknown[]; extra?: Responder }): Responder {
  return (call) => {
    const extra = opts.extra?.(call);
    if (extra) return extra;
    const path = call.path.split("?")[0]!;
    if (call.method === "GET" && path.endsWith("/media/setups")) return { json: { setups: opts.setups ?? [], canEdit: opts.canEdit } };
    if (call.method === "GET" && path.endsWith("/media/loras")) return { json: { loras: opts.loras ?? [lora()], canEdit: opts.canEdit } };
    return undefined;
  };
}

describe("Model setups tab", () => {
  it("opens on the setups and switches to the LoRA library", async () => {
    installFetch(setupsApi({ canEdit: true, setups: [setup()] }));
    await render(<ModelSetupsTab companyId={COMPANY} />);
    expect(container.textContent).toContain("Natural");
    await click(button(container, "LoRA library"));
    expect(container.querySelector('section[aria-label="LoRA library"]')).not.toBeNull();
    expect(container.textContent).toContain("Better Motion");
  });
});

describe("Model setups list", () => {
  it("shows draft or approved, safe for work or mature, the LoRAs and why a setup is mature", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        setups: [
          setup(),
          setup({ id: SETUP_APPROVED, name: "Action", status: "approved", loras: [{ loraId: LORA_A, strength: 0.8, name: "Better Motion", ref: "x", source: "catalog", triggerWords: [], contentTag: "sfw" }] }),
          setup({ id: SETUP_MATURE, name: "Spicy", contentRating: "mature", matureReasons: ['The LoRA "Wild" has not been reviewed yet, so it counts as mature.'] }),
        ],
      }),
    );
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    const draft = container.querySelector(`[data-testid="setup-${SETUP_DRAFT}"]`)!;
    expect(draft.textContent).toContain("Draft");
    expect(draft.textContent).toContain("Safe for work");
    expect(draft.textContent).toContain("Better Motion at 0.6");
    const approved = container.querySelector(`[data-testid="setup-${SETUP_APPROVED}"]`)!;
    expect(approved.textContent).toContain("Approved");
    expect(approved.textContent).toContain("Better Motion at 0.8");
    const mature = container.querySelector(`[data-testid="setup-${SETUP_MATURE}"]`)!;
    expect(mature.textContent).toContain("Mature");
    expect(mature.textContent).toContain("has not been reviewed yet");
  });

  it("lets an owner or admin approve a draft and send an approved setup back to draft", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        setups: [setup(), setup({ id: SETUP_APPROVED, name: "Action", status: "approved" })],
        extra: (call) => (call.method === "PATCH" ? { json: setup() } : undefined),
      }),
    );
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    const draft = container.querySelector(`[data-testid="setup-${SETUP_DRAFT}"]`)!;
    await click(button(draft, "Approve"));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: `/api/companies/${COMPANY}/media/setups/${SETUP_DRAFT}`, body: { status: "approved" } });
    expect(container.textContent).toContain('"Natural" is approved. Agents can now pick it for films.');
    const approved = container.querySelector(`[data-testid="setup-${SETUP_APPROVED}"]`)!;
    await click(button(approved, "Send back to draft"));
    expect(calls.filter((c) => c.method === "PATCH").pop()).toMatchObject({ path: `/api/companies/${COMPANY}/media/setups/${SETUP_APPROVED}`, body: { status: "draft" } });
  });

  it("shows the server's reasons one per line when a setup cannot be approved", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        setups: [setup()],
        extra: (call) =>
          call.method === "PATCH"
            ? { status: 422, json: { error: "x y", details: { problems: ["Wan 3 takes no LoRA on any service.", "The same LoRA is in the list twice. Keep it once."] } } }
            : undefined,
      }),
    );
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    await click(button(container, "Approve"));
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("This cannot be saved yet:");
    expect(alert.textContent).toContain("- Wan 3 takes no LoRA on any service.");
    expect(alert.textContent).toContain("- The same LoRA is in the list twice. Keep it once.");
  });

  it("shows a setup that cannot be used right now with its reasons", async () => {
    installFetch(setupsApi({ canEdit: true, setups: [setup({ problems: ['The LoRA "Better Motion" is refused and can never be used. Remove it.'] })] }));
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    expect(container.textContent).toContain("It cannot be used right now:");
    expect(container.textContent).toContain("is refused and can never be used");
  });

  it("is view-only for everyone who is not an owner or admin", async () => {
    installFetch(setupsApi({ canEdit: false, setups: [setup(), setup({ id: SETUP_APPROVED, name: "Action", status: "approved" })] }));
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    expect(container.textContent).toContain("Only owners and admins can change it.");
    for (const label of ["Approve", "Edit", "Archive", "Delete", "Send back to draft", "New video setup", "New picture setup"]) {
      expect(hasButton(container, label)).toBe(false);
    }
    expect(container.textContent).toContain("Natural");
    expect(container.textContent).toContain("Action");
  });

  it("deletes only after asking again", async () => {
    installFetch(setupsApi({ canEdit: true, setups: [setup()], extra: (call) => (call.method === "DELETE" ? { status: 204 } : undefined) }));
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    await click(button(container, "Delete"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await click(button(container, /Yes, delete/));
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/api/companies/${COMPANY}/media/setups/${SETUP_DRAFT}`);
    expect(container.textContent).toContain('"Natural" is deleted.');
  });
});

describe("Making and changing a setup", () => {
  it("creates a draft with a model, a LoRA at an explicit strength and prompt expansion set", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        setups: [],
        extra: (call) => (call.method === "POST" && call.path.endsWith("/media/setups") ? { status: 201, json: setup({ name: "Action" }) } : undefined),
      }),
    );
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    await click(button(container, "New video setup"));
    await type(byLabel(container, "Setup name"), "Action");
    await choose(byLabel(container, "Model"), "minimax-h3-fl2va-fp8_flf2v");
    await click(button(container, "Add a LoRA"));
    // The LoRA starts at its own default strength; the person changes it.
    expect(byLabel<HTMLInputElement>(container, "Strength 1").value).toBe("0.6");
    await type(byLabel(container, "Strength 1"), "0.8");
    await click(button(container, "Save"));
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/media/setups"))!;
    expect(post.body).toMatchObject({
      kind: "video",
      name: "Action",
      provider: "sogni",
      modelId: "minimax-h3-fl2va-fp8_flf2v",
      loras: [{ loraId: LORA_A, strength: 0.8 }],
      params: { promptExpansion: false },
      status: "draft",
    });
    expect(container.textContent).toContain('"Action" is saved as a draft.');
  });

  it("checks a setup before saving and shows the rating and the server's problems", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        setups: [],
        extra: (call) =>
          call.path.endsWith("/media/setups/check")
            ? { json: { ok: false, problems: ["Wan 3 takes no LoRA on any service (Sogni, Fal or Higgsfield). Remove the LoRAs."], contentRating: "sfw", matureReasons: [], billingLabel: "x", triggerWords: [] } }
            : undefined,
      }),
    );
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    await click(button(container, "New video setup"));
    await type(byLabel(container, "Setup name"), "Calm");
    await choose(byLabel(container, "Model"), "wan3.0-video");
    await click(button(container, "Check this setup"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Wan 3 takes no LoRA");
  });

  it("tells the person that changing an approved setup sends it back to draft, and reports it after saving", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        setups: [setup({ status: "approved" })],
        extra: (call) => (call.method === "PATCH" ? { json: setup({ status: "draft" }) } : undefined),
      }),
    );
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    await click(button(container, "Edit"));
    expect(container.textContent).toContain("it goes back to draft and has to be approved again");
    await type(byLabel(container, "Strength 1"), "0.8");
    await click(button(container, "Save"));
    const patch = calls.find((c) => c.method === "PATCH")!;
    // Only what changed is sent, so a rename never trips over an old problem.
    expect(Object.keys(patch.body as object)).toEqual(["loras"]);
    expect(container.textContent).toContain("it went back to draft");
  });

  it("does not offer LoRAs for a service that takes none, and asks for numbers where numbers belong", async () => {
    installFetch(setupsApi({ canEdit: true, setups: [] }));
    await render(<ModelSetupsPanel companyId={COMPANY} />);
    await click(button(container, "New picture setup"));
    await choose(byLabel(container, "Service"), "higgsfield");
    expect(container.textContent).toContain("This service takes no LoRAs.");
    expect(hasButton(container, "Add a LoRA")).toBe(false);
    await choose(byLabel(container, "Service"), "sogni");
    await type(byLabel(container, "Setup name"), "Stills");
    await choose(byLabel(container, "Model"), "krea2_turbo_fp8_scaled");
    await type(byLabel(container, "Steps"), "many");
    expect(container.textContent).toContain("Type a number for: Steps.");
    expect(button(container, "Save").disabled).toBe(true);
  });
});

describe("LoRA library", () => {
  it("lists LoRAs with their mark and strengths, and is view-only for others", async () => {
    installFetch(setupsApi({ canEdit: false, loras: [lora(), lora({ id: LORA_B, name: "Wild", contentTag: "unreviewed", effectiveContentTag: "unreviewed", ref: "w" })] }));
    await render(<LoraLibraryPanel companyId={COMPANY} />);
    expect(container.textContent).toContain("Better Motion");
    expect(container.textContent).toContain("Starts at strength 0.6 (works best between 0.4 to 0.8)");
    expect(container.textContent).toContain("Not checked yet");
    expect(container.textContent).toContain("count as mature until it is checked");
    expect(container.textContent).toContain("Only owners and admins can change it.");
    for (const label of ["Edit", "Archive", "Delete", "Add from Sogni's list", "Add a Fal link"]) expect(hasButton(container, label)).toBe(false);
  });

  it("shows the server's refusal for a link that carries a key in plain words", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        loras: [],
        extra: (call) =>
          call.method === "POST"
            ? { status: 422, json: { error: "x", details: { problems: ['The LoRA link holds what looks like a key or password ("token", after the "?" or "#"). Remove that part and save the link again.'] } } }
            : undefined,
      }),
    );
    await render(<LoraLibraryPanel companyId={COMPANY} />);
    await click(button(container, "Add a Fal link"));
    await type(byLabel(container, "Link to the LoRA file"), "https://civitai.com/api/download/models/1?token=abc");
    await type(byLabel(container, "Name for the LoRA"), "Sketchy");
    await click(button(container, "Add to library"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("looks like a key or password");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ provider: "fal", source: "url", name: "Sketchy", contentTag: "unreviewed" });
  });

  it("adds a LoRA from Sogni's list, marked as mature when Sogni says so", async () => {
    actions["sogni.loras"] = vi.fn(async () => ({
      loras: [
        { id: "h3-better-motion", name: "Better Motion", description: "Smoother movement", personal: false, modelIds: ["minimax-h3-fl2va-fp8_flf2v"], min: 0, max: 1.5, default: 0.6, recommendedMin: 0.4, recommendedMax: 0.8, needsFilterOff: false, sexual: false },
        { id: "h3-wild", name: "Wild", description: "", personal: false, modelIds: [], min: 0, max: 1, default: 0.5, needsFilterOff: true, sexual: false },
      ],
    }));
    installFetch(setupsApi({ canEdit: true, loras: [], extra: (call) => (call.method === "POST" ? { status: 201, json: lora() } : undefined) }));
    await render(<LoraLibraryPanel companyId={COMPANY} />);
    await click(button(container, "Add from Sogni's list"));
    await click(button(container, "Show the LoRAs"));
    expect(actions["sogni.loras"]).toHaveBeenCalledWith({ modelId: "minimax-h3-fl2va-fp8_flf2v" });
    expect(container.textContent).toContain("Sogni marks this one as mature. It will be added as mature.");
    await click(byLabel(container, "Add Wild"));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ provider: "sogni", source: "catalog", ref: "h3-wild", name: "Wild", contentTag: "mature", providerNsfw: true });
  });

  it("archives, restores and deletes (after asking again)", async () => {
    installFetch(
      setupsApi({
        canEdit: true,
        loras: [lora(), lora({ id: LORA_B, name: "Old one", ref: "old", archivedAt: "2026-10-01T00:00:00Z" })],
        extra: (call) => (call.method === "PATCH" ? { json: lora() } : call.method === "DELETE" ? { status: 204 } : undefined),
      }),
    );
    await render(<LoraLibraryPanel companyId={COMPANY} />);
    const card = container.querySelector(`[data-testid="lora-${LORA_A}"]`)!;
    await click(button(card, "Archive"));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: `/api/companies/${COMPANY}/media/loras/${LORA_A}`, body: { archived: true } });
    const old = container.querySelector(`[data-testid="lora-${LORA_B}"]`)!;
    await click(button(old, "Restore"));
    expect(calls.filter((c) => c.method === "PATCH").pop()?.body).toEqual({ archived: false });
    await click(button(container.querySelector(`[data-testid="lora-${LORA_A}"]`)!, "Delete"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await click(button(container, /Yes, delete/));
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/api/companies/${COMPANY}/media/loras/${LORA_A}`);
  });

  it("edits a LoRA: its safe-for-work mark and prompt words", async () => {
    installFetch(setupsApi({ canEdit: true, loras: [lora({ contentTag: "unreviewed", effectiveContentTag: "unreviewed" })], extra: (call) => (call.method === "PATCH" ? { json: lora() } : undefined) }));
    await render(<LoraLibraryPanel companyId={COMPANY} />);
    await click(button(container, "Edit"));
    await choose(byLabel(container, "Is it safe for work?"), "sfw");
    await type(byLabel(container, "Prompt words"), "smooth, flowing");
    await click(button(container, "Save changes"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ contentTag: "sfw", triggerWords: ["smooth", "flowing"], strengthDefault: 0.6 });
  });
});

describe("Setup picker in a film's settings", () => {
  it("offers approved setups only and saves the pick", async () => {
    const onChanged = vi.fn();
    installFetch((call) => {
      if (call.method === "GET") return { json: { setups: [setup(), setup({ id: SETUP_APPROVED, name: "Action", status: "approved" }), setup({ id: SETUP_MATURE, name: "Spicy", status: "approved", contentRating: "mature" })], canEdit: false } };
      if (call.method === "PUT") return { json: {} };
      return undefined;
    });
    await render(<StorylineSetupPicker companyId={COMPANY} storylineId={STORYLINE} kind="video" value={null} onChanged={onChanged} />);
    const select = byLabel<HTMLSelectElement>(container, "Video model setup");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["None: I choose the service and model myself", "Action (safe for work)", "Spicy (mature)"]);
    await choose(select, SETUP_APPROVED);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: `/api/companies/${COMPANY}/media/storylines/${STORYLINE}/setups`, body: { videoSetupId: SETUP_APPROVED } });
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the server's reason when a mature setup is picked for a safe-for-work film", async () => {
    installFetch((call) => {
      if (call.method === "GET") return { json: { setups: [setup({ id: SETUP_MATURE, name: "Spicy", status: "approved", contentRating: "mature" })], canEdit: false } };
      if (call.method === "PUT") return { status: 422, json: { error: '"Spicy" is rated mature, and this storyline is safe for work, so it can only use setups rated safe for work.' } };
      return undefined;
    });
    await render(<StorylineSetupPicker companyId={COMPANY} storylineId={STORYLINE} kind="video" value={null} />);
    await choose(byLabel(container, "Video model setup"), SETUP_MATURE);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("so it can only use setups rated safe for work");
  });

  it("clears the pick, and says so when nothing is approved yet", async () => {
    installFetch((call) => (call.method === "GET" ? { json: { setups: [setup()], canEdit: false } } : { json: {} }));
    await render(<StorylineSetupPicker companyId={COMPANY} storylineId={STORYLINE} kind="image" value={null} />);
    expect(container.textContent).toContain("No approved picture setups yet.");
  });
});
