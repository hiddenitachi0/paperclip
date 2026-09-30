/**
 * DUR-4078: a minimal fake of the slice of the Playwright API this package's
 * unit tests need (`Page`/`Frame`/`Locator`/`BrowserContext`), so
 * `session-manager.test.ts`, `dom-snapshot.test.ts` and
 * `playwright-driver.test.ts` can exercise the real driver/session logic
 * without a real Chromium process -- this sandbox has no Chromium runtime
 * available (missing shared libs), so a real-browser run only happens in the
 * clearly-marked integration test (`playwright-driver.integration.test.ts`),
 * which skips itself when that is true.
 *
 * Test doubles here are deliberately loose (`vi.fn` stubs, no real DOM) --
 * they let a test script exactly what one `frame.evaluate(...)` call should
 * return, the same way `browser-tools.test.ts`'s `fakeDriver()` scripts
 * `BrowserDriver` itself one level up.
 */

import { vi } from "vitest";

export interface FakeLocatorCalls {
  click: unknown[];
  fill: unknown[];
  selectOption: unknown[];
  check: unknown[];
  uncheck: unknown[];
}

export function createFakeLocator(overrides: Partial<Record<keyof FakeLocatorCalls, (...args: unknown[]) => unknown>> = {}) {
  return {
    click: vi.fn(overrides.click ?? (async () => undefined)),
    fill: vi.fn(overrides.fill ?? (async () => undefined)),
    selectOption: vi.fn(overrides.selectOption ?? (async () => undefined)),
    check: vi.fn(overrides.check ?? (async () => undefined)),
    uncheck: vi.fn(overrides.uncheck ?? (async () => undefined)),
  };
}
export type FakeLocator = ReturnType<typeof createFakeLocator>;

export interface FakeFrameOptions {
  isDetached?: boolean;
  /** One scripted return value per `evaluate` call, consumed in order; the last one repeats once exhausted. */
  evaluateResults?: unknown[];
}

export function createFakeFrame(options: FakeFrameOptions = {}) {
  const results = options.evaluateResults ?? [];
  let callIndex = 0;
  const evaluate = vi.fn(async () => {
    const result = results[Math.min(callIndex, results.length - 1)];
    callIndex += 1;
    return result;
  });
  const locators = new Map<string, FakeLocator>();
  return {
    isDetached: vi.fn(() => options.isDetached ?? false),
    evaluate,
    locator: vi.fn((selector: string) => {
      const existing = locators.get(selector);
      if (existing) return existing;
      const created = createFakeLocator();
      locators.set(selector, created);
      return created;
    }),
    __locators: locators,
  };
}
export type FakeFrame = ReturnType<typeof createFakeFrame>;

export interface FakePageOptions {
  url?: string;
  title?: string;
  frames?: FakeFrame[];
}

export function createFakePage(options: FakePageOptions = {}) {
  const frames = options.frames ?? [createFakeFrame()];
  const downloadHandlers: Array<(download: unknown) => void> = [];
  return {
    frames: vi.fn(() => frames),
    url: vi.fn(() => options.url ?? "https://example.com/"),
    title: vi.fn(async () => options.title ?? "Example"),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from("fake-png")),
    keyboard: { press: vi.fn(async () => undefined) },
    on: vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") downloadHandlers.push(handler);
    }),
    context: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
    __triggerDownload: (download: unknown) => downloadHandlers.forEach((h) => h(download)),
  };
}
export type FakePage = ReturnType<typeof createFakePage>;

export function createFakeContext(page: FakePage) {
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
}
