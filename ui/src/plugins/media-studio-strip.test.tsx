// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripPanel, stripTakeCostCents, type StripGap, type StripSummary } from "../../../packages/plugins/media-studio/src/ui/strip-panel";

/**
 * Storyline strip (Simple editor, Phase 1): clip cards and a transition tile
 * in every gap; the inspector shows the plain sentence, the three choices
 * with the AI's suggestion and reason, the cost before anything is made,
 * the versions, and the folded exact prompt.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/companies/c1/video-storylines/sl-1";
const KLING = { provider: "fal", model: "fal-ai/kling-video/v3/standard/image-to-video", label: "Kling 3.0 Standard on Fal", minSeconds: 3, maxSeconds: 15, centsPerSecond: 8.4, soundCentsPerSecond: 12.6, soundIsFree: false, note: "No AI sound." };

function gap(overrides: Partial<StripGap> = {}): StripGap {
  return {
    id: "t-1",
    fromShotId: "sh-1",
    toShotId: "sh-2",
    kind: "ai",
    aiStyle: "follow_character",
    durationMs: 3000,
    plainLine: "The camera follows Anna out into the rain. 3 s.",
    prompt: "Continuous shot, no cut. Anna walks out.",
    userNote: null,
    suggestedKind: "ai",
    suggestReason: "Same place, she keeps moving.",
    keepSame: { face: true, clothes: true, location: true },
    audioMode: "bed_only",
    model: KLING.model,
    locked: false,
    chosenTakeId: null,
    state: "suggested",
    suggestionOutdated: false,
    textOnlyReason: null,
    takes: [],
    ...overrides,
  };
}

let summary: StripSummary;
let calls: Array<{ path: string; method: string; body?: string }>;

function makeSummary(g: StripGap, extra: Partial<StripSummary> = {}): StripSummary {
  return {
    storylineId: "sl-1",
    providerId: "fal",
    status: "done",
    clips: [
      { shotId: "sh-1", orderIndex: 0, prompt: "Anna drinks coffee", cameraNotes: null, durationSeconds: 5, status: "done", hasClip: true, hasPoster: true },
      { shotId: "sh-2", orderIndex: 1, prompt: "Anna in the rain", cameraNotes: null, durationSeconds: 5, status: "done", hasClip: true, hasPoster: true },
    ],
    gaps: [g],
    models: [KLING],
    defaultModel: KLING.model,
    budget: { capCents: 1000, spentCents: 120 },
    monthly: { capCents: 2000, spentCents: 0, explanation: "x" },
    writerProblem: null,
    readerLabel: "Claude Sonnet",
    readerProblem: null,
    combineProblems: [],
    canCombineAgain: true,
    ...extra,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (path === `${BASE}/strip`) return new Response(JSON.stringify(summary));
      return new Response(JSON.stringify(summary.gaps[0]));
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render(onCombineAgain = vi.fn(async () => undefined)) {
  root = createRoot(container);
  await act(async () => {
    root!.render(<StripPanel apiBase={BASE} editable onCombineAgain={onCombineAgain} />);
  });
  await act(async () => {});
  return onCombineAgain;
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("Storyline strip", () => {
  it("shows a clip card per shot and a transition tile in every gap", async () => {
    summary = makeSummary(gap());
    await render();
    expect(q("strip-clip-sh-1")).not.toBeNull();
    expect(q("strip-clip-sh-2")).not.toBeNull();
    expect(q("strip-gap-sh-1")!.textContent).toContain("AI bridge · 3 s");
    expect(q("strip-gap-sh-1")!.textContent).toContain("Suggested");
    expect(container.querySelector("img")!.getAttribute("src")).toBe(`${BASE}/shots/sh-1/poster`);
  });

  it("opens the inspector with the sentence, the suggestion and reason, and the cost before anything is made", async () => {
    summary = makeSummary(gap());
    await render();
    await act(async () => q("strip-gap-sh-1")!.click());
    expect((q("transition-plain-line") as HTMLTextAreaElement).value).toContain("follows Anna");
    expect(q("transition-kind-ai")!.textContent).toContain("(suggested)");
    expect(q("transition-reason")!.textContent).toContain("Same place, she keeps moving.");
    expect(q("transition-cost")!.textContent).toContain("$0.26");
    expect(q("transition-generate")!.textContent).toBe("Make it (about $0.26)");
    expect(container.textContent).toContain("Show exact AI prompt");
    expect(stripTakeCostCents(KLING, 3, "bed_only")).toBe(26);
  });

  it("makes a version only on a click, sending the cost the person saw", async () => {
    summary = makeSummary(gap());
    await render();
    await act(async () => q("strip-gap-sh-1")!.click());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await act(async () => q("transition-generate")!.click());
    const post = calls.find((c) => c.path === `${BASE}/transitions/t-1/generate`)!;
    expect(JSON.parse(post.body!)).toEqual({ confirmCostCents: 26 });
  });

  it("switches a gap to a smooth blend through the transitions route", async () => {
    summary = makeSummary(gap());
    await render();
    await act(async () => q("strip-gap-sh-1")!.click());
    await act(async () => q("transition-kind-blend")!.click());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe(`${BASE}/transitions`);
    expect(JSON.parse(put.body!)).toEqual({ fromShotId: "sh-1", toShotId: "sh-2", kind: "blend" });
  });

  it("lists versions with Use this one, and explains an out-of-date bridge and why the film can't be combined", async () => {
    summary = makeSummary(
      gap({
        state: "out_of_date",
        chosenTakeId: "k-1",
        takes: [
          { id: "k-2", status: "ready", provider: "fal", model: KLING.model, durationMs: 3000, costCents: 26, reservedCents: 26, note: "slower", error: null, current: true, createdAt: "" },
          { id: "k-1", status: "ready", provider: "fal", model: KLING.model, durationMs: 3000, costCents: 26, reservedCents: 26, note: null, error: null, current: false, createdAt: "" },
        ],
      }),
      { combineProblems: ["The AI bridge between shot 1 and shot 2 is out of date (a shot next to it changed). Make it again, or switch that gap to Cut or Smooth blend."], canCombineAgain: false },
    );
    await render();
    expect(q("strip-combine-problems")!.textContent).toContain("out of date");
    expect((q("strip-combine-again") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => q("strip-gap-sh-1")!.click());
    expect(q("transition-out-of-date")).not.toBeNull();
    expect(q("transition-versions")!.textContent).toContain("In use");
    expect(q("transition-generate")!.textContent).toContain("Try another");
    await act(async () => q("transition-use-k-2")!.click());
    expect(calls.some((c) => c.path === `${BASE}/transitions/t-1/takes/k-2/use` && c.method === "POST")).toBe(true);
  });

  it("says plainly when the company has no AI model for writing, and when it was written from the script only", async () => {
    summary = makeSummary(gap({ textOnlyReason: "This company has no picture-reading AI set up, so this transition was written from the script only." }), {
      writerProblem: "The AI director writes with this company's own AI model, and none is set up yet.",
    });
    await render();
    await act(async () => q("strip-gap-sh-1")!.click());
    expect(q("transition-writer-problem")!.textContent).toContain("none is set up yet");
    expect((q("transition-suggest") as HTMLButtonElement).disabled).toBe(true);
    expect(q("transition-text-only")!.textContent).toContain("from the script only");
  });

  it("combines a finished film again", async () => {
    summary = makeSummary(gap({ kind: "blend", state: "ready", durationMs: 500 }));
    const onCombine = await render();
    await act(async () => q("strip-combine-again")!.click());
    expect(onCombine).toHaveBeenCalledOnce();
  });
});
