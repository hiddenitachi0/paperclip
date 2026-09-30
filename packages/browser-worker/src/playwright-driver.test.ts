import { describe, expect, it } from "vitest";
import { PlaywrightBrowserDriver } from "./playwright-driver.js";
import { createFakeFrame, createFakePage } from "./test-support/fake-playwright.js";
import type { Page } from "playwright-core";

const EMPTY_SNAPSHOT_RESULT = { kind: "snapshot" as const, tree: "", elements: [], nextIndex: 0 };

function asPage(page: ReturnType<typeof createFakePage>): Page {
  return page as unknown as Page;
}

describe("PlaywrightBrowserDriver", () => {
  it("navigate() goes to the url and returns a fresh snapshot", async () => {
    const frame = createFakeFrame({ evaluateResults: [EMPTY_SNAPSHOT_RESULT] });
    const page = createFakePage({ frames: [frame], url: "https://example.com/booked" });
    const driver = new PlaywrightBrowserDriver(asPage(page));

    const snap = await driver.navigate("https://example.com/booked");

    expect(page.goto).toHaveBeenCalledWith("https://example.com/booked", expect.objectContaining({ waitUntil: "domcontentloaded" }));
    expect(snap.url).toBe("https://example.com/booked");
  });

  it("performClick throws a clear error for a ref with no locator (stale/unknown ref)", async () => {
    const page = createFakePage({ frames: [createFakeFrame({ evaluateResults: [EMPTY_SNAPSHOT_RESULT] })] });
    const driver = new PlaywrightBrowserDriver(asPage(page));
    // No snapshot() taken yet, so no ref has ever been registered.
    await expect(driver.performClick("e0")).rejects.toThrow(/Unknown element ref/);
  });

  it("performClick resolves the ref's locator and clicks it, then re-snapshots", async () => {
    const frame = createFakeFrame({
      evaluateResults: [
        { kind: "snapshot", tree: '[ref=e0] link "Details"', elements: [{ ref: "e0", role: "link", autocomplete: null, name: null, id: null, type: null, placeholder: null, label: null, isFormSubmit: false, formFieldSignals: [] }], nextIndex: 1 },
        EMPTY_SNAPSHOT_RESULT,
      ],
    });
    const page = createFakePage({ frames: [frame] });
    const driver = new PlaywrightBrowserDriver(asPage(page));

    await driver.snapshot();
    await driver.performClick("e0");

    const locator = frame.locator.mock.results[0]?.value;
    expect(locator.click).toHaveBeenCalled();
  });

  it("performType fills the resolved locator with the given text (used for both plain typing and card fills)", async () => {
    const frame = createFakeFrame({
      evaluateResults: [
        { kind: "snapshot", tree: '[ref=e0] textbox ""', elements: [{ ref: "e0", role: "textbox", autocomplete: "cc-number", name: null, id: null, type: null, placeholder: null, label: null, isFormSubmit: false, formFieldSignals: [] }], nextIndex: 1 },
        EMPTY_SNAPSHOT_RESULT,
      ],
    });
    const page = createFakePage({ frames: [frame] });
    const driver = new PlaywrightBrowserDriver(asPage(page));

    await driver.snapshot();
    await driver.performType("e0", "4242424242424242");

    const locator = frame.locator.mock.results[0]?.value;
    expect(locator.fill).toHaveBeenCalledWith("4242424242424242", expect.anything());
  });

  it("performSelect/performCheck throw on an unknown ref instead of silently no-oping", async () => {
    const page = createFakePage({ frames: [createFakeFrame({ evaluateResults: [EMPTY_SNAPSHOT_RESULT] })] });
    const driver = new PlaywrightBrowserDriver(asPage(page));
    await expect(driver.performSelect("nope", "x")).rejects.toThrow(/Unknown element ref/);
    await expect(driver.performCheck("nope", true)).rejects.toThrow(/Unknown element ref/);
  });

  it("screenshot masks every field the real looksLikePaymentField flags, and none that it doesn't", async () => {
    const cardNumberField = { ref: "e0", role: "textbox", autocomplete: "cc-number", name: null, id: null, type: null, placeholder: null, label: null, isFormSubmit: false, formFieldSignals: [] };
    const searchField = { ref: "e1", role: "textbox", autocomplete: null, name: "search", id: null, type: null, placeholder: null, label: null, isFormSubmit: false, formFieldSignals: [] };
    const frame = createFakeFrame({
      evaluateResults: [
        { kind: "snapshot", tree: "", elements: [cardNumberField, searchField], nextIndex: 2 },
        // `paymentFieldRefs()` re-describes every tracked ref (e0 then e1, insertion order) to decide what to mask.
        { kind: "describe", element: cardNumberField },
        { kind: "describe", element: searchField },
      ],
    });
    const page = createFakePage({ frames: [frame] });
    const driver = new PlaywrightBrowserDriver(asPage(page));
    await driver.snapshot();

    await driver.screenshot();

    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ maskColor: "#000000" }));
    const [options] = page.screenshot.mock.calls[0] as unknown as [{ mask: unknown[] }];
    expect(options.mask).toHaveLength(1);
  });

  it("cancels any download the page reports (belt-and-suspenders on top of acceptDownloads:false)", () => {
    const page = createFakePage({ frames: [createFakeFrame()] });
    // eslint-disable-next-line no-new -- constructing wires the "download" listener as a side effect, which is what this test checks.
    new PlaywrightBrowserDriver(asPage(page));
    let cancelled = false;
    page.__triggerDownload({ cancel: () => (cancelled = true) });
    expect(cancelled).toBe(true);
  });
});
