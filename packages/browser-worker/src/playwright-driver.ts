/**
 * DUR-4078: the real `BrowserDriver` (interface in
 * `@paperclipai/adapter-utils/browser-tools`), backed by a single Playwright
 * `Page` inside its own hardened Chromium process (see chromium-launch.ts).
 * Every method here is exactly what `BrowserToolHandler`/`browser-service.ts`
 * already call against the interface -- this class holds no gating logic of
 * its own (that stays in `@paperclipai/adapter-utils`), it only has to
 * execute the action faithfully and return an `AccessibilitySnapshot`/
 * `ElementDescriptor` shaped the same way a fake driver's unit tests expect.
 *
 * `fill_payment_details` (server/src/services/browser-service.ts) reaches
 * this exact same class through `performType` -- there is no separate
 * "fill" wire call or clearance token the worker ever sees (confirmed
 * against the current server code): the server enforces the clearance
 * itself and only ever issues a `performType` once it has, so this driver's
 * job is unchanged whether the text it is asked to type is a search query or
 * a card number.
 */

import type { Page, Locator } from "playwright-core";
import type { AccessibilitySnapshot, BrowserDriver, ElementDescriptor } from "@paperclipai/adapter-utils/browser-tools";
import { DomSnapshotter, treeToPlainText } from "./dom-snapshot.js";

const NAVIGATION_TIMEOUT_MS = 30_000;

function unknownRefError(ref: string): Error {
  return new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly snapshotter = new DomSnapshotter();

  constructor(private readonly page: Page) {
    // Belt-and-suspenders on top of `acceptDownloads: false` at the context
    // level (chromium-launch.ts): make sure a download is actively cancelled
    // rather than left to whatever Playwright's own default becomes.
    page.on("download", (download) => {
      void download.cancel();
    });
  }

  private locator(ref: string): Locator {
    const locator = this.snapshotter.locatorFor(ref);
    if (!locator) throw unknownRefError(ref);
    return locator;
  }

  async navigate(url: string): Promise<AccessibilitySnapshot> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    return this.snapshotter.capture(this.page);
  }

  snapshot(): Promise<AccessibilitySnapshot> {
    return this.snapshotter.capture(this.page);
  }

  async readText(): Promise<string> {
    const snap = await this.snapshotter.capture(this.page);
    return treeToPlainText(snap.tree);
  }

  describeElement(ref: string): Promise<ElementDescriptor | null> {
    return this.snapshotter.describeElement(ref);
  }

  async performClick(ref: string): Promise<AccessibilitySnapshot> {
    const locator = this.locator(ref);
    await locator.click({ timeout: NAVIGATION_TIMEOUT_MS });
    await this.settleAfterAction();
    return this.snapshotter.capture(this.page);
  }

  async performType(ref: string, text: string): Promise<AccessibilitySnapshot> {
    const locator = this.locator(ref);
    await locator.fill(text, { timeout: NAVIGATION_TIMEOUT_MS });
    return this.snapshotter.capture(this.page);
  }

  async performSelect(ref: string, value: string): Promise<AccessibilitySnapshot> {
    const locator = this.locator(ref);
    await locator.selectOption(value, { timeout: NAVIGATION_TIMEOUT_MS });
    return this.snapshotter.capture(this.page);
  }

  async performCheck(ref: string, checked: boolean): Promise<AccessibilitySnapshot> {
    const locator = this.locator(ref);
    if (checked) await locator.check({ timeout: NAVIGATION_TIMEOUT_MS });
    else await locator.uncheck({ timeout: NAVIGATION_TIMEOUT_MS });
    return this.snapshotter.capture(this.page);
  }

  focusedFormSubmitTarget(): Promise<ElementDescriptor | null> {
    return this.snapshotter.focusedFormSubmitTarget(this.page);
  }

  async performPressKey(key: string): Promise<AccessibilitySnapshot> {
    await this.page.keyboard.press(key);
    await this.settleAfterAction();
    return this.snapshotter.capture(this.page);
  }

  async screenshot(): Promise<Uint8Array> {
    const refs = await this.snapshotter.paymentFieldRefs();
    const mask = refs
      .map((ref) => this.snapshotter.locatorFor(ref))
      .filter((locator): locator is Locator => locator !== null);
    const buffer = await this.page.screenshot({ mask, maskColor: "#000000", timeout: NAVIGATION_TIMEOUT_MS });
    return buffer;
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async back(): Promise<AccessibilitySnapshot> {
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    return this.snapshotter.capture(this.page);
  }

  async close(): Promise<void> {
    await this.page.context().close();
  }

  /**
   * A click/press-key can trigger a navigation (form submit, SPA route
   * change); give it a short, bounded chance to settle before the snapshot
   * is taken, but never block indefinitely on a page that decides not to
   * navigate at all (that is not an error -- most clicks don't navigate).
   */
  private async settleAfterAction(): Promise<void> {
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: 2_000 })
      .catch(() => undefined);
  }
}
