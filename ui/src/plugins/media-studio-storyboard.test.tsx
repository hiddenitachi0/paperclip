// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";

/**
 * DUR-4321: the storyboard (contact sheet) inside the Storylines tab --
 * approve / edit / leave out a shot's picture, cost lines, and the
 * "waiting for the owner's go-ahead" state.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SL = "sl-1";
const BASE = `/api/companies/${COMPANY}/video-storylines`;

type ShotState = { status: "pending" | "approved" | "dropped"; still: boolean };
let shotState: Record<string, ShotState>;
let threshold: number | null;
let videoEstimate: number;
let startResponse: { ok: boolean; body: string };
const lookAction = vi.fn(async () => ({ looks: [] }));
let calls: Array<{ path: string; method: string; body?: string }>;

function storyboardSummary() {
  const shots = ["sh-1", "sh-2"].map((id, i) => ({
    id,
    orderIndex: i,
    storyboardStatus: shotState[id]!.status,
    stillObjectKey: shotState[id]!.still ? `k-${id}` : null,
    stillContentType: shotState[id]!.still ? "image/jpeg" : null,
    stillByteSize: null,
    stillGeneratedAt: shotState[id]!.still ? "2026-10-03T00:00:00.000Z" : null,
    stillEstimatedCostCents: shotState[id]!.still ? 2 : null,
    stillActualCostCents: null,
  }));
  const live = shots.filter((s) => s.storyboardStatus !== "dropped");
  return {
    storylineId: SL,
    providerId: "fal",
    shots,
    stillTotalCents: live.filter((s) => s.stillObjectKey).length * 2,
    allApproved: live.length > 0 && live.every((s) => s.storyboardStatus === "approved"),
    videoEstimatedTotalCents: videoEstimate,
    videoSpentCents: 0,
    approvalThresholdCents: threshold,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body as string | undefined });
      if (path === `${BASE}/settings`) return json({ enabled: true });
      if (path === BASE) {
        return json([
          { id: SL, companyId: COMPANY, projectId: null, title: "Test film", status: "draft", providerId: "fal", model: null, budgetCapCents: 5000, spentCents: 0, estimatedTotalCents: videoEstimate, estimatedTotalSeconds: 10, characterReferenceAssetIds: [], finalObjectKey: null, finalByteSize: null, finalDurationSeconds: null, stitchBlockedReason: null, errorMessage: null, createdAt: "", updatedAt: "" },
        ]);
      }
      if (path === `${BASE}/${SL}/scenes`) return json([{ id: "sc-1", storylineId: SL, orderIndex: 0, title: "Opening", notes: null, createdAt: "" }]);
      if (path === `${BASE}/${SL}/shots` && method === "GET") {
        return json(
          ["sh-1", "sh-2"].map((id, i) => ({ id, storylineId: SL, sceneId: "sc-1", orderIndex: i, prompt: `Prompt ${i + 1}`, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], status: "draft", providerId: null, model: null, resultObjectKey: null, resultByteSize: null, estimatedCostCents: null, actualCostCents: null, attempt: 0, errorMessage: null, createdAt: "" })),
        );
      }
      if (path === `${BASE}/${SL}/progress`) return json(null);
      if (path === `${BASE}/${SL}/storyboard`) return json(storyboardSummary());
      const act2 = path.match(/\/shots\/(sh-\d)\/(still|approve|drop)$/);
      if (act2 && method === "POST") {
        const [, id, what] = act2;
        if (what === "still") shotState[id!] = { status: "pending", still: true };
        if (what === "approve") shotState[id!] = { ...shotState[id!]!, status: "approved" };
        if (what === "drop") shotState[id!] = { ...shotState[id!]!, status: "dropped" };
        return json({});
      }
      const patch = path.match(/\/shots\/(sh-\d)$/);
      if (patch && method === "PATCH") {
        shotState[patch[1]!] = { status: "pending", still: false };
        return json({});
      }
      if (path === `${BASE}/${SL}/render/start`) return new Response(startResponse.body, { status: startResponse.ok ? 200 : 422 });
      return json({});
    }),
  );
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function button(container: HTMLElement, label: string, within?: Element): HTMLButtonElement {
  const found = Array.from((within ?? container).querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

describe("Storylines storyboard (DUR-4321)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    shotState = { "sh-1": { status: "pending", still: false }, "sh-2": { status: "pending", still: true } };
    threshold = null;
    videoEstimate = 500;
    startResponse = { ok: true, body: "{}" };
    calls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginAction: () => lookAction,
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
    await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Test film"))!);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows a tile per shot with cost lines and keeps Start render off until everything is approved", async () => {
    expect(container.querySelector('[data-testid="storyboard-tile-sh-1"]')?.textContent).toContain("No picture yet");
    expect(container.querySelector('[data-testid="storyboard-tile-sh-2"]')?.textContent).toContain("Picture cost: $0.02");
    const costs = container.querySelector('[data-testid="storyboard-costs"]')?.textContent ?? "";
    expect(costs).toContain("Pictures so far: $0.02");
    expect(costs).toContain("Video will cost about $5.00");
    expect(button(container, "Start render").disabled).toBe(true);
    // Only a shot that has a picture can be approved.
    const tile1 = container.querySelector('[data-testid="storyboard-tile-sh-1"]')!;
    expect(Array.from(tile1.querySelectorAll("button")).some((b) => b.textContent === "Approve")).toBe(false);
  });

  it("make picture, approve and leave out walk the shots to ready, then Start render unlocks", async () => {
    const tile1 = () => container.querySelector('[data-testid="storyboard-tile-sh-1"]')!;
    const tile2 = () => container.querySelector('[data-testid="storyboard-tile-sh-2"]')!;
    await click(button(container, "Make picture", tile1()));
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/shots/sh-1/still"))).toBe(true);
    await click(button(container, "Approve", tile1()));
    expect(tile1().textContent).toContain("Approved");
    expect(button(container, "Start render").disabled).toBe(true);
    await click(button(container, "Leave out", tile2()));
    expect(tile2().textContent).toContain("Left out");
    expect(tile2().textContent).toContain("Not charged");
    expect(container.querySelector('[data-testid="storyboard-progress"]')?.textContent).toContain("You can start the render");
    expect(button(container, "Start render").disabled).toBe(false);
  });

  it("editing a shot clears its picture and approval, so Start render locks again", async () => {
    const tile1 = () => container.querySelector('[data-testid="storyboard-tile-sh-1"]')!;
    await click(button(container, "Make picture", tile1()));
    await click(button(container, "Approve", tile1()));
    await click(button(container, "Leave out", container.querySelector('[data-testid="storyboard-tile-sh-2"]')!));
    expect(button(container, "Start render").disabled).toBe(false);

    await click(button(container, "Edit", tile1()));
    expect(tile1().textContent).toContain("clears the current picture and approval");
    const prompt = tile1().querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(prompt, "A brand new prompt");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(container, "Save changes", tile1()));

    const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/shots/sh-1"));
    expect(JSON.parse(patch!.body!)).toEqual({ prompt: "A brand new prompt", cameraNotes: null });
    expect(tile1().textContent).toContain("Needs your OK");
    expect(tile1().textContent).toContain("No picture yet");
    expect(button(container, "Start render").disabled).toBe(true);
  });

  it("warns up front when the cost is over the approval limit", async () => {
    // Re-open with a threshold below the estimate.
    threshold = 300;
    await click(button(container, "Make a new picture", container.querySelector('[data-testid="storyboard-tile-sh-2"]')!));
    expect(container.querySelector('[data-testid="storyboard-over-limit"]')?.textContent).toContain("approval limit of $3.00");
  });

  it("explains the wait, not an error, when the owner's go-ahead is pending", async () => {
    threshold = 300;
    const tile1 = () => container.querySelector('[data-testid="storyboard-tile-sh-1"]')!;
    await click(button(container, "Make picture", tile1()));
    await click(button(container, "Approve", tile1()));
    await click(button(container, "Leave out", container.querySelector('[data-testid="storyboard-tile-sh-2"]')!));
    startResponse = { ok: false, body: "Waiting on a board decision before it can start." };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(button(container, "Start render"));
    expect(container.querySelector('[data-testid="storyboard-approval-pending"]')?.textContent).toContain("Waiting for the owner's go-ahead");
    expect(container.textContent).not.toContain("board decision");
  });
});
