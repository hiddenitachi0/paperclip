// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperModelOption, HelperSettingsView } from "@paperclipai/shared";

/**
 * Ask Paperclip, Phase 2 in the panel: attach / paste / remove pictures,
 * the plain "this model cannot see pictures" gate with the models that can,
 * readiness on every model option (ready first), and "Apply to …" still
 * working for an answer about a picture.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHelperApi = vi.hoisted(() => ({
  ask: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listInvestigations: vi.fn(async () => ({ investigations: [], availability: null })),
  startInvestigation: vi.fn(),
}));
const mockArtifactsApi = vi.hoisted(() => ({ list: vi.fn(), listAgents: vi.fn() }));
vi.mock("../../api/helper", () => ({ helperApi: mockHelperApi }));
vi.mock("../../api/artifacts", () => ({ artifactsApi: mockArtifactsApi }));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme" } }),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("../../lib/helper-capture", () => ({
  captureHelperContext: () => ({ text: "Label: Character sheet", truncated: false, entities: [], applyTargets: ["Character sheet (all fields)"], itemCount: 1 }),
  viewportRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  rectFromPoints: () => ({ left: 0, top: 0, width: 100, height: 100 }),
}));

import { HelperOverlay } from "./HelperOverlay";
import { registerHelperApplyTarget } from "../../lib/helper-apply";

const ok = { kind: "key_set", label: "Key set", detail: "The helper has a key.", tone: "ok" } as const;
const needsKey = { kind: "needs_key", label: "Needs a key", detail: "The helper has no OpenRouter key yet.", tone: "fail" } as const;
const notInstalled = { kind: "not_installed", label: "Not installed", detail: "Not installed on the model server.", tone: "fail" } as const;

function model(id: string, name: string, extra: Partial<HelperModelOption>): HelperModelOption {
  return {
    id,
    name,
    provider: "openrouter",
    providerLabel: "OpenRouter",
    model: `x/${id}`,
    maker: "Acme AI",
    baseModel: null,
    lane: null,
    favorite: false,
    keyReady: true,
    keyHint: null,
    canSeePictures: true,
    picturesSource: "setting",
    status: ok,
    ...extra,
  };
}

function settings(overrides: Partial<HelperSettingsView> = {}): HelperSettingsView {
  return {
    defaultDirectoryEntryId: null,
    investigationAgentId: null,
    investigationMaxRunning: 3,
    investigationMaxPerDay: 20,
    keys: [],
    models: [
      model("m-blind", "Text only", { canSeePictures: false, status: needsKey, keyReady: false, keyHint: "The helper has no OpenRouter key yet." }),
      model("m-local", "Gemma local", { provider: "local", providerLabel: "Local", canSeePictures: true, status: notInstalled }),
      model("m-eyes", "Eyes", {}),
    ],
    builtInDefaultLabel: "Claude",
    builtInDefaultCanSeePictures: true,
    builtInDefaultStatus: { kind: "paperclip_key", label: "Paperclip's key", detail: "Runs on Paperclip's own key.", tone: "ok" },
    canEdit: false,
    updatedAt: null,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function openPanel() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/ACM/personas/hero"]}>
          <HelperOverlay />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  act(() => {
    (document.querySelector("[data-testid=helper-open]") as HTMLButtonElement).click();
  });
  await flush();
}

function pngFile(name = "shot.png", size = 10) {
  return new File([new Uint8Array(size).fill(1)], name, { type: "image/png" });
}

async function attach(files: File[]) {
  const input = document.querySelector("[data-testid=helper-file-input]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function typeQuestion(text: string) {
  const textarea = document.querySelector("textarea[aria-label='Your question']") as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

function selectModel(id: string) {
  const select = document.querySelector("[data-testid=helper-model]") as HTMLSelectElement;
  act(() => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const sendButton = () => document.querySelector("button[aria-label=Send]") as HTMLButtonElement;

describe("HelperOverlay pictures", () => {
  it("attaches, pastes and removes pictures, refuses wrong kinds and more than 4, and sends them once", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue({ answer: "A login form.", directoryEntryId: null, modelLabel: "Claude", provider: "anthropic", model: "c", inputTokens: 1, outputTokens: 1, costCents: 0, truncated: false, pictureCount: 2 });
    await openPanel();

    await attach([pngFile("a.png"), new File(["%PDF"], "doc.pdf", { type: "application/pdf" })]);
    expect(document.querySelectorAll("[data-testid=helper-picture]")).toHaveLength(1);
    expect(document.querySelector("[data-testid=helper-pictures]")!.textContent).toContain('"doc.pdf" is not a PNG, JPEG, WebP or GIF picture.');

    // Paste a screenshot from the clipboard.
    const textarea = typeQuestion("What's wrong in this screenshot?");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [pngFile("image.png")], items: [] } });
    await act(async () => {
      textarea.dispatchEvent(paste);
    });
    await flush();
    expect(document.querySelectorAll("[data-testid=helper-picture]")).toHaveLength(2);

    // Too many.
    await attach([pngFile("c.png"), pngFile("d.png"), pngFile("e.png")]);
    expect(document.querySelectorAll("[data-testid=helper-picture]")).toHaveLength(4);
    expect(document.querySelector("[data-testid=helper-pictures]")!.textContent).toContain("at most 4 pictures");

    // Remove two.
    act(() => (document.querySelector("button[aria-label='Remove c.png']") as HTMLButtonElement).click());
    act(() => (document.querySelector("button[aria-label='Remove d.png']") as HTMLButtonElement).click());
    expect(document.querySelectorAll("[data-testid=helper-picture]")).toHaveLength(2);

    await act(async () => sendButton().click());
    await flush();
    expect(mockHelperApi.ask).toHaveBeenCalledTimes(1);
    const body = mockHelperApi.ask.mock.calls[0]![1];
    expect(body.pictures).toHaveLength(2);
    expect(body.pictures[0]).toMatchObject({ kind: "upload", name: "a.png", contentType: "image/png" });
    expect(typeof body.pictures[0].dataBase64).toBe("string");
    expect(body.pictures[0].dataBase64.startsWith("data:")).toBe(false);
    // Cleared after sending; the question shows its pictures.
    expect(document.querySelectorAll("[data-testid=helper-picture]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-testid=helper-turn-pictures] img")).toHaveLength(2);

    // A follow-up does not send the pictures again, but the history says they existed.
    typeQuestion("Shorter please");
    await act(async () => sendButton().click());
    await flush();
    const second = mockHelperApi.ask.mock.calls[1]![1];
    expect(second.pictures).toBeUndefined();
    expect(second.history[0].content).toContain("2 pictures were attached to this question");
  });

  it("says plainly when the chosen model cannot see pictures, offers the ones that can, and shows readiness on each option", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    await openPanel();
    const select = document.querySelector("[data-testid=helper-model]") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options[0]).toBe("Use default (Claude) — ✅ Ready");
    // Ready first, then "check", then "will not work"; never a bare "Local".
    expect(options.slice(1)).toEqual(["Eyes — ✅ Ready", "Gemma local — ⚠️ Not installed", "Text only — ❌ Needs a key"]);

    selectModel("m-blind");
    expect(document.querySelector("[data-testid=helper-model-warning]")!.textContent).toContain("❌ Needs a key");

    typeQuestion("Describe this");
    await attach([pngFile()]);
    const gate = document.querySelector("[data-testid=helper-vision-gate]")!;
    expect(gate.textContent).toContain("“Text only” cannot look at pictures");
    expect(gate.textContent).toContain("“Pictures” setting under Company settings → Models");
    expect(sendButton().disabled).toBe(true);
    expect(select.textContent).toContain("Text only — ❌ Needs a key · can't see pictures");
    const offered = Array.from(document.querySelectorAll("[data-testid=helper-vision-option]")).map((b) => b.textContent);
    expect(offered).toEqual(["Paperclip's default", "Eyes", "Gemma local"]);

    act(() => (document.querySelectorAll("[data-testid=helper-vision-option]")[1] as HTMLButtonElement).click());
    expect(document.querySelector("[data-testid=helper-vision-gate]")).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(mockHelperApi.ask).not.toHaveBeenCalled();
  });

  it("picks a picture from the company's Files by its attachment id", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockArtifactsApi.list.mockResolvedValue({
      artifacts: [
        { id: "attachment:11111111-1111-4111-8111-111111111111", source: "attachment", mediaKind: "image", title: "hero.jpg", contentType: "image/jpeg", byteSize: 1000, thumbnailPath: "/api/attachments/1/thumbnail" },
        { id: "document:x", source: "document", mediaKind: "image", title: "doc", contentType: "image/png", byteSize: 1, thumbnailPath: null },
        { id: "attachment:22222222-2222-4222-8222-222222222222", source: "attachment", mediaKind: "image", title: "vector.svg", contentType: "image/svg+xml", byteSize: 10, thumbnailPath: null },
      ],
      nextCursor: null,
    });
    mockHelperApi.ask.mockResolvedValue({ answer: "ok", directoryEntryId: null, modelLabel: "Claude", provider: "anthropic", model: "c", inputTokens: 1, outputTokens: 1, costCents: 0, truncated: false, pictureCount: 1 });
    await openPanel();
    act(() => (document.querySelector("[data-testid=helper-from-files]") as HTMLButtonElement).click());
    await flush();
    const choices = document.querySelectorAll("[data-testid=helper-file-option]");
    expect(choices).toHaveLength(1);
    act(() => (choices[0] as HTMLButtonElement).click());
    typeQuestion("Describe");
    await act(async () => sendButton().click());
    await flush();
    expect(mockHelperApi.ask.mock.calls[0]![1].pictures).toEqual([{ kind: "file", fileId: "11111111-1111-4111-8111-111111111111" }]);
  });

  it("still applies a picture-based answer to the marked field", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue({
      answer: "Here it is:\n```\nName: Mira\nLooks: red coat\n```",
      directoryEntryId: null,
      modelLabel: "Claude",
      provider: "anthropic",
      model: "c",
      inputTokens: 1,
      outputTokens: 1,
      costCents: 0,
      truncated: false,
      pictureCount: 1,
    });
    const setter = vi.fn();
    const unregister = registerHelperApplyTarget("Character sheet (all fields)", setter);
    try {
      await openPanel();
      await attach([pngFile("photo.png")]);
      typeQuestion("Write a character sheet from this photo");
      await act(async () => sendButton().click());
      await flush();
      const apply = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Apply to Character sheet (all fields)");
      expect(apply).toBeTruthy();
      act(() => apply!.click());
      expect(setter).toHaveBeenCalledWith("Name: Mira\nLooks: red coat");
    } finally {
      unregister();
    }
  });
});
