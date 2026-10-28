// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HowWasThisMade, generationRows, type GenerationRecord } from "../../../packages/plugins/media-studio/src/ui/generation-details";

/** DUR-4902: the "How was this made?" panel on a picture and on a clip. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RECORD: GenerationRecord = {
  version: 1,
  kind: "still",
  madeAt: "2026-10-27T10:00:00.000Z",
  promptSent: "A harbour at dusk. Fully clothed.",
  negativePromptSent: "blurry",
  provider: "sogni",
  model: "z_image_turbo_bf16",
  editModel: "qwen-lightning",
  tool: "edit_image",
  loras: [{ id: "edit-ok", strength: 0.6 }],
  lorasDropped: [{ id: "z-only", reason: "Made for Z-Image, not for Qwen." }],
  contentRating: "sfw",
  contentFilterOn: true,
  providerSafety: { safe_content_filter: true },
  promptExpansion: "not supported by this tool",
  references: [{ fileId: "file-1", role: "face" }],
  referencesNotSent: 1,
  seed: "not supported by this tool",
  estimatedCostCents: 1,
  actualCostCents: 1,
  providerCredits: 12,
  notes: ["The look's seed was not used."],
};

describe("generationRows", () => {
  it("has a row for every thing the record keeps", () => {
    const labels = generationRows(RECORD).map((r) => r.label);
    expect(labels).toEqual([
      "Made", "Service", "Model", "Picture-editing model", "Tool", "Film rating", "Content filter", "Service safety settings",
      "Prompt expansion", "Seed", "LoRAs used", "LoRAs left out", "Pictures sent", "Estimated cost", "Actual cost",
    ]);
    const text = Object.fromEntries(generationRows(RECORD).map((r) => [r.label, r.value]));
    expect(text["Film rating"]).toBe("Safe for work");
    expect(text["Content filter"]).toBe("On");
    expect(text["Seed"]).toBe("not supported by this tool");
    expect(text["LoRAs left out"]).toBe("z-only: Made for Z-Image, not for Qwen.");
    expect(text["Pictures sent"]).toContain("1 could not be read");
    expect(text["Actual cost"]).toBe("$0.01 (12 Sogni credits)");
  });
});

describe("HowWasThisMade", () => {
  let container: HTMLDivElement;
  let root: Root;
  let response: unknown;
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(response), { status: 200 }));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function openPanel(kind: "still" | "clip") {
    await act(async () => {
      root.render(<HowWasThisMade base="/api/companies/c1/video-storylines/s1" shotId="sh-1" kind={kind} />);
    });
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await act(async () => {});
  }

  it("loads the record when opened and shows the prompt, the model, the LoRAs left out and the cost", async () => {
    response = { still: RECORD, clip: null };
    await openPanel("still");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/shots/sh-1/generation");
    const text = container.textContent ?? "";
    expect(text).toContain("How was this made?");
    expect(text).toContain("A harbour at dusk. Fully clothed.");
    expect(text).toContain("qwen-lightning");
    expect(text).toContain("z-only: Made for Z-Image, not for Qwen.");
    expect(text).toContain("Safe for work");
    expect(text).toContain("The look's seed was not used.");
  });

  it("says plainly when nothing was kept for a clip made before records existed", async () => {
    response = { still: RECORD, clip: null };
    await openPanel("clip");
    expect(container.textContent).toContain("No details were kept for this clip");
  });
});
