// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MorningReportFacts } from "@paperclipai/shared";
import { MorningReport } from "./MorningReport";

/**
 * The morning report page body (Claude Design, 30 Sep 2026). It renders only
 * from structured facts, parts of which are model-written or come from news
 * feeds, so it must never turn text into markup and never link anywhere but
 * http(s).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function facts(overrides: Partial<MorningReportFacts> = {}): MorningReportFacts {
  return {
    places: ["Drøbak", "Oslo"],
    weather: [
      { place: "Oslo", text: "Now: 8°C, drizzle." },
      { place: "Drøbak", text: "Now: 9°C, light rain." },
    ],
    headlines: [
      { title: "Rates on hold", url: "https://example.com/1", source: "E24", summary: "No change this month." },
      { title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", source: "feed", summary: null },
      { title: "Third story", url: "https://example.com/3", source: "NRK" },
    ],
    hobby: [],
    sport: [{ title: "Zuccarello scores twice", url: "https://example.com/s1", source: "NHL.com" }],
    prices: [
      {
        symbol: "BTC",
        price: 64210,
        currency: "USD",
        changePercent: 2.14,
        history: [
          { price: 62000, observedAt: "2026-09-29T00:00:00.000Z" },
          { price: 64210, observedAt: "2026-09-30T00:00:00.000Z" },
        ],
      },
      { symbol: "DNB.OL", price: 221.4, currency: "NOK", changePercent: null, history: [] },
    ],
    images: [
      { fileId: "mood-1", caption: "A calm, grey start.", kind: "mood" },
      { fileId: "weather-1", caption: "Maja with an umbrella.", kind: "weather" },
    ],
    opening: "Good morning. **Not bold** <b>not markup</b>.",
    teaser: "Rates on hold.",
    stats: { sourcesChecked: 11, itemsFound: 23 },
    notes: ["No stock data key configured for DNB.OL."],
    briefingPageLive: true,
    ...overrides,
  };
}

describe("MorningReport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(f: MorningReportFacts) {
    act(() => {
      root.render(<MorningReport facts={f} imageUrl={(id) => `/api/attachments/${id}/content`} date={new Date(2026, 8, 30)} />);
    });
  }

  it("numbers every headline so 'tell me more about number 3' in Telegram matches the page", () => {
    render(facts());
    const numbers = Array.from(container.querySelectorAll('[aria-label^="Number "]')).map((el) => el.textContent);
    expect(numbers).toEqual(["1", "2", "3"]);
    expect(container.textContent).toContain("No change this month.");
  });

  it("never renders text as markup and never links to a non-http(s) URL", () => {
    render(facts());
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<b>not markup</b>");
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^https?:\/\//);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });

  it("loads pictures only through Paperclip's own attachment URLs", () => {
    render(facts());
    const srcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(srcs).toEqual(["/api/attachments/mood-1/content", "/api/attachments/weather-1/content"]);
  });

  it("shows weather in the order of the configured places, and says so when a section is empty", () => {
    render(facts());
    const text = container.textContent ?? "";
    expect(text.indexOf("Drøbak")).toBeLessThan(text.indexOf("Oslo"));
    expect(text).toContain("Nothing new today");
    expect(text).toContain("11 sources checked · 23 items found");
  });

  it("shows a dash instead of a change when there is no earlier price, and no sparkline without history", () => {
    render(facts());
    expect(container.textContent).toContain("—");
    expect(container.querySelectorAll("svg polyline")).toHaveLength(1);
  });
});
