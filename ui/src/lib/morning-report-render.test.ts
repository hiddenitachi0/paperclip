import { describe, expect, it } from "vitest";
import type { MorningReportFacts, MorningReportOutboxItem } from "@paperclipai/shared";
import { buildStandaloneReportHtml, isSafeExternalUrl, summarizeCoverage } from "./morning-report-render";

const facts: MorningReportFacts = {
  places: ["Drøbak", "Oslo"],
  weather: [
    { place: "Drøbak", text: "Cloudy, 8°C" },
    { place: "Oslo", text: "Clear, 6°C" },
  ],
  headlines: [
    { title: "Big news story", url: "https://bbc.co.uk/story", source: "bbc" },
    { title: "Second story", url: "https://nettavisen.no/story-2", source: "nettavisen" },
  ],
  hobby: [{ title: "Zelda update", url: "https://zeldadungeon.net/x", source: "zelda_dungeon" }],
  sport: [{ title: "Zuccarello scores", url: "https://example.com/nhl", source: "bbc" }],
  prices: [
    { symbol: "BTC", price: 65000, currency: "USD", changePercent: 1.2, history: [] },
    { symbol: "DNB.OL", price: 210.5, currency: "NOK", changePercent: -0.4, history: [] },
  ],
  images: [
    { fileId: "file-1", caption: "Maja dressed for the weather", kind: "weather" },
    { fileId: "file-2", caption: "Today's mood, in one picture.", kind: "mood" },
  ],
  opening: "Good morning! A calm day in the markets.",
  teaser: "Drøbak 8°C, Oslo 6°C. Big news story. BTC +1.2%.",
  // Deliberately different from a recount of distinct sources across the kept
  // fact lists (which would be 3): stats.sourcesChecked counts every source
  // the agent checked, including ones with zero kept items after filtering —
  // this is the exact "2 sources checked" vs "report says 11" bug (DUR-4138).
  stats: { sourcesChecked: 11, itemsFound: 6 },
  briefingPageLive: true,
  notes: ["No stock data key configured for ETH."],
};

const report: MorningReportOutboxItem = {
  id: "report-1",
  companyId: "company-1",
  agentId: "agent-1",
  text: "Good morning! Here is your briefing.",
  facts,
  conversationId: null,
  createdAt: "2026-09-29T07:00:00.000Z",
};

describe("isSafeExternalUrl", () => {
  it("allows http and https", () => {
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript:, data:, mailto:, and malformed URLs", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
  });
});

describe("summarizeCoverage", () => {
  it("reads facts.stats directly, not a recount of distinct sources across kept items", () => {
    // A recount over headlines/hobby/sport would give 3 (bbc, nettavisen,
    // zelda_dungeon); facts.stats.sourcesChecked (11) is the real answer —
    // every source the agent checked, including ones filtered/deduped away.
    expect(summarizeCoverage(facts)).toEqual({ sourcesChecked: 11, itemsFound: 6 });
  });

  it("returns zero for an empty facts object", () => {
    const empty: MorningReportFacts = {
      places: [],
      weather: [],
      headlines: [],
      hobby: [],
      sport: [],
      prices: [],
      images: [],
      opening: "",
      teaser: "",
      stats: { sourcesChecked: 0, itemsFound: 0 },
      briefingPageLive: false,
      notes: [],
    };
    expect(summarizeCoverage(empty)).toEqual({ sourcesChecked: 0, itemsFound: 0 });
  });
});

describe("buildStandaloneReportHtml", () => {
  it("renders every fact section from a realistic fixture", () => {
    const html = buildStandaloneReportHtml(report, "Maja", [
      { fileId: "file-1", caption: "Maja dressed for the weather", dataUrl: "data:image/png;base64,AAAA" },
      { fileId: "file-2", caption: "Today's mood, in one picture.", dataUrl: "data:image/png;base64,MOOD" },
    ]);

    expect(html).toContain("Maja's morning report");
    expect(html).toContain("Good morning! Here is your briefing.");
    expect(html).toContain("Big news story");
    expect(html).toContain("Second story");
    expect(html).toContain("Zelda update");
    expect(html).toContain("Zuccarello scores");
    expect(html).toContain("BTC");
    expect(html).toContain("210.5");
    expect(html).toContain("No stock data key configured for ETH.");
    expect(html).toContain("Drøbak");
    expect(html).toContain("Cloudy, 8°C");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,MOOD");
    // facts.stats, not a recount (DUR-4138) — see summarizeCoverage.
    expect(html).toContain("11 sources checked, 6 items found.");
  });

  it("orders sections the same way the live briefing page does: mood image, headlines, weather, prices, hobby, sport, notes", () => {
    const html = buildStandaloneReportHtml(report, "Maja", [
      { fileId: "file-1", caption: "Maja dressed for the weather", dataUrl: "data:image/png;base64,AAAA" },
      { fileId: "file-2", caption: "Today's mood, in one picture.", dataUrl: "data:image/png;base64,MOOD" },
    ]);
    const order = ["data:image/png;base64,MOOD", "Big news story", "Cloudy, 8°C", "BTC", "Zelda update", "Zuccarello scores", "No stock data key configured"];
    const indices = order.map((marker) => html.indexOf(marker));
    for (const i of indices) expect(i).toBeGreaterThan(-1);
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  });

  it("only ever embeds already-fetched data: URIs for images, never a live network reference", () => {
    const html = buildStandaloneReportHtml(report, "Maja", [
      { fileId: "file-1", caption: "cap", dataUrl: "data:image/png;base64,BBBB" },
    ]);
    expect(html).not.toContain("/api/attachments/");
    expect(html).toContain("<img src=\"data:image/png;base64,BBBB\"");
  });

  it("never links to an unsafe scheme, even if a headline URL is unsafe", () => {
    const withUnsafeLink: MorningReportOutboxItem = {
      ...report,
      facts: {
        ...facts,
        headlines: [{ title: "Suspicious", url: "javascript:alert(1)", source: "bbc" }],
      },
    };
    const html = buildStandaloneReportHtml(withUnsafeLink, "Maja", []);
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).toContain("<span>Suspicious</span>");
  });

  it("falls back to just the text when facts is null (a report from before this shipped)", () => {
    const withoutFacts: MorningReportOutboxItem = { ...report, facts: null };
    const html = buildStandaloneReportHtml(withoutFacts, "Maja", []);
    expect(html).toContain("Good morning! Here is your briefing.");
    expect(html).not.toContain("<section><h2>Headlines");
  });

  it("escapes model-written text instead of ever injecting raw HTML", () => {
    const withHtmlInText: MorningReportOutboxItem = {
      ...report,
      text: "<img src=x onerror=alert(1)>",
    };
    const html = buildStandaloneReportHtml(withHtmlInText, "Maja", []);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
