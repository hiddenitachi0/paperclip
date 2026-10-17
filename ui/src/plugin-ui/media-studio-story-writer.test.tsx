// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryWriterSection, changeTitle, type WriterChange, type WriterSession } from "../../../packages/plugins/media-studio/src/ui/story-writer-panel";
import {
  DirectorsEditor,
  directorBody,
  directorWarning,
  pickerModelCanUseTools,
  type DirectorsView,
  type PickerModel,
  type StorylineDirector,
} from "../../../packages/plugins/media-studio/src/ui/directors-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Step 1's AI story writer: the director picker (readiness and the
 * text-only explanation), the ideas box and "Write my storyboard" (with the
 * price first), the chat with follow-up questions, accepting a list of
 * changes, and the directors editor (owners/admins only).
 */

const BASE = "/api/companies/co/video-storylines";

function model(overrides: Partial<StorylineDirector["writing"]> & { name: string }): NonNullable<StorylineDirector["writing"]> {
  return {
    entryId: `e-${overrides.name}`,
    provider: "openrouter",
    model: "org/m",
    keySecretId: null,
    keyReady: true,
    keyNote: "Uses the helper's OpenRouter key.",
    canSeePictures: false,
    toolSupport: { canUseTools: false, source: "hosts", reason: "no host" },
    readiness: { kind: "ready", ready: true, badge: "✅ Ready", warning: null, rank: 0 },
    ...overrides,
  };
}

function director(overrides: Partial<StorylineDirector> & { id: string; name: string }): StorylineDirector {
  return {
    description: "",
    builtinKey: null,
    writing: null,
    analysis: null,
    helper: null,
    temperature: null,
    thinking: null,
    styleInstructions: "",
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    defaultLookId: null,
    defaultShotSeconds: null,
    writerMode: "tools",
    writerModeNote: "The writing model can use tools, so it looks things up itself.",
    ...overrides,
  };
}

const DIRECTORS: DirectorsView = {
  canEdit: false,
  directors: [
    director({ id: "d-tut", name: "Tutorial / explainer", builtinKey: "tutorial" }),
    director({
      id: "d-act",
      name: "Action movie",
      writing: model({ name: "Story model" }),
      helper: model({ name: "Helper", provider: "openai", toolSupport: { canUseTools: true, source: "known", reason: "" } }),
      writerMode: "text_with_helper",
      writerModeNote: "This model can't use tools; the helper model does the lookups for it.",
    }),
  ],
};

function session(overrides: Partial<WriterSession> = {}): WriterSession {
  return { storylineId: "sl", directorId: null, state: "idle", messages: [], openQuestions: null, pendingChangeSetId: null, referenceOptions: [], ...overrides };
}

let host: HTMLDivElement;
let root: Root;

function makeFetch(opts: { session?: WriterSession; afterWrite?: WriterSession; directors?: DirectorsView; estimate?: Record<string, unknown> } = {}) {
  let current = opts.session ?? session();
  return vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === `${BASE}/directors` && method === "GET") return opts.directors ?? DIRECTORS;
    if (path.endsWith("/writer") && method === "GET") return current;
    if (path.endsWith("/writer/estimate")) {
      return opts.estimate ?? { writingCents: 3, videoCents: 840, summary: "Writing costs about $0.03 in AI writing.", blockedReason: null };
    }
    if (path.endsWith("/writer/write") || path.endsWith("/writer/answer") || path.endsWith("/accept") || path.endsWith("/discard") || path.endsWith("/writer/improve")) {
      current = opts.afterWrite ?? current;
      return current;
    }
    return {};
  });
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(fetchJson: ReturnType<typeof makeFetch>, props: Partial<Parameters<typeof StoryWriterSection>[0]> = {}) {
  await act(async () => {
    root.render(
      <StoryWriterSection
        companyId="co"
        storylineId="sl"
        directorId={null}
        shotIds={[]}
        editable
        fetchJson={fetchJson as never}
        looks={[]}
        onChanged={async () => {}}
        {...props}
      />,
    );
  });
  await flush();
  await flush();
}

const byText = (text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector(`[data-testid="${id}"]`) as T | null;

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function callsTo(fetchJson: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchJson.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("AI story writer in step 1", () => {
  it("lists the directors with their readiness and explains a writer that can't use tools", async () => {
    const fetchJson = makeFetch();
    await mount(fetchJson, { directorId: "d-act" });
    const picker = byTestId<HTMLSelectElement>("director-picker")!;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(["Tutorial / explainer · ✅ Company AI model", "Action movie · ✅ Ready"]);
    expect(picker.value).toBe("d-act");
    expect(byTestId("director-mode-note")!.textContent).toBe("This model can't use tools; the helper model does the lookups for it.");
    await choose(picker, "d-tut");
    expect(JSON.parse(callsTo(fetchJson, "/sl/director")[0][1].body)).toEqual({ directorId: "d-tut" });
  });

  it("writes from the ideas box after showing the price, and shows what was written", async () => {
    const written = session({
      messages: [
        { id: "m1", role: "person", kind: "brief", status: null, directorId: "d-tut", payload: { ideas: "A lighthouse at dusk", targetSeconds: 20 }, createdAt: "" },
        { id: "m2", role: "writer", kind: "storyboard", status: null, directorId: "d-tut", payload: { note: "Here it is.", shotCount: 3, sceneCount: 1, totalSeconds: 20, estimatedCostCents: 840, music: "soft piano", voice: null, appliedDefaults: [] }, createdAt: "" },
      ],
    });
    const fetchJson = makeFetch({ afterWrite: written });
    await mount(fetchJson);
    const button = byTestId<HTMLButtonElement>("write-storyboard")!;
    expect(button.textContent).toBe("Write my storyboard");
    expect(button.disabled).toBe(true);
    await typeInto(byTestId<HTMLTextAreaElement>("writer-ideas")!, "A lighthouse at dusk");
    await typeInto(host.querySelector('input[aria-label="Target length in seconds"]') as HTMLInputElement, "20");
    await flush(450);
    expect(byTestId("writer-estimate")!.textContent).toContain("Writing costs about $0.03");
    const estimateBody = JSON.parse(callsTo(fetchJson, "/writer/estimate").at(-1)![1].body);
    expect(estimateBody).toMatchObject({ directorId: "d-tut", kind: "write", targetSeconds: 20 });
    expect(byTestId<HTMLButtonElement>("write-storyboard")!.disabled).toBe(false);
    await click(byTestId("write-storyboard"));
    const body = JSON.parse(callsTo(fetchJson, "/writer/write")[0][1].body);
    expect(body).toEqual({ directorId: "d-tut", ideas: "A lighthouse at dusk", targetSeconds: 20, referenceUploadIds: [], useCastPictures: true, skipQuestions: false });
    expect(byTestId("writer-storyboard")!.textContent).toContain("Wrote 3 shots in 1 scene, 20 seconds");
    expect(byTestId("writer-storyboard")!.textContent).toContain("Music idea: soft piano");
  });

  it("refuses to write when the spending limit would stop it", async () => {
    const fetchJson = makeFetch({ estimate: { writingCents: 3, videoCents: null, summary: "x", blockedReason: "The company is paused. An owner can raise or lift the limit under Costs." } });
    await mount(fetchJson);
    await typeInto(byTestId<HTMLTextAreaElement>("writer-ideas")!, "Anything");
    await flush(450);
    expect(byTestId("writer-estimate")!.textContent).toContain("The company is paused");
    expect(byTestId<HTMLButtonElement>("write-storyboard")!.disabled).toBe(true);
  });

  it("asks follow-up questions in the chat and sends the answers", async () => {
    const asking = session({
      state: "asking",
      messages: [
        { id: "m1", role: "person", kind: "brief", status: null, directorId: null, payload: { ideas: "Lighthouse" }, createdAt: "" },
        { id: "m2", role: "writer", kind: "question", status: null, directorId: null, payload: { round: 1, questions: [] }, createdAt: "" },
      ],
      openQuestions: {
        messageId: "m2",
        questions: [
          { id: "q1", question: "Who is it for?", options: ["Kids", "Adults"] },
          { id: "q2", question: "Any must-haves?", options: [] },
        ],
      },
    });
    const fetchJson = makeFetch({ session: asking, afterWrite: session() });
    await mount(fetchJson);
    expect(byTestId("writer-questions")!.textContent).toContain("Who is it for?");
    // No ideas box while a question is open.
    expect(byTestId("writer-ideas")).toBeNull();
    await click(byText("Adults"));
    await typeInto(host.querySelector('input[aria-label="Answer: Any must-haves?"]') as HTMLInputElement, "A dog");
    await click(byText("Send answers"));
    expect(JSON.parse(callsTo(fetchJson, "/writer/answer")[0][1].body)).toEqual({
      answers: [
        { questionId: "q1", answer: "Adults" },
        { questionId: "q2", answer: "A dog" },
      ],
      skipQuestions: false,
    });
  });

  it("shows a list of changes side by side and accepts only the ticked ones", async () => {
    const changes: WriterChange[] = [
      { id: "c1", op: "update", shotId: "s2", shotNumber: 2, afterShotId: null, before: { prompt: "Ada walks", cameraNotes: null, durationSeconds: 5, transitionIn: null, cast: ["Ada"] }, after: { prompt: "Ada runs as thunder cracks", cameraNotes: null, durationSeconds: 5, transitionIn: null, cast: ["Ada"] }, status: "pending" },
      { id: "c2", op: "remove", shotId: "s3", shotNumber: 3, afterShotId: null, before: { prompt: "The lamp", cameraNotes: null, durationSeconds: 10, transitionIn: null, cast: [] }, after: null, status: "pending" },
    ];
    const reviewing = session({
      state: "reviewing",
      pendingChangeSetId: "cs1",
      messages: [{ id: "cs1", role: "writer", kind: "change_set", status: "pending", directorId: null, payload: { note: "More drama.", changes, replaceAll: null, secondsBefore: 20, secondsAfter: 10 }, createdAt: "" }],
    });
    const fetchJson = makeFetch({ session: reviewing });
    await mount(fetchJson, { shotIds: ["s1", "s2", "s3"] });
    const card = byTestId("change-set-cs1")!;
    expect(card.textContent).toContain("Shot 2: changed");
    expect(card.textContent).toContain("Ada walks");
    expect(card.textContent).toContain("Ada runs as thunder cracks");
    expect(card.textContent).toContain("Remove shot 3");
    expect(card.textContent).toContain("Length: 20s → 10s");
    // No new brief or change request while changes wait.
    expect(byTestId("writer-ideas")).toBeNull();
    await click(host.querySelector('input[aria-label="Use: Remove shot 3"]'));
    await click(byText("Accept selected (1)"));
    expect(JSON.parse(callsTo(fetchJson, "/changes/cs1/accept")[0][1].body)).toEqual({ changeIds: ["c1"] });
  });

  it("offers changes by request once there are shots", async () => {
    const fetchJson = makeFetch();
    await mount(fetchJson, { shotIds: ["s1"] });
    expect(byTestId("write-storyboard")!.textContent).toBe("Write a new storyboard");
    await typeInto(byTestId<HTMLTextAreaElement>("writer-request")!, "Shorten it to 45 seconds");
    await flush(450);
    await click(byTestId("writer-improve"));
    expect(JSON.parse(callsTo(fetchJson, "/writer/improve")[0][1].body)).toEqual({ request: "Shorten it to 45 seconds" });
  });

  it("names changes plainly", () => {
    const n = (id: string | null) => (id === "s1" ? 1 : null);
    expect(changeTitle({ id: "c", op: "add", shotId: null, shotNumber: null, afterShotId: "s1", before: null, after: null, status: "pending" }, n)).toBe("New shot after shot 1");
    expect(changeTitle({ id: "c", op: "add", shotId: null, shotNumber: null, afterShotId: null, before: null, after: null, status: "pending" }, n)).toBe("New shot at the start");
  });
});

describe("directors editor", () => {
  const MODELS: PickerModel[] = [
    { id: "m-text", name: "Story model", provider: "openrouter", model: "org/story", specs: { openrouterHostsSeen: [{ slug: "h", tools: false }] }, readiness: { kind: "ready", ready: true, badge: "✅ Ready", warning: null, rank: 0 } },
    { id: "m-tools", name: "Helper", provider: "openai", model: "gpt-4.1", specs: { tools: "yes" }, readiness: { kind: "key_per_use", ready: false, badge: "🔑 Needs its own key", warning: "x", rank: 1 } },
  ];

  function editorFetch(view: DirectorsView) {
    return vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === `${BASE}/directors` && method === "GET") return view;
      if (path.includes("/model-directory")) return MODELS;
      if (path.endsWith("/secrets")) return [{ id: "sec-1", name: "OpenAI key" }];
      return {};
    });
  }

  async function mountEditor(fetchJson: ReturnType<typeof editorFetch>) {
    await act(async () => {
      root.render(<DirectorsEditor companyId="co" fetchJson={fetchJson as never} looks={[{ id: "look-1", name: "Warm film" }]} />);
    });
    await flush();
    await flush();
  }

  it("is read-only for someone who is not an owner or admin", async () => {
    await mountEditor(editorFetch(DIRECTORS));
    expect(byText("Add director")).toBeUndefined();
    expect(byText("Delete")).toBeUndefined();
    expect(host.textContent).toContain("Only an owner or admin can add, change or delete directors.");
  });

  it("adds a director, explaining a writing model that can't use tools", async () => {
    const fetchJson = editorFetch({ ...DIRECTORS, canEdit: true });
    await mountEditor(fetchJson);
    await click(byText("Add director"));
    await typeInto(host.querySelector('input[aria-label="Director name"]') as HTMLInputElement, "Noir");
    await choose(byTestId<HTMLSelectElement>("director-writing-model")!, "m-text");
    expect(byTestId("director-text-only-note")!.textContent).toContain("This model can't use tools; the helper model does the lookups for it.");
    await choose(byTestId<HTMLSelectElement>("director-helper-model")!, "m-tools");
    expect(byTestId("director-text-only-note")!.textContent).not.toContain("Pick a helper model");
    await typeInto(host.querySelector('textarea[aria-label="Style instructions"]') as HTMLTextAreaElement, "Rain and neon.");
    await choose(host.querySelector('select[aria-label="Default picture look"]') as HTMLSelectElement, "look-1");
    await click(byText("Save director"));
    const post = fetchJson.mock.calls.find((c) => c[0] === `${BASE}/directors` && c[1]?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      name: "Noir",
      writingEntryId: "m-text",
      helperEntryId: "m-tools",
      styleInstructions: "Rain and neon.",
      defaultLookId: "look-1",
      temperature: null,
      thinking: null,
    });
  });

  it("deletes a director after asking", async () => {
    const fetchJson = editorFetch({ ...DIRECTORS, canEdit: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await mountEditor(fetchJson);
    await click(byText("Delete"));
    expect(fetchJson.mock.calls.some((c) => c[0] === `${BASE}/directors/d-tut` && c[1]?.method === "DELETE")).toBe(true);
    confirm.mockRestore();
  });

  it("helpers: tool support from the picker list, warnings and the request body", () => {
    expect(pickerModelCanUseTools(MODELS[0])).toBe(false);
    expect(pickerModelCanUseTools(MODELS[1])).toBe(true);
    expect(pickerModelCanUseTools({ ...MODELS[0]!, specs: { openrouterHostsSeen: [{ slug: "h", tools: true }] }, providerRouting: { ignore: ["h"] } })).toBe(false);
    expect(directorWarning(director({ id: "x", name: "X", writing: model({ name: "W", keyReady: false, keyNote: "Needs an OpenRouter key." }) }))).toBe('Writing model "W": Needs an OpenRouter key.');
    expect(directorWarning(director({ id: "x", name: "X", writerMode: "no_model", writerModeNote: "The writing model is gone." }))).toBe("The writing model is gone.");
    const body = directorBody({
      name: " A ",
      description: "",
      writingEntryId: null,
      writingKeySecretId: "sec-1",
      analysisEntryId: null,
      analysisKeySecretId: null,
      helperEntryId: null,
      helperKeySecretId: null,
      temperature: "0.8",
      thinking: "off",
      styleInstructions: "",
      defaultVideoProviderId: "",
      defaultVideoModel: "",
      defaultLookId: "",
      defaultShotSeconds: "10",
    });
    expect(body).toMatchObject({ name: "A", writingKeySecretId: null, temperature: 0.8, thinking: "off", defaultVideoProviderId: null, defaultShotSeconds: 10 });
  });
});
