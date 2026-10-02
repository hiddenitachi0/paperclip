// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStudioPage } from "../../../packages/plugins/media-studio/src/ui/index";

/**
 * DUR-4330: the Create tab's direct-generation UI (make a picture/video/audio
 * without an agent). Covers the UI states called out in the issue: idle,
 * cost-shown, generating, done, and error -- stubbed through the plugin UI
 * bridge like media-studio-page.test.tsx.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";

const actions: Record<string, ReturnType<typeof vi.fn>> = {};
const navigate = vi.fn();

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn(async () => ({}))),
      useHostNavigation: () => ({
        navigate,
        linkProps: (to: string) => ({ href: to }),
      }),
    },
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Media Studio Create tab direct generation (DUR-4330)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let pictureDeferred: ReturnType<typeof deferred<Response>>;

  beforeEach(() => {
    for (const key of Object.keys(actions)) delete actions[key];
    navigate.mockReset();
    actions["looks.list"] = vi.fn(async () => ({ looks: [], canManage: true, maxReferenceFiles: 4 }));
    installBridge();

    pictureDeferred = deferred<Response>();
    fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (typeof path === "string" && path.includes("/media-studio/direct/estimate")) {
        return new Response(JSON.stringify({ kind: "picture", provider: "fal", estimatedCostCents: 8 }), { status: 200 });
      }
      if (typeof path === "string" && path.includes("/media-studio/direct/history")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (typeof path === "string" && path.endsWith("/media-studio/direct/picture") && init?.method === "POST") {
        return pictureDeferred.promise;
      }
      return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(null, "", "/media-studio");
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderCreateTab() {
    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY, userId: null } as never} />);
  }

  function promptField(): HTMLTextAreaElement {
    return container.querySelector("textarea")!;
  }

  /** Lets React detect a DOM value change on a controlled textarea (see React #10140). */
  function setPrompt(value: string) {
    const textarea = promptField();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    const previous = textarea.value;
    valueSetter?.call(textarea, value);
    const tracker = (textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
    tracker?.setValue(previous);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function makeButton(): HTMLButtonElement {
    return [...container.querySelectorAll("button")].find((b) => b.textContent === "Make picture" || b.textContent === "Making…")! as HTMLButtonElement;
  }

  it("idle: shows the prompt box and the make button with nothing generated yet", async () => {
    renderCreateTab();
    await flush();

    expect(promptField()).toBeTruthy();
    expect(makeButton().textContent).toBe("Make picture");
    expect(makeButton().disabled).toBe(false);
    expect(container.textContent).toContain("Nothing made yet.");
  });

  it("cost-shown: fetches and displays the estimate before anything is made", async () => {
    renderCreateTab();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/media-studio/direct/estimate"), expect.anything());
    expect(container.textContent).toContain("Expected cost:");
    expect(container.textContent).toContain("$0.08");
  });

  it("generating: disables the button and shows a busy label while the request is in flight", async () => {
    renderCreateTab();
    await flush();

    setPrompt("a red bicycle");
    await flush();

    makeButton().click();
    await flush();

    expect(makeButton().textContent).toBe("Making…");
    expect(makeButton().disabled).toBe(true);
  });

  it("done: shows the result, its cost, and the result actions once generation succeeds", async () => {
    renderCreateTab();
    await flush();

    setPrompt("a red bicycle");
    await flush();

    makeButton().click();
    await flush();

    pictureDeferred.resolve(
      new Response(
        JSON.stringify({
          fileId: "11111111-1111-4111-8111-222222222222",
          contentPath: "/api/attachments/11111111-1111-4111-8111-222222222222/content",
          downloadPath: "/api/attachments/11111111-1111-4111-8111-222222222222/content?download=1",
          contentType: "image/png",
          costCents: 8,
          provider: "fal",
          model: "fal-ai/flux/dev",
        }),
        { status: 201 },
      ),
    );
    await flush();

    expect(makeButton().textContent).toBe("Make picture");
    expect(container.textContent).toContain("Made 1 picture");
    expect(container.textContent).toContain("Saved to your company files");
    const img = container.querySelector("img[alt='Generated']") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("/api/attachments/11111111-1111-4111-8111-222222222222/content");
    const download = [...container.querySelectorAll("a")].find((a) => a.textContent === "Download");
    expect(download?.getAttribute("href")).toBe("/api/attachments/11111111-1111-4111-8111-222222222222/content?download=1");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Edit")).toBe(true);
  });

  it("error: shows a plain-language message when the budget gate rejects the request", async () => {
    renderCreateTab();
    await flush();

    setPrompt("a red bicycle");
    await flush();

    makeButton().click();
    await flush();

    pictureDeferred.resolve(
      new Response(
        JSON.stringify({
          error: "This would go over budget",
          details: { reason: "company_budget", spentMonthlyCents: 10000, budgetMonthlyCents: 10000 },
        }),
        { status: 422 },
      ),
    );
    await flush();

    expect(makeButton().textContent).toBe("Make picture");
    expect(container.textContent).toContain("company's monthly budget");
  });

  it("viewer read-only: hides the spend controls and explains why", async () => {
    actions["looks.list"] = vi.fn(async () => ({ looks: [], canManage: false, maxReferenceFiles: 4 }));
    fetchMock.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.includes("/cli-auth/me")) {
        return new Response(
          JSON.stringify({ userId: "viewer-1", isInstanceAdmin: false, memberships: [{ companyId: COMPANY, membershipRole: "viewer", status: "active" }] }),
          { status: 200 },
        );
      }
      if (typeof path === "string" && path.includes("/media-studio/direct/history")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
    });

    root = createRoot(container);
    root.render(<MediaStudioPage context={{ companyId: COMPANY, userId: "viewer-1" } as never} />);
    await flush();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Only the company's owner, admins, and operators can make");
  });
});
