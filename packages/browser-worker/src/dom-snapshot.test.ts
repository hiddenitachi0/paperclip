import { describe, expect, it } from "vitest";
import { DomSnapshotter, SNAPSHOT_TREE_BYTE_CAP, treeToPlainText } from "./dom-snapshot.js";
import { createFakeFrame, createFakePage } from "./test-support/fake-playwright.js";
import type { Page } from "playwright-core";

function asPage(page: ReturnType<typeof createFakePage>): Page {
  return page as unknown as Page;
}

describe("DomSnapshotter.capture", () => {
  it("stitches multiple frames' trees together and offsets ref numbering across them", async () => {
    const frame0 = createFakeFrame({
      evaluateResults: [
        {
          kind: "snapshot",
          tree: '[ref=e0] link "Home"',
          elements: [{ ref: "e0", role: "link", autocomplete: null, name: null, id: null, type: null, placeholder: null, label: null, isFormSubmit: false, formFieldSignals: [] }],
          nextIndex: 1,
        },
      ],
    });
    const frame1 = createFakeFrame({
      evaluateResults: [
        {
          kind: "snapshot",
          tree: '[ref=e1] button "Pay"',
          elements: [{ ref: "e1", role: "button", autocomplete: null, name: null, id: null, type: null, placeholder: null, label: null, isFormSubmit: true, formFieldSignals: [] }],
          nextIndex: 2,
        },
      ],
    });
    const page = createFakePage({ frames: [frame0, frame1], url: "https://shop.example/checkout" });

    const snapshotter = new DomSnapshotter();
    const result = await snapshotter.capture(asPage(page));

    expect(result.tree).toBe('[ref=e0] link "Home"\n[ref=e1] button "Pay"');
    expect(result.url).toBe("https://shop.example/checkout");
    // Second frame's evaluate call must have received startIndex 1 (continuing from frame0's nextIndex).
    expect(frame1.evaluate).toHaveBeenCalledWith(expect.any(Function), { kind: "snapshot", startIndex: 1, refAttribute: "data-pc-ref" });
  });

  it("skips a frame whose evaluate throws (e.g. mid-navigation) instead of failing the whole snapshot", async () => {
    const okFrame = createFakeFrame({
      evaluateResults: [{ kind: "snapshot", tree: '[ref=e0] link "Home"', elements: [], nextIndex: 1 }],
    });
    const throwingFrame = createFakeFrame();
    throwingFrame.evaluate.mockRejectedValueOnce(new Error("detached"));
    const page = createFakePage({ frames: [okFrame, throwingFrame] });

    const snapshotter = new DomSnapshotter();
    const result = await snapshotter.capture(asPage(page));

    expect(result.tree).toBe('[ref=e0] link "Home"');
  });

  it("caps the tree at SNAPSHOT_TREE_BYTE_CAP bytes with a truncation marker", async () => {
    const hugeLine = "x".repeat(SNAPSHOT_TREE_BYTE_CAP * 2);
    const frame = createFakeFrame({
      evaluateResults: [{ kind: "snapshot", tree: hugeLine, elements: [], nextIndex: 0 }],
    });
    const page = createFakePage({ frames: [frame] });

    const snapshotter = new DomSnapshotter();
    const result = await snapshotter.capture(asPage(page));

    expect(Buffer.byteLength(result.tree, "utf8")).toBeLessThanOrEqual(SNAPSHOT_TREE_BYTE_CAP + 100);
    expect(result.tree).toContain("truncated");
  });

  it("computes formHasPaymentField from the real looksLikePaymentField, not a duplicated heuristic", async () => {
    const paymentElementInfo = {
      ref: "e0",
      role: "button",
      autocomplete: null,
      name: null,
      id: null,
      type: null,
      placeholder: null,
      label: null,
      isFormSubmit: true,
      formFieldSignals: [{ autocomplete: "cc-number", name: null, id: null, type: null, placeholder: null, label: null }],
    };
    const frame = createFakeFrame({
      evaluateResults: [
        { kind: "snapshot", tree: '[ref=e0] button "Next"', elements: [paymentElementInfo], nextIndex: 1 },
        { kind: "describe", element: paymentElementInfo },
      ],
    });
    const page = createFakePage({ frames: [frame] });
    const snapshotter = new DomSnapshotter();
    await snapshotter.capture(asPage(page));

    const descriptor = await snapshotter.describeElement("e0");
    expect(descriptor?.formHasPaymentField).toBe(true);
  });
});

describe("DomSnapshotter.describeElement / locatorFor", () => {
  it("returns null for a ref from before the last snapshot (stale ref)", async () => {
    const snapshotter = new DomSnapshotter();
    expect(await snapshotter.describeElement("e0")).toBeNull();
    expect(snapshotter.locatorFor("e0")).toBeNull();
  });

  it("resolves a tracked ref to a locator scoped to its own frame", async () => {
    const frame = createFakeFrame({
      evaluateResults: [{ kind: "snapshot", tree: '[ref=e0] textbox ""', elements: [{ ref: "e0", role: "textbox", autocomplete: null, name: null, id: null, type: null, placeholder: null, label: null, isFormSubmit: false, formFieldSignals: [] }], nextIndex: 1 }],
    });
    const page = createFakePage({ frames: [frame] });
    const snapshotter = new DomSnapshotter();
    await snapshotter.capture(asPage(page));

    const locator = snapshotter.locatorFor("e0");
    expect(locator).not.toBeNull();
    expect(frame.locator).toHaveBeenCalledWith('[data-pc-ref="e0"]');
  });
});

describe("DomSnapshotter.focusedFormSubmitTarget", () => {
  it("returns null when no frame reports a focused-form submit target", async () => {
    const frame = createFakeFrame({ evaluateResults: [{ kind: "focusedSubmitTarget", element: null, nextIndex: 0 }] });
    const page = createFakePage({ frames: [frame] });
    const snapshotter = new DomSnapshotter();
    expect(await snapshotter.focusedFormSubmitTarget(asPage(page))).toBeNull();
  });

  it("registers the returned element's ref so it can be described/located afterward", async () => {
    const frame = createFakeFrame({
      evaluateResults: [
        {
          kind: "focusedSubmitTarget",
          element: { ref: "e0", role: "button", autocomplete: null, name: null, id: null, type: null, placeholder: null, label: "Bekreft", isFormSubmit: true, formFieldSignals: [] },
          nextIndex: 1,
        },
      ],
    });
    const page = createFakePage({ frames: [frame] });
    const snapshotter = new DomSnapshotter();

    const descriptor = await snapshotter.focusedFormSubmitTarget(asPage(page));
    expect(descriptor?.ref).toBe("e0");
    expect(descriptor?.label).toBe("Bekreft");
    expect(snapshotter.locatorFor("e0")).not.toBeNull();
  });
});

describe("treeToPlainText", () => {
  it("strips [ref=...] role markup down to the quoted text", () => {
    expect(treeToPlainText('[ref=e0] link "Home"\nPlain text line')).toBe("Home\nPlain text line");
  });

  it("drops blank lines", () => {
    expect(treeToPlainText("line one\n\n  \nline two")).toBe("line one\nline two");
  });
});
