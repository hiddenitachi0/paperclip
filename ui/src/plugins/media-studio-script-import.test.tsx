// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";
import { ScriptImportDialog, ScriptInstructionsDialog, parseScriptText } from "../../../packages/plugins/media-studio/src/ui/script-import";
import { friendlyStorylineError } from "../../../packages/plugins/media-studio/src/ui/storyline-api";

/**
 * Movie generator editor: JSON script import, the script-writer
 * instructions, plain-English errors and the "set a budget first" flow.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const BASE = `/api/companies/${COMPANY}/video-storylines`;

let calls: Array<{ path: string; method: string; body?: string }>;
const lookAction = vi.fn(async () => ({ looks: [] }));
let routes: (path: string, method: string, body?: string) => Response | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body as string | undefined });
      return routes(path, method, init?.body as string | undefined) ?? json({});
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

describe("friendlyStorylineError", () => {
  it("never shows a bare 'Internal server error'", () => {
    const err = friendlyStorylineError(500, JSON.stringify({ error: "Internal server error" }), "adding the shot");
    expect(err.message).toContain("Something went wrong on the server while adding the shot");
    expect(err.message).not.toContain("Internal server error");
  });

  it("keeps the server's own plain message and the per-item script problems", () => {
    const err = friendlyStorylineError(422, JSON.stringify({ error: "The script has 2 problems. First: Scene 1: x", details: { errors: ["Scene 1: x", "Scene 2, shot 3: y"] } }));
    expect(err.message).toContain("The script has 2 problems");
    expect(err.problems).toEqual(["Scene 1: x", "Scene 2, shot 3: y"]);
  });

  it("turns schema errors into field names", () => {
    const err = friendlyStorylineError(400, JSON.stringify({ error: "Validation error", details: [{ path: ["durationSeconds"], message: "Number must be less than or equal to 60" }] }));
    expect(err.message).toBe("Please check: Length (seconds): Number must be less than or equal to 60");
  });

  it("explains a too-big upload", () => {
    expect(friendlyStorylineError(413, "<html>too large</html>").message).toContain("too much to send");
  });
});

describe("parseScriptText", () => {
  it("accepts JSON wrapped in a markdown fence and points at syntax errors", () => {
    expect(parseScriptText('```json\n{"scenes": []}\n```')).toEqual({ ok: true, value: { scenes: [] } });
    const bad = parseScriptText('{\n  "scenes": [\n    {"scene_title": "a",}\n  ]\n}');
    expect(bad.ok).toBe(false);
  });
});

describe("script import and instructions dialogs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    calls = [];
    installFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("checks the script with a dry run, shows the preview, then imports", async () => {
    routes = (path, method, body) => {
      if (path === `${BASE}/sl-1/import` && method === "POST") {
        const dryRun = JSON.parse(body ?? "{}").dryRun === true;
        return json({ dryRun, mode: "append", storylineId: "sl-1", sceneCount: 2, shotCount: 3, totalSeconds: 17, billedSeconds: 25, estimatedCostCents: 1250, characterCount: 1 });
      }
      return null;
    };
    const onImported = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<ScriptImportDialog companyId={COMPANY} storylineId="sl-1" onImported={onImported} onClose={onClose} />);
    });
    expect(button(container, "Import").disabled).toBe(true);

    await type(container.querySelector('textarea[aria-label="Script JSON"]')!, "{not json");
    await click(button(container, "Check script"));
    expect(container.textContent).toContain("This is not valid JSON");
    expect(calls).toHaveLength(0);

    await type(container.querySelector('textarea[aria-label="Script JSON"]')!, '{"scenes":[{"scene_title":"a","shots":[{"prompt":"b"}]}]}');
    await click(button(container, "Check script"));
    const preview = container.querySelector('[data-testid="script-import-preview"]')?.textContent ?? "";
    expect(preview).toContain("2 scenes, 3 shots, 17 seconds of video");
    expect(preview).toContain("rendered as 25 seconds");
    expect(preview).toContain("$12.50");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ mode: "append", dryRun: true });

    await click(button(container, "Import"));
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ mode: "append", dryRun: false });
    expect(onImported).toHaveBeenCalledWith("sl-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("lists every problem the server found in the script", async () => {
    routes = (path) =>
      path.endsWith("/import")
        ? json({ error: "The script has 2 problems. First: Scene 1, shot 1: prompt is missing or empty.", details: { errors: ["Scene 1, shot 1: prompt is missing or empty.", "Scene 2: scene_title is missing."] } }, 422)
        : null;
    await act(async () => {
      root.render(<ScriptImportDialog companyId={COMPANY} storylineId={null} onImported={vi.fn()} onClose={vi.fn()} />);
    });
    await type(container.querySelector('input[aria-label="Storyline title"]')!, "My film");
    await type(container.querySelector('textarea[aria-label="Script JSON"]')!, '{"scenes":[{"shots":[{}]}]}');
    await click(button(container, "Check script"));
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("- Scene 2: scene_title is missing.");
    expect(calls[0]!.path).toBe(`${BASE}/import`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ title: "My film", providerId: "fal", dryRun: true });
  });

  it("shows the shared writer instructions with copy and download", async () => {
    routes = (path) => (path === `${BASE}/script-instructions` ? json({ markdown: "# Instructions\nReturn **JSON only**" }) : null);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => {
      root.render(<ScriptInstructionsDialog companyId={COMPANY} onClose={vi.fn()} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="script-instructions-text"]')?.textContent).toContain("Return **JSON only**");
    await click(button(container, "Copy instructions"));
    expect(writeText).toHaveBeenCalledWith("# Instructions\nReturn **JSON only**");
    expect(button(container, "Download as .md").disabled).toBe(false);
  });
});

describe("Step 3 offers a one-click budget instead of a dead button", () => {
  let container: HTMLDivElement;
  let root: Root;

  let budget: number | null;
  beforeEach(async () => {
    calls = [];
    budget = null;
    routes = (path, method, body) => {
      if (path === `${BASE}/sl-1` && method === "PATCH") {
        budget = JSON.parse(body!).budgetCapCents;
        return json({});
      }
      if (path === `${BASE}/settings`) return json({ enabled: true });
      if (path === `${BASE}/settings/advanced`) return json({ enabled: false });
      if (path === BASE) {
        return json([
          { id: "sl-1", companyId: COMPANY, projectId: null, title: "Test film", status: "estimated", providerId: "fal", model: null, budgetCapCents: budget, spentCents: 0, estimatedTotalCents: 1000, estimatedTotalSeconds: 20, characterReferenceAssetIds: [], finalObjectKey: null, finalByteSize: null, finalDurationSeconds: null, stitchBlockedReason: null, errorMessage: null, createdAt: "", updatedAt: "" },
        ]);
      }
      if (path === `${BASE}/sl-1/scenes`) return json([{ id: "sc-1", storylineId: "sl-1", orderIndex: 0, title: "Opening", notes: null, createdAt: "" }]);
      if (path === `${BASE}/sl-1/shots` && method === "GET") {
        return json([{ id: "sh-1", storylineId: "sl-1", sceneId: "sc-1", orderIndex: 0, prompt: "Prompt", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], status: "draft", providerId: null, model: null, resultObjectKey: null, resultByteSize: null, estimatedCostCents: null, actualCostCents: null, attempt: 0, errorMessage: null, createdAt: "" }]);
      }
      if (path === `${BASE}/sl-1/progress`) return json(null);
      if (path === `${BASE}/sl-1/storyboard`) {
        return json({ storylineId: "sl-1", providerId: "fal", shots: [{ id: "sh-1", orderIndex: 0, storyboardStatus: "approved", stillObjectKey: null, stillContentType: null, stillByteSize: null, stillGeneratedAt: null, stillEstimatedCostCents: null, stillActualCostCents: null }], stillTotalCents: 0, allApproved: true, videoEstimatedTotalCents: 1000, videoSpentCents: 0, approvalThresholdCents: null });
      }
      if (path === `${BASE}/sl-1/render/start`) return json({});
      return null;
    };
    installFetch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__paperclipPluginBridge__ = {
      sdkUi: {
        // Must be a stable function: the page re-loads Looks whenever it changes.
        usePluginAction: () => lookAction,
        useHostNavigation: () => ({ navigate: vi.fn(), linkProps: (to: string) => ({ href: to }) }),
      },
    };
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

  it("lists the missing budget with a suggested amount, sets it in one click, then starts", async () => {
    // Everything else is ready, so the guided flow opens step 3 straight away.
    expect(container.querySelector('[data-testid="render-step"]')).toBeTruthy();
    const start = container.querySelector('[data-testid="start-render"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(container.querySelector('[data-testid="readiness-no-budget"]')?.textContent).toContain("No budget set");
    // Suggests the estimate plus a 20% margin, rounded up to whole dollars.
    await click(button(container, "Set budget to $12.00 (estimate + 20%)"));
    const patch = calls.find((c) => c.path === `${BASE}/sl-1` && c.method === "PATCH");
    expect(JSON.parse(patch!.body!)).toEqual({ budgetCapCents: 1200 });
    expect(container.querySelector('[data-testid="readiness-ready"]')).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(container.querySelector('[data-testid="start-render"]') as HTMLButtonElement);
    const startCall = calls.find((c) => c.path === `${BASE}/sl-1/render/start`);
    expect(JSON.parse(startCall!.body!)).toEqual({});
    // Once started, the page moves on to step 4.
    expect(container.querySelector('[data-testid="film-panel"]')).toBeTruthy();
  });

  it("offers script import and the writer instructions on the editor and the list", async () => {
    await click(container.querySelector('[data-testid="step-script"]') as HTMLButtonElement);
    expect(button(container, "Import script (JSON)")).toBeTruthy();
    expect(button(container, "New from script (JSON)")).toBeTruthy();
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    await click(button(container, "Import script (JSON)"));
    expect(container.querySelector('[data-testid="script-import-dialog"]')).toBeTruthy();
  });
});
