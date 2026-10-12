// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";
import {
  computeSteps,
  pictureCounts,
  refusalToItem,
  renderReadiness,
  suggestedBudgetCents,
  suggestedStep,
  type FlowInput,
  type FlowStoryboardShot,
} from "../../../packages/plugins/media-studio/src/ui/storyline-flow";

/**
 * The guided Storylines flow (1 Script -> 2 Pictures -> 3 Budget & render ->
 * 4 Film): step status lines, the "what is missing" checklist and its
 * one-click fixes, the server-refusal mapping, AI suggestions vs picture
 * approval, and the bulk picture actions.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Pure helpers ──────────────────────────────────────────────────────────

function sbShot(i: number, status: FlowStoryboardShot["storyboardStatus"], still: boolean): FlowStoryboardShot {
  return { id: `sh-${i}`, orderIndex: i, storyboardStatus: status, stillObjectKey: still ? `k-${i}` : null };
}

function flow(overrides: Partial<FlowInput> & { shots?: FlowStoryboardShot[] } = {}): FlowInput {
  const shots = overrides.shots ?? Array.from({ length: 9 }, (_, i) => sbShot(i, "pending", false));
  return {
    storyline: { id: "sl", status: "estimated", budgetCapCents: null, spentCents: 0, estimatedTotalCents: 1000, finalObjectKey: null },
    shotCount: shots.length,
    pendingSuggestions: 0,
    storyboard: { shots, allApproved: false, videoEstimatedTotalCents: 1000, approvalThresholdCents: null },
    progress: null,
    ...overrides,
  };
}

describe("step status (pure)", () => {
  it("the owner's case: 9 shots with accepted AI suggestions but no pictures opens on Pictures, 0 of 9 approved", () => {
    const input = flow();
    const steps = computeSteps(input);
    expect(steps.map((s) => s.status)).toEqual(["9 shots", "0 of 9 pictures approved", "2 things to sort out first", "Not started"]);
    expect(steps[0]!.state).toBe("done");
    expect(suggestedStep(input)).toBe("pictures");
  });

  it("counts pictures: approved with and without a picture, waiting, missing, left out", () => {
    const shots = [sbShot(0, "approved", true), sbShot(1, "approved", false), sbShot(2, "pending", true), sbShot(3, "pending", false), sbShot(4, "dropped", false)];
    const counts = pictureCounts({ shots, allApproved: false, videoEstimatedTotalCents: null, approvalThresholdCents: null });
    expect(counts).toMatchObject({ total: 4, approved: 2, approvedWithPicture: 1, approvedWithoutPicture: 1, waiting: 1, missing: 1, dropped: 1, waitingIds: ["sh-2"], missingIds: ["sh-3"] });
    expect(computeSteps(flow({ shots }))[1]!.status).toBe("2 of 4 pictures approved (1 left out)");
  });

  it("pending AI suggestions send the person to the script and show on the step", () => {
    const input = flow({ pendingSuggestions: 2 });
    expect(computeSteps(input)[0]).toMatchObject({ status: "9 shots, 2 AI suggestions waiting", state: "attention" });
    expect(suggestedStep(input)).toBe("script");
  });

  it("ready, rendering, combining and done", () => {
    const approved = Array.from({ length: 9 }, (_, i) => sbShot(i, "approved", true));
    const ready = flow({ shots: approved, storyline: { id: "sl", status: "estimated", budgetCapCents: 2000, spentCents: 0, estimatedTotalCents: 1000, finalObjectKey: null } });
    expect(computeSteps(ready)[2]).toMatchObject({ status: "Ready to render", state: "ready" });
    expect(suggestedStep(ready)).toBe("render");

    const rendering = { ...ready, storyline: { ...ready.storyline, status: "rendering" }, progress: { totalShots: 9, doneShots: 2, failedShots: 0, renderingShots: 1 } };
    expect(computeSteps(rendering)[3]!.status).toBe("Rendering 3 of 9");
    expect(computeSteps(rendering)[2]!.status).toBe("Render started");
    expect(suggestedStep(rendering)).toBe("film");
    expect(computeSteps({ ...rendering, storyline: { ...rendering.storyline, status: "stitching" } })[3]!.status).toBe("Combining clips");
    expect(computeSteps({ ...rendering, storyline: { ...rendering.storyline, status: "done" } })[3]).toMatchObject({ status: "Film ready", state: "done" });
  });
});

describe("readiness checklist (pure)", () => {
  it("lists exactly what is missing, with one-click fixes", () => {
    const shots = [sbShot(0, "approved", true), sbShot(1, "pending", true), sbShot(2, "pending", false), sbShot(3, "pending", false)];
    const { ready, items } = renderReadiness(flow({ shots }));
    expect(ready).toBe(false);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["pictures-missing"]!.text).toBe("2 shots have no approved picture yet.");
    expect(byId["pictures-missing"]!.fixes.map((f) => f.label)).toEqual(["Make them (about $0.04)", "Skip pictures for these"]);
    expect(byId["pictures-missing"]!.fixes[1]).toMatchObject({ kind: "skip-pictures", shotIds: ["sh-2", "sh-3"] });
    expect(byId["pictures-waiting"]!.fixes[0]).toMatchObject({ kind: "approve-pictures", shotIds: ["sh-1"], label: "Approve it" });
    // $10.00 estimate + 20% = $12.00.
    expect(byId["no-budget"]!.fixes[0]).toMatchObject({ kind: "set-budget", cents: 1200, label: "Set budget to $12.00 (estimate + 20%)" });
  });

  it("is ready when every shot is approved or left out and the budget covers the estimate", () => {
    const shots = [sbShot(0, "approved", false), sbShot(1, "dropped", false)];
    const input = flow({ shots, storyline: { id: "sl", status: "draft", budgetCapCents: 1000, spentCents: 0, estimatedTotalCents: 1000, finalObjectKey: null } });
    expect(renderReadiness(input)).toEqual({ ready: true, items: [] });
  });

  it("flags a budget below the estimate and keeps AI suggestions as a non-blocking note", () => {
    const shots = [sbShot(0, "approved", true)];
    const input = flow({ shots, pendingSuggestions: 1, storyline: { id: "sl", status: "draft", budgetCapCents: 500, spentCents: 0, estimatedTotalCents: 1000, finalObjectKey: null } });
    const { ready, items } = renderReadiness(input);
    expect(ready).toBe(false);
    expect(items.find((i) => i.id === "budget-too-low")!.fixes[0]).toMatchObject({ kind: "set-budget", cents: 1200 });
    expect(items.find((i) => i.id === "suggestions")).toMatchObject({ blocking: false });
  });

  it("rounds the suggested budget up to whole dollars", () => {
    expect(suggestedBudgetCents(1001)).toBe(1300);
    expect(suggestedBudgetCents(null)).toBeNull();
  });
});

describe("server refusals map to the same fixes", () => {
  it("unapproved picture -> make / skip", () => {
    const item = refusalToItem(
      "Shot 1's storyboard still has not been approved yet. Approve every shot's still before starting the render (or drop shots you don't want to render).",
      flow({ shots: [sbShot(0, "pending", false), sbShot(1, "pending", false)] }),
    )!;
    expect(item.text).toBe("Shot 1 has no approved picture yet, so the render was not started.");
    expect(item.fixes.map((f) => f.kind)).toEqual(["make-pictures", "skip-pictures"]);
  });

  it("over the budget cap -> raise to the amount the server names", () => {
    const item = refusalToItem(
      "This render is estimated at $10.00, and $3.00 is already spent -- together that is over the budget cap of $12.00. Raise the budget cap to at least $13.00 to go ahead.",
      flow(),
    )!;
    expect(item.fixes).toEqual([{ kind: "set-budget", cents: 1300, label: "Raise budget to $13.00" }]);
  });

  it("no budget, no shots, missing key, stale state, and the owner's go-ahead", () => {
    expect(refusalToItem("Set a budget cap before starting a render, so spending stops at a limit you chose. This render is estimated at $10.00.", flow())!.fixes[0]).toMatchObject({ kind: "set-budget", cents: 1200 });
    expect(refusalToItem("Add at least one shot before starting a render.", flow())!.fixes[0]).toMatchObject({ kind: "go", step: "script" });
    expect(refusalToItem("No Fal.ai API key is configured in Media Studio settings yet.", flow())!.text).toContain("Ask an admin");
    expect(refusalToItem("This storyline is already rendering.", flow())!.fixes[0]).toMatchObject({ kind: "refresh" });
    expect(refusalToItem("This render's estimated cost (900 cents) is over this company's 500-cent approval threshold. Waiting on a board decision before it can start.", flow())).toBeNull();
  });
});

// ─── The page, with a stubbed server ───────────────────────────────────────

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SL = "sl-1";
const BASE = `/api/companies/${COMPANY}/video-storylines`;
const IDS = ["sh-1", "sh-2", "sh-3"];

type ShotState = { status: "pending" | "approved" | "dropped"; still: boolean; proposal: string | null };
let state: Record<string, ShotState>;
let budget: number | null;
let startReply: { status: number; body: string };
let calls: Array<{ path: string; method: string; body?: string }>;
const lookAction = vi.fn(async () => ({ looks: [] }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function summary() {
  const shots = IDS.map((id, i) => ({
    id,
    orderIndex: i,
    storyboardStatus: state[id]!.status,
    stillObjectKey: state[id]!.still ? `k-${id}` : null,
    stillContentType: null,
    stillByteSize: null,
    stillGeneratedAt: null,
    stillEstimatedCostCents: state[id]!.still ? 2 : null,
    stillActualCostCents: null,
  }));
  const live = shots.filter((s) => s.storyboardStatus !== "dropped");
  return { storylineId: SL, providerId: "fal", shots, stillTotalCents: 0, allApproved: live.length > 0 && live.every((s) => s.storyboardStatus === "approved"), videoEstimatedTotalCents: 1500, videoSpentCents: 0, approvalThresholdCents: null };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body as string | undefined;
      calls.push({ path, method, body });
      if (path === `${BASE}/settings`) return json({ enabled: true });
      if (path === `${BASE}/settings/advanced`) return json({ enabled: true });
      if (path === BASE) {
        return json([{ id: SL, companyId: COMPANY, projectId: null, title: "Nine shots", status: "estimated", providerId: "fal", model: null, budgetCapCents: budget, spentCents: 0, estimatedTotalCents: 1500, estimatedTotalSeconds: 15, characterReferenceAssetIds: [], finalObjectKey: null, finalByteSize: null, finalDurationSeconds: null, stitchBlockedReason: null, errorMessage: null, createdAt: "", updatedAt: "" }]);
      }
      if (path === `${BASE}/${SL}` && method === "PATCH") {
        budget = JSON.parse(body!).budgetCapCents;
        return json({});
      }
      if (path === `${BASE}/${SL}/scenes`) return json([{ id: "sc-1", storylineId: SL, orderIndex: 0, title: "Opening", notes: null, createdAt: "" }]);
      if (path === `${BASE}/${SL}/shots` && method === "GET") {
        return json(
          IDS.map((id, i) => ({
            id, storylineId: SL, sceneId: "sc-1", orderIndex: i, prompt: `Prompt ${i + 1}`, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], status: "draft",
            providerId: null, model: null, resultObjectKey: null, resultByteSize: null, estimatedCostCents: null, actualCostCents: null, attempt: 0, errorMessage: null, createdAt: "",
            proposalStatus: state[id]!.proposal, proposedPrompt: state[id]!.proposal === "pending" ? `Better prompt ${i + 1}` : null,
          })),
        );
      }
      if (path === `${BASE}/${SL}/progress`) return json(null);
      if (path === `${BASE}/${SL}/storyboard`) return json(summary());
      if (path === `${BASE}/${SL}/director/conversation`) return json(null);
      const m = path.match(/\/shots\/(sh-\d)\/(still|approve|drop)$/);
      if (m && method === "POST") {
        const [, id, what] = m;
        if (what === "still") state[id!] = { ...state[id!]!, status: "pending", still: true };
        if (what === "approve") state[id!] = { ...state[id!]!, status: "approved" };
        if (what === "drop") state[id!] = { ...state[id!]!, status: "dropped" };
        return json({});
      }
      if (path === `${BASE}/${SL}/render/start`) return new Response(startReply.body, { status: startReply.status });
      return json({});
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

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`No element ${id}`);
  return el as HTMLElement;
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

describe("guided flow on the page", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount() {
    installFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(null, "", "/media-studio?tab=storylines");
    root = createRoot(container);
    await act(async () => {
      root.render(<MediaStudioPage context={{ companyId: COMPANY } as never} />);
    });
    await flush();
    await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Nine shots"))!);
  }

  beforeEach(() => {
    // The owner's case: the AI director's suggestions were accepted, but no picture exists yet.
    state = Object.fromEntries(IDS.map((id) => [id, { status: "pending", still: false, proposal: "accepted" }]));
    budget = 2000;
    startReply = { status: 200, body: "{}" };
    calls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginAction: () => lookAction,
        useHostNavigation: () => ({ navigate: vi.fn(), linkProps: (to: string) => ({ href: to }) }),
      },
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepted AI suggestions do not count as approved pictures: it opens on Pictures with 0 of 3", async () => {
    await mount();
    expect(byTestId(container, "step-bar").querySelector('[aria-current="step"]')?.getAttribute("data-testid")).toBe("step-pictures");
    expect(byTestId(container, "step-pictures-status").textContent).toBe("0 of 3 pictures approved");
    expect(byTestId(container, "step-script-status").textContent).toBe("3 shots");
    expect(container.querySelector('[data-testid="suggestions-banner"]')).toBeNull();
  });

  it("makes all missing pictures one by one after showing the cost, then approves them all", async () => {
    await mount();
    await click(byTestId(container, "pictures-primary-make"));
    const confirm = byTestId(container, "make-pictures-confirm");
    expect(confirm.textContent).toContain("about $0.06 in all");
    // Nothing is made (or paid for) until the person confirms.
    expect(calls.filter((c) => c.path.endsWith("/still") && c.method === "POST")).toHaveLength(0);
    await click(button(confirm, "Make 3 pictures (about $0.06)"));
    const stillPosts = calls.filter((c) => c.path.endsWith("/still") && c.method === "POST").map((c) => c.path.split("/").at(-2));
    expect(stillPosts).toEqual(IDS);
    expect(byTestId(container, "step-pictures-status").textContent).toBe("0 of 3 pictures approved");

    expect(byTestId(container, "pictures-primary-approve").textContent).toBe("Approve all 3 pictures");
    await click(byTestId(container, "pictures-primary-approve"));
    const approvePosts = calls.filter((c) => c.path.endsWith("/approve"));
    expect(approvePosts).toHaveLength(3);
    expect(approvePosts.every((c) => JSON.parse(c.body!).withoutStill === undefined)).toBe(true);
    expect(byTestId(container, "step-pictures-status").textContent).toBe("3 of 3 pictures approved");
    expect(byTestId(container, "pictures-primary-next").textContent).toBe("Next: Budget & render");
  });

  it("skips pictures for all remaining shots after explaining the trade-off", async () => {
    await mount();
    await click(button(byTestId(container, "pictures-other-options"), "Skip pictures for all 3 remaining shots"));
    const explain = byTestId(container, "skip-pictures-confirm");
    expect(explain.textContent).toContain("starts from the last frame of the previous clip");
    expect(explain.textContent).toContain("character picture");
    await click(button(explain, "Skip pictures for 3 shots"));
    const approvePosts = calls.filter((c) => c.path.endsWith("/approve"));
    expect(approvePosts.map((c) => JSON.parse(c.body!))).toEqual([{ withoutStill: true }, { withoutStill: true }, { withoutStill: true }]);
    expect(calls.some((c) => c.path.endsWith("/still") && c.method === "POST")).toBe(false);
    expect(byTestId(container, "storyboard-tile-sh-1").textContent).toContain("Approved without picture");
  });

  it("step 3 fixes: 'Skip pictures for these' and 'Make them' work in one click", async () => {
    state["sh-1"] = { status: "approved", still: true, proposal: null };
    await mount();
    await click(byTestId(container, "step-render"));
    expect((byTestId(container, "start-render") as HTMLButtonElement).disabled).toBe(true);
    const missing = byTestId(container, "readiness-pictures-missing");
    expect(missing.textContent).toContain("2 shots have no approved picture yet");
    expect(byTestId(container, "skip-explanation").textContent).toContain("previous clip");
    await click(button(missing, "Make them (about $0.04)"));
    expect(calls.filter((c) => c.path.endsWith("/still") && c.method === "POST").map((c) => c.path.split("/").at(-2))).toEqual(["sh-2", "sh-3"]);
    const waiting = byTestId(container, "readiness-pictures-waiting");
    await click(button(waiting, "Approve all 2"));
    expect(container.querySelector('[data-testid="readiness-ready"]')).toBeTruthy();
    expect((byTestId(container, "start-render") as HTMLButtonElement).disabled).toBe(false);
  });

  it("maps the server's refusal to the matching one-click fix", async () => {
    IDS.forEach((id) => (state[id] = { status: "approved", still: true, proposal: null }));
    await mount();
    expect(byTestId(container, "step-bar").querySelector('[aria-current="step"]')?.getAttribute("data-testid")).toBe("step-render");
    startReply = {
      status: 422,
      body: JSON.stringify({ error: "This render is estimated at $15.00, and $0.00 is already spent -- together that is over the budget cap of $10.00. Raise the budget cap to at least $15.00 to go ahead." }),
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(byTestId(container, "start-render"));
    expect(byTestId(container, "render-refused")).toBeTruthy();
    await click(button(byTestId(container, "readiness-refusal-budget-low"), "Raise budget to $15.00"));
    const patch = calls.filter((c) => c.path === `${BASE}/${SL}` && c.method === "PATCH").at(-1);
    expect(JSON.parse(patch!.body!)).toEqual({ budgetCapCents: 1500 });
    expect(container.querySelector('[data-testid="render-refused"]')).toBeNull();
  });

  it("pending AI suggestions show a banner that leads to the script step, labelled apart from pictures", async () => {
    state["sh-2"] = { ...state["sh-2"]!, proposal: "pending" };
    await mount();
    // Suggestions waiting -> opens on step 1, where the suggestion cards are.
    expect(byTestId(container, "step-script-status").textContent).toBe("3 shots, 1 AI suggestion waiting");
    expect(container.querySelector('[data-testid="script-step"]')).toBeTruthy();
    expect(byTestId(container, "proposal-sh-2").textContent).toContain("AI suggestion");
    expect(byTestId(container, "proposal-sh-2").querySelector("button")?.textContent).toBe("Accept suggestion");

    await click(byTestId(container, "step-pictures"));
    const banner = byTestId(container, "suggestions-banner");
    expect(banner.textContent).toContain("1 AI suggestion waiting");
    expect(banner.textContent).toContain("does not approve any picture");
    // The pictures step never offers "Accept"; picture buttons say "picture".
    expect(Array.from(byTestId(container, "storyboard-panel").querySelectorAll("button")).some((b) => /suggestion/i.test(b.textContent ?? ""))).toBe(false);
    await click(button(banner, "Review suggestions"));
    expect(container.querySelector('[data-testid="script-step"]')).toBeTruthy();
  });
});
