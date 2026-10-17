// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilmPanel, type FilmStoryline } from "../../../packages/plugins/media-studio/src/ui/storyline-steps";
import { filmQuality } from "../../../packages/plugins/media-studio/src/ui/storyline-flow";

/**
 * Step 5's film panel after the export fix: the automatic check's warnings
 * sit next to Download ("Download anyway") and never hide the film; a film
 * held back only by warnings can be finished in one click; a real problem
 * still says "Combine again"; a running export shows its progress.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CLIPPING = { code: "clipped_audio", message: "The audio track peaks at -0.2 dB, which indicates clipping." };
const WRONG_LENGTH = { code: "duration_mismatch", message: "The final video is 1.0s long, but the shot plan calls for about 60.0s.", severity: "blocking" };

function film(overrides: Partial<FilmStoryline>): FilmStoryline {
  return {
    id: "sl",
    title: "Test",
    status: "done",
    finalObjectKey: "k/final.mp4",
    finalByteSize: 10.9 * 1024 * 1024,
    finalDurationSeconds: 60,
    spentCents: 400,
    budgetCapCents: 1000,
    stitchBlockedReason: null,
    errorMessage: null,
    qualityCheckIssues: [],
    ...overrides,
  };
}

describe("filmQuality (pure)", () => {
  it("splits warnings from real problems, also for findings stored before severities existed", () => {
    expect(filmQuality(film({ status: "needs_attention", qualityCheckIssues: [CLIPPING] }))).toMatchObject({ warnings: [CLIPPING], problems: [], canAcceptWarnings: true });
    expect(filmQuality(film({ status: "needs_attention", qualityCheckIssues: [CLIPPING, { code: "duration_mismatch", message: "x" }] })).canAcceptWarnings).toBe(false);
    expect(filmQuality(film({ status: "needs_attention", finalObjectKey: null, qualityCheckIssues: [CLIPPING] })).canAcceptWarnings).toBe(false);
    expect(filmQuality(film({ status: "done", qualityCheckIssues: [CLIPPING] })).canAcceptWarnings).toBe(false);
  });
});

describe("FilmPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = { onRetryShot: vi.fn(), onCombineAgain: vi.fn(), onAcceptWarnings: vi.fn(), onCancel: vi.fn(), onRefresh: vi.fn() };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(handlers).forEach((h) => h.mockReset());
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(storyline: FilmStoryline) {
    act(() => {
      root.render(<FilmPanel storyline={storyline} progress={null} videoUrl="/film.mp4" busy={false} {...handlers} />);
    });
  }
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  it("a finished film with warnings: 'Download anyway' with the warnings in plain words next to it", () => {
    render(film({ status: "done", qualityCheckIssues: [{ ...CLIPPING, severity: "warning" }] }));
    expect(q("film-download")?.textContent).toBe("Download anyway (10.9 MB)");
    expect(q("film-download")?.getAttribute("href")).toBe("/film.mp4");
    expect(q("quality-warnings")?.textContent).toContain("does not stop the download");
    expect(q("quality-warnings")?.textContent).toContain("peaks at -0.2 dB");
    expect(q("quality-problems")).toBeNull();
    expect(q("film-video")).not.toBeNull();
  });

  it("a clean film: 'Download film' and the check passed", () => {
    render(film({ status: "done" }));
    expect(q("film-download")?.textContent).toBe("Download film (10.9 MB)");
    expect(q("quality-check")?.textContent).toContain("passed");
  });

  it("Filip's film (needs attention, warnings only): 'Accept warnings and finish', plus Download anyway", () => {
    render(film({ status: "needs_attention", qualityCheckIssues: [CLIPPING], errorMessage: "Automatic quality check found 1 issue(s)" }));
    expect(q("film-primary")?.textContent).toBe("Accept warnings and finish");
    act(() => (q("film-primary") as HTMLButtonElement).click());
    expect(handlers.onAcceptWarnings).toHaveBeenCalledTimes(1);
    expect(q("film-download-anyway")?.textContent).toBe("Download anyway (10.9 MB)");
    expect(q("film-combine-again")).not.toBeNull();
    expect(q("quality-warnings")?.textContent).toContain("peaks at -0.2 dB");
  });

  it("a real problem still asks to combine again, listed as a problem", () => {
    render(film({ status: "needs_attention", qualityCheckIssues: [WRONG_LENGTH, { ...CLIPPING, severity: "warning" }] }));
    expect(q("film-primary")?.textContent).toBe("Combine again");
    act(() => (q("film-primary") as HTMLButtonElement).click());
    expect(handlers.onCombineAgain).toHaveBeenCalledTimes(1);
    expect(q("quality-problems")?.textContent).toContain("shot plan calls for");
    expect(q("quality-warnings")?.textContent).toContain("peaks at");
    expect(q("film-download-anyway")?.textContent).toContain("Download this version anyway");
  });

  it("a running export shows its progress, and a failed try in plain words", () => {
    render(film({ status: "ready_to_stitch", errorMessage: "Putting the film together did not work (the video tool stopped with an error). Trying once more automatically." }));
    expect(q("film-headline")?.textContent).toContain("Exporting your film");
    expect(q("export-progress")?.textContent).toContain("Step 1 of 2");
    expect(q("film-error")?.textContent).toContain("Trying once more automatically");
    render(film({ status: "stitching" }));
    expect(q("export-progress")?.textContent).toContain("Step 2 of 2");
    expect(q("film-video")).toBeNull();
  });
});
