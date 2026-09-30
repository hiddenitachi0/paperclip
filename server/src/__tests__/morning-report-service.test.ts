import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, laneAMessages, morningReportOutbox } from "@paperclipai/db";
import { DEFAULT_MORNING_REPORT_SETTINGS, MORNING_REPORT_RSS_FEEDS, type MorningReportSettings } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { resetWatcherSourceState } from "../services/watcher-sources.ts";
import {
  dedupeHeadlines,
  dueMorningReport,
  looksLikeNewRelease,
  matchesMorningReportTopics,
  morningReportService,
  parseRssItems,
  type MorningReportServiceDeps,
} from "../services/morning-report.ts";

/**
 * Morning report: the pure helpers (no DB — DST safety, dedup, topic/new-
 * release filters, RSS parsing) plus the tick against a real Postgres with
 * every migration applied, with every outbound source (weather, RSS) and the
 * quick agent's model call faked.
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rssXml(items: Array<{ title: string; link: string; pubDate?: string }>): string {
  const body = items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ""}</item>`)
    .join("");
  return `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
}

// ─── Pure helpers: no DB needed ─────────────────────────────────────────────

describe("dueMorningReport — DST safety", () => {
  const settings: MorningReportSettings = { ...DEFAULT_MORNING_REPORT_SETTINGS, enabled: true, time: "07:00", timezone: "Europe/Oslo" };

  it("fires at 07:00 Europe/Oslo local time in both CEST (summer, UTC+2) and CET (winter, UTC+1)", () => {
    // 2026-06-15: Oslo is on CEST (UTC+2) — 07:00 local is 05:00 UTC.
    expect(dueMorningReport(settings, new Date("2026-06-15T05:00:00.000Z"), null)).toEqual({ due: true, localDate: "2026-06-15" });
    // 2026-01-15: Oslo is on CET (UTC+1) — 07:00 local is 06:00 UTC.
    expect(dueMorningReport(settings, new Date("2026-01-15T06:00:00.000Z"), null)).toEqual({ due: true, localDate: "2026-01-15" });
  });

  it("does not fire outside the configured minute, or a second time the same local day", () => {
    expect(dueMorningReport(settings, new Date("2026-01-15T06:01:00.000Z"), null)).toEqual({ due: false });
    expect(dueMorningReport(settings, new Date("2026-06-15T04:59:00.000Z"), null)).toEqual({ due: false });
    expect(dueMorningReport(settings, new Date("2026-01-15T06:00:00.000Z"), "2026-01-15")).toEqual({ due: false });
    // A different local date (e.g. yesterday) does not suppress today's fire.
    expect(dueMorningReport(settings, new Date("2026-01-15T06:00:00.000Z"), "2026-01-14")).toEqual({ due: true, localDate: "2026-01-15" });
  });

  it("never fires when the settings are disabled", () => {
    expect(dueMorningReport({ ...settings, enabled: false }, new Date("2026-01-15T06:00:00.000Z"), null)).toEqual({ due: false });
  });
});

describe("dedupeHeadlines", () => {
  it("collapses the same headline from two sources (case- and punctuation-insensitive) to one, keeping the first seen", () => {
    const items = [
      { title: "Bitcoin hits new high!", source: "a" },
      { title: "bitcoin hits new high", source: "b" },
      { title: "Something else entirely", source: "a" },
    ];
    expect(dedupeHeadlines(items)).toEqual([
      { title: "Bitcoin hits new high!", source: "a" },
      { title: "Something else entirely", source: "a" },
    ]);
  });

  it("drops an empty title instead of treating it as a shared duplicate", () => {
    expect(dedupeHeadlines([{ title: "" }, { title: "   " }, { title: "Real headline" }])).toEqual([{ title: "Real headline" }]);
  });
});

describe("matchesMorningReportTopics", () => {
  it("treats an empty topic list as no filter, and otherwise requires a keyword match", () => {
    expect(matchesMorningReportTopics("Anything at all", [])).toBe(true);
    expect(matchesMorningReportTopics("Bitcoin rallies past $100k", ["crypto"])).toBe(true);
    expect(matchesMorningReportTopics("Local bakery wins award", ["crypto", "ai"])).toBe(false);
  });
});

describe("looksLikeNewRelease", () => {
  it("accepts a real release and rejects speculation, even when both mention the same game", () => {
    expect(looksLikeNewRelease("Tears of the Kingdom DLC out now")).toBe(true);
    expect(looksLikeNewRelease("New Zelda game rumored, could release next year")).toBe(false);
    expect(looksLikeNewRelease("Fans speculate about next Zelda title")).toBe(false);
  });
});

describe("parseRssItems", () => {
  it("reads RSS 2.0 items and Atom entries alike", () => {
    expect(parseRssItems(rssXml([{ title: "Hello", link: "https://example.com/a", pubDate: "2026-01-01" }]))).toEqual([
      { title: "Hello", url: "https://example.com/a", pubDate: "2026-01-01" },
    ]);
    const atom = `<feed><entry><title>Atom item</title><link href="https://example.com/b"/></entry></feed>`;
    expect(parseRssItems(atom)).toEqual([{ title: "Atom item", url: "https://example.com/b", pubDate: null }]);
  });
});

// ─── The tick, against a real Postgres ──────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping morning report service tests: ${support.reason ?? "unsupported environment"}`);
}

d("morning report tick", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  const OSLO_WINTER_0700 = new Date("2026-01-15T06:00:00.000Z");
  const BBC_URL = MORNING_REPORT_RSS_FEEDS.bbc!;
  const DAGBLADET_URL = MORNING_REPORT_RSS_FEEDS.dagbladet!;
  const GIZMODO_URL = MORNING_REPORT_RSS_FEEDS.gizmodo!;

  let feeds: Record<string, string> = {};
  let failingFeeds: Set<string> = new Set();
  let unknownPlaces: Set<string> = new Set();
  let fetchCalls: string[] = [];
  let pending: Promise<void>[] = [];
  let coingeckoPrices: Record<string, { usd: number; usd_24h_change?: number }> = {};
  let eodhdCloses: Array<{ date: string; close: number }> = [];
  const transform = vi.fn();
  const makePicture = vi.fn();
  const webSearch = { search: vi.fn().mockRejectedValue(new Error("web search was not expected in this test")) };

  vi.setConfig({ testTimeout: 60_000 });

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    fetchCalls.push(url.href);
    if (url.hostname === "geocoding-api.open-meteo.com") {
      // Echoes the queried place name back, so DUR-4059's dual-place weather
      // (Drøbak, Oslo) can be told apart in a report's facts.
      const queried = url.searchParams.get("name") || "Oslo";
      if (unknownPlaces.has(queried)) return json({ results: [] });
      return json({ results: [{ name: queried, latitude: 59.91, longitude: 10.75, country: "Norway" }] });
    }
    if (url.hostname === "api.open-meteo.com") {
      return json({
        current: { temperature_2m: 2, wind_speed_10m: 8, precipitation: 0, weather_code: 1 },
        daily: { time: ["2026-01-15"], temperature_2m_max: [3], temperature_2m_min: [-1], precipitation_sum: [0], weather_code: [1] },
      });
    }
    if (url.hostname === "api.coingecko.com") {
      const body: Record<string, { usd: number; usd_24h_change?: number; last_updated_at: number }> = {};
      for (const [id, quote] of Object.entries(coingeckoPrices)) {
        body[id] = { ...quote, last_updated_at: Math.floor(OSLO_WINTER_0700.getTime() / 1000) };
      }
      return json(body);
    }
    if (url.hostname === "eodhd.com") {
      return json(eodhdCloses);
    }
    if (failingFeeds.has(url.href)) return new Response("", { status: 503 });
    const feed = feeds[url.href];
    if (feed) return new Response(feed, { status: 200, headers: { "content-type": "application/rss+xml" } });
    throw new Error(`unexpected request to ${url.href}`);
  }) as unknown as typeof fetch;

  function service(overrides: Partial<MorningReportServiceDeps> = {}) {
    return morningReportService(db, {
      fetchImpl,
      now: () => OSLO_WINTER_0700,
      laneA: { transform, makePicture } as unknown as MorningReportServiceDeps["laneA"],
      webSearch,
      dispatch: (work) => {
        pending.push(work());
      },
      ...overrides,
    });
  }

  async function settle() {
    const work = pending;
    pending = [];
    await Promise.all(work);
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("morning-report");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  beforeEach(() => {
    feeds = {};
    failingFeeds = new Set();
    unknownPlaces = new Set();
    fetchCalls = [];
    pending = [];
    coingeckoPrices = {};
    eodhdCloses = [];
    resetWatcherSourceState();
    transform.mockReset();
    makePicture.mockReset();
    makePicture.mockRejectedValue(new Error("no picture expected in this test"));
    webSearch.search.mockReset();
    webSearch.search.mockRejectedValue(new Error("web search was not expected in this test"));
    transform.mockResolvedValue({
      text: JSON.stringify({ opening: "Good morning! Here is your briefing.", headlines: [] }),
      model: "fake",
      provider: "anthropic",
      truncated: false,
      stopReason: "stop",
    });
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Morning Co",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, settings: MorningReportSettings) {
    const created = await agentService(db).create(companyId, {
      name: "Maja",
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db
      .update(agents)
      .set({ laneAEnabled: true, morningReportSettings: settings as unknown as Record<string, unknown> })
      .where(eq(agents.id, created.id));
    return created.id;
  }

  async function outboxRowsFor(agentId: string) {
    return db.select().from(morningReportOutbox).where(eq(morningReportOutbox.agentId, agentId));
  }

  const baseSettings: MorningReportSettings = {
    ...DEFAULT_MORNING_REPORT_SETTINGS,
    enabled: true,
    time: "07:00",
    timezone: "Europe/Oslo",
    sources: ["bbc", "dagbladet"],
    maxHeadlines: 10,
  };

  it("collects headlines from every configured source (fetches stubbed), de-duplicates across them, and writes one ready outbox row", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, baseSettings);
    feeds[BBC_URL] = rssXml([
      { title: "World leaders meet for summit", link: "https://bbc.example/a" },
      { title: "Shared headline both outlets ran", link: "https://bbc.example/b" },
    ]);
    feeds[DAGBLADET_URL] = rssXml([
      // Same story, different casing/punctuation — must collapse to one.
      { title: "Shared headline both outlets ran!", link: "https://dagbladet.example/c" },
      { title: "Lokal nyhet fra Dagbladet", link: "https://dagbladet.example/d" },
    ]);

    const result = await service().tick(OSLO_WINTER_0700);
    expect(result).toMatchObject({ fired: 1, expired: 0 });
    await settle();

    expect(transform).toHaveBeenCalledTimes(1);
    const input: string = transform.mock.calls[0]![0].input;
    // Both sources contributed, and the shared headline appears exactly once.
    expect(input).toContain("World leaders meet for summit");
    expect(input).toContain("Lokal nyhet fra Dagbladet");
    expect(input.match(/Shared headline both outlets ran/g)).toHaveLength(1);

    const rows = await outboxRowsFor(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, agentId, status: "ready" });
    expect(rows[0]!.text).toContain("Good morning! Here is your briefing.");
    expect(rows[0]!.text).toContain("World leaders meet for summit");
    expect(rows[0]!.text).toContain("Lokal nyhet fra Dagbladet");

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRow).toMatchObject({ morningReportLastSentDate: "2026-01-15", morningReportLeaseUntil: null });
  });

  it("degrades a failing source to a plain-words note instead of losing the rest of the report", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { ...baseSettings, sources: ["bbc", "gizmodo"] });
    feeds[BBC_URL] = rssXml([{ title: "Still-working source headline", link: "https://bbc.example/ok" }]);
    failingFeeds.add(GIZMODO_URL);

    await service().tick(OSLO_WINTER_0700);
    await settle();

    const [row] = await outboxRowsFor(agentId);
    expect(row).toMatchObject({ status: "ready" });
    expect(row!.note ?? "").toContain("gizmodo");
    expect(transform.mock.calls[0]![0].input).toContain("Still-working source headline");
  });

  it("does not fire twice for the same agent-local day even across two overlapping ticks", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, baseSettings);
    feeds[BBC_URL] = rssXml([{ title: "One story", link: "https://bbc.example/one" }]);
    feeds[DAGBLADET_URL] = rssXml([]);

    const svc = service();
    const [first, second] = await Promise.all([svc.tick(OSLO_WINTER_0700), svc.tick(OSLO_WINTER_0700)]);
    await settle();
    // Exactly one of the two concurrent ticks claims the lease.
    expect(first.fired + second.fired).toBe(1);
    expect(await outboxRowsFor(agentId)).toHaveLength(1);

    // A third tick at the same instant finds last_sent_date already set for today.
    const third = await service().tick(OSLO_WINTER_0700);
    await settle();
    expect(third.fired).toBe(0);
    expect(await outboxRowsFor(agentId)).toHaveLength(1);
  });

  it("falls back to the deterministic opening and plain title+link headlines, with a note, when the agent cannot write summaries", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, baseSettings);
    feeds[BBC_URL] = rssXml([{ title: "A headline", link: "https://bbc.example/x" }]);
    feeds[DAGBLADET_URL] = rssXml([]);
    transform.mockRejectedValue(new Error("model host unavailable"));

    await service().tick(OSLO_WINTER_0700);
    await settle();

    const [row] = await outboxRowsFor(agentId);
    expect(row!.status).toBe("ready");
    expect(row!.text).toContain("A headline");
    expect(row!.facts!.headlines[0]!.summary).toBeUndefined();
    expect(row!.note ?? "").toContain("could not write summaries this time");
  });

  it("discards the whole summaries answer (never a half-written one) when the model call is truncated", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, baseSettings);
    feeds[BBC_URL] = rssXml([{ title: "A headline that must survive truncation", link: "https://bbc.example/x" }]);
    feeds[DAGBLADET_URL] = rssXml([]);
    transform.mockResolvedValue({
      text: JSON.stringify({ opening: "Cut off mid", headlines: [{ n: 1, summary: "cut off" }] }),
      model: "fake",
      provider: "anthropic",
      truncated: true,
      stopReason: "max_tokens",
    });

    await service().tick(OSLO_WINTER_0700);
    await settle();

    const [row] = await outboxRowsFor(agentId);
    expect(row!.status).toBe("ready");
    // The deterministic fallback opening, not the (truncated) model one.
    expect(row!.text).toContain("Good morning! Here is your briefing for");
    expect(row!.text).not.toContain("Cut off mid");
    expect(row!.facts!.headlines[0]!.summary).toBeUndefined();
    expect(row!.facts!.headlines[0]!.title).toBe("A headline that must survive truncation");
    expect(row!.note ?? "").toContain("cut off before it finished");
  });

  it("degrades to the deterministic fallback when the model answers with something that is not the expected JSON", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, baseSettings);
    feeds[BBC_URL] = rssXml([{ title: "A headline", link: "https://bbc.example/x" }]);
    feeds[DAGBLADET_URL] = rssXml([]);
    transform.mockResolvedValue({ text: "Sure, here is your briefing: not JSON at all.", model: "fake", provider: "anthropic", truncated: false });

    await service().tick(OSLO_WINTER_0700);
    await settle();

    const [row] = await outboxRowsFor(agentId);
    expect(row!.text).toContain("Good morning! Here is your briefing for");
    expect(row!.facts!.headlines[0]!.summary).toBeUndefined();
    expect(row!.note ?? "").toContain("did not answer with the expected JSON");
  });

  it("applies the model's per-headline summaries by position, leaving an unmatched headline as title+link only", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, baseSettings);
    feeds[BBC_URL] = rssXml([
      { title: "First headline", link: "https://bbc.example/1" },
      { title: "Second headline", link: "https://bbc.example/2" },
    ]);
    feeds[DAGBLADET_URL] = rssXml([]);
    transform.mockResolvedValue({
      text: JSON.stringify({
        opening: "Here is the news, in brief.",
        headlines: [{ n: 1, summary: "The first one, summarized." }],
      }),
      model: "fake",
      provider: "anthropic",
      truncated: false,
    });

    await service().tick(OSLO_WINTER_0700);
    await settle();

    const [row] = await outboxRowsFor(agentId);
    expect(row!.text).toContain("Here is the news, in brief.");
    expect(row!.facts!.headlines[0]).toMatchObject({ title: "First headline", summary: "The first one, summarized." });
    expect(row!.facts!.headlines[1]).toMatchObject({ title: "Second headline" });
    expect(row!.facts!.headlines[1]!.summary).toBeUndefined();
    expect(row!.text).toContain("First headline — The first one, summarized.");
  });

  describe("outbox + ack", () => {
    it("lists ready reports for the company and acknowledges one exactly once", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, baseSettings);
      feeds[BBC_URL] = rssXml([{ title: "A headline", link: "https://bbc.example/x" }]);
      feeds[DAGBLADET_URL] = rssXml([]);

      const svc = service();
      await svc.tick(OSLO_WINTER_0700);
      await settle();

      const listed = await svc.outbox(companyId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ companyId, agentId });
      expect(listed[0]!.text).toContain("Good morning! Here is your briefing.");

      const ack1 = await svc.ack(companyId, listed[0]!.id, { outcome: "delivered" });
      expect(ack1).toEqual({ id: listed[0]!.id, status: "delivered" });
      // Already-delivered stays delivered on a retried ack, and the outbox no longer lists it.
      const ack2 = await svc.ack(companyId, listed[0]!.id, { outcome: "failed" });
      expect(ack2).toEqual({ id: listed[0]!.id, status: "delivered" });
      expect(await svc.outbox(companyId)).toHaveLength(0);
    });
  });

  // DUR-4059: prices must work without Filip ever creating a watcher, and
  // must use the right live-quote source for the symbol — earlier code
  // always tried the crypto source, so DNB.OL never got a fallback price.
  describe("prices without a watcher", () => {
    const settingsWithPrices: MorningReportSettings = { ...baseSettings, sources: [], priceSymbols: ["BTC", "DNB.OL"] };

    it("fetches crypto directly from CoinGecko, using its 24h change as the comparison", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...settingsWithPrices, priceSymbols: ["BTC"] });
      coingeckoPrices.bitcoin = { usd: 65000, usd_24h_change: 5 };

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts).toMatchObject({ prices: [{ symbol: "BTC", price: 65000, currency: "USD", history: [] }] });
      expect(row!.facts!.prices[0]!.changePercent).toBeCloseTo(5, 5);
      // The facts handed to the one model call, not what the (mocked) model wrote back.
      expect(transform.mock.calls[0]![0].input).toContain("BTC: 65000 USD (+5.00% vs ~24h ago)");
    });

    it("fetches DNB.OL from EODHD (not the crypto source) when a company EODHD key is saved", async () => {
      const companyId = await seedCompany();
      await secretService(db).create(companyId, { name: "EODHD", provider: "local_encrypted", value: "fake-eodhd-key" });
      const agentId = await seedAgent(companyId, { ...settingsWithPrices, priceSymbols: ["DNB.OL"] });
      eodhdCloses = [
        { date: "2026-01-13", close: 250 },
        { date: "2026-01-14", close: 260 },
      ];

      await service().tick(OSLO_WINTER_0700);
      await settle();

      expect(fetchCalls.some((url) => url.includes("eodhd.com"))).toBe(true);
      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts).toMatchObject({ prices: [{ symbol: "DNB.OL", price: 260, currency: "NOK", history: [] }] });
      expect(row!.facts!.prices[0]!.changePercent).toBeCloseTo(4, 5);
    });

    it("says plainly that no stock data key is configured, instead of silently querying CoinGecko for DNB.OL", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...settingsWithPrices, priceSymbols: ["DNB.OL"] });

      await service().tick(OSLO_WINTER_0700);
      await settle();

      expect(fetchCalls.some((url) => url.includes("eodhd.com") || url.includes("coingecko.com"))).toBe(false);
      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts!.prices).toEqual([]);
      expect(row!.note ?? "").toContain("no stock data key is configured");
    });
  });

  // DUR-4059: weather covers both of Filip's default places (Drøbak, Oslo)
  // unless a place override is set, in which case only that one place is used.
  describe("places (weather)", () => {
    it("fetches weather for both default places and lists them in the facts", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
      feeds[BBC_URL] = rssXml([]);

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const geocodeQueries = fetchCalls
        .filter((url) => url.includes("geocoding-api.open-meteo.com"))
        .map((url) => new URL(url).searchParams.get("name"));
      expect(geocodeQueries).toEqual(["Drøbak", "Oslo"]);
      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts!.places).toEqual(["Drøbak", "Oslo"]);
      expect(row!.facts!.weather).toEqual([
        { place: "Drøbak", text: expect.stringContaining("Now in Drøbak") },
        { place: "Oslo", text: expect.stringContaining("Now in Oslo") },
      ]);
    });

    it("fetches only the override place when one is set, not the defaults", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        ...baseSettings,
        sources: ["bbc"],
        placeOverride: "Bergen",
        placeOverrideUntil: null,
      });
      feeds[BBC_URL] = rssXml([]);

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const geocodeQueries = fetchCalls
        .filter((url) => url.includes("geocoding-api.open-meteo.com"))
        .map((url) => new URL(url).searchParams.get("name"));
      expect(geocodeQueries).toEqual(["Bergen"]);
      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts!.places).toEqual(["Bergen"]);
    });

    it("degrades one failing place to a note while still reporting the other's weather", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
      feeds[BBC_URL] = rssXml([]);
      unknownPlaces.add("Drøbak");

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts!.weather.some((w) => w.place === "Drøbak")).toBe(false);
      expect(row!.facts!.weather).toEqual([{ place: "Oslo", text: expect.stringContaining("Now in Oslo") }]);
      expect(row!.note ?? "").toContain('could not find a place called "Drøbak"');
    });
  });

  // DUR-4059: pictures via Media Studio (laneA.makePicture) — a weather
  // portrait of the agent and one mood picture, never blocking the report.
  describe("pictures", () => {
    it("stores a weather picture and a mood picture Media Studio made, and degrades gracefully when it fails", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
      feeds[BBC_URL] = rssXml([{ title: "A headline to set the mood", link: "https://bbc.example/mood" }]);
      makePicture
        .mockResolvedValueOnce({ ok: true, fileId: "11111111-1111-1111-1111-111111111111", seed: 1 })
        .mockResolvedValueOnce({ ok: false, reason: "Media Studio is not switched on for this company." });

      await service().tick(OSLO_WINTER_0700);
      await settle();

      expect(makePicture).toHaveBeenCalledTimes(2);
      const [row] = await outboxRowsFor(agentId);
      expect(row!.facts!.images).toEqual([
        { fileId: "11111111-1111-1111-1111-111111111111", caption: expect.stringContaining("dressed for today's weather"), kind: "weather" },
      ]);
      expect(row!.note ?? "").toContain("No mood picture this time");
    });
  });

  // DUR-4059 review (PR #410 was rejected for cutting off mid-report): a
  // realistic-size report — 10 headlines, 5 hobby items, 1 sport item, 4
  // prices, 2 places — must come out with nothing cut off and every
  // configured section present, because every list is rendered by code from
  // the facts and only the model's own short opening/summaries are capped.
  describe("realistic fixture: nothing cut off, every section present", () => {
    it("builds a full report from 10 headlines, hobby news, sport, 4 prices and 2 places with every section present", async () => {
      const companyId = await seedCompany();
      await secretService(db).create(companyId, { name: "EODHD", provider: "local_encrypted", value: "fake-eodhd-key" });
      const agentId = await seedAgent(companyId, {
        ...baseSettings,
        sources: ["bbc", "dagbladet"],
        hobbyTopics: ["zelda"],
        sportFollows: ["mats_zuccarello_nhl"],
        priceSymbols: ["BTC", "SOL", "ETH", "DNB.OL"],
        maxHeadlines: 10,
      });
      feeds[BBC_URL] = rssXml(
        Array.from({ length: 6 }, (_, i) => ({ title: `BBC headline ${i + 1}`, link: `https://bbc.example/${i + 1}` })),
      );
      feeds[DAGBLADET_URL] = rssXml(
        Array.from({ length: 6 }, (_, i) => ({ title: `Dagbladet headline ${i + 1}`, link: `https://dagbladet.example/${i + 1}` })),
      );
      feeds[MORNING_REPORT_RSS_FEEDS.zelda_dungeon!] = rssXml(
        Array.from({ length: 5 }, (_, i) => ({ title: `Zelda release ${i + 1} out now`, link: `https://zeldadungeon.example/${i + 1}` })),
      );
      webSearch.search.mockImplementation(async (_companyId: string, params: { query: string }) => {
        if (params.query === "Mats Zuccarello NHL result news") {
          return { results: [{ title: "Zuccarello scores in overtime win", url: "https://nhl.example/zucc" }] };
        }
        throw new Error(`unexpected search in fixture test: ${params.query}`);
      });
      coingeckoPrices.bitcoin = { usd: 65000, usd_24h_change: 5 };
      coingeckoPrices.solana = { usd: 150, usd_24h_change: -2 };
      coingeckoPrices.ethereum = { usd: 3200, usd_24h_change: 1.5 };
      eodhdCloses = [
        { date: "2026-01-13", close: 250 },
        { date: "2026-01-14", close: 260 },
      ];
      transform.mockResolvedValue({
        text: JSON.stringify({
          opening: "Good morning! It's a busy news day with market moves across the board.",
          headlines: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, summary: `Summary for headline ${i + 1}.` })),
        }),
        model: "fake",
        provider: "anthropic",
        truncated: false,
      });

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const [row] = await outboxRowsFor(agentId);
      const facts = row!.facts!;
      expect(facts.places).toEqual(["Drøbak", "Oslo"]);
      expect(facts.weather).toHaveLength(2);
      expect(facts.headlines).toHaveLength(10);
      expect(facts.headlines.every((h) => typeof h.summary === "string" && h.summary!.length > 0)).toBe(true);
      expect(facts.hobby).toHaveLength(5);
      expect(facts.sport).toHaveLength(1);
      expect(facts.prices).toHaveLength(4);
      expect(facts.stats).toEqual({ sourcesChecked: 2, itemsFound: 10 });
      expect(facts.briefingPageLive).toBe(true);

      // Nothing is cut off: all 10 numbered headlines and every configured
      // section actually appear in the full text, plus the footer.
      for (let i = 1; i <= 10; i++) expect(row!.text).toContain(`${i}. `);
      expect(row!.text).toContain("Weather:");
      expect(row!.text).toContain("Headlines:");
      expect(row!.text).toContain("Hobby news:");
      expect(row!.text).toContain("Sport:");
      expect(row!.text).toContain("Prices:");
      expect(row!.text).toContain("Sources checked: 2, headlines found: 10.");

      // The Telegram teaser stays short — never the full report.
      expect(facts.teaser.split("\n").length).toBeLessThanOrEqual(3);
    });

    it("says so in one line, per section, on a day nothing came in — instead of the section silently disappearing", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        ...baseSettings,
        sources: ["bbc"],
        hobbyTopics: ["zelda"],
        sportFollows: ["mats_zuccarello_nhl"],
        priceSymbols: ["BTC"],
      });
      feeds[BBC_URL] = rssXml([]);
      feeds[MORNING_REPORT_RSS_FEEDS.zelda_dungeon!] = rssXml([]);
      webSearch.search.mockResolvedValue({ results: [] });

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const [row] = await outboxRowsFor(agentId);
      expect(row!.text).toContain("Headlines: no new headlines found today.");
      expect(row!.text).toContain("Hobby news: nothing new today.");
      expect(row!.text).toContain("Sport: nothing new today.");
      expect(row!.text).toContain("Prices: unavailable today.");
      expect(row!.text).toContain("Sources checked: 1, headlines found: 0.");
    });
  });

  describe("briefingPageLive", () => {
    it("is true by default (the page ships with this service), and false when switched off", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
      feeds[BBC_URL] = rssXml([]);

      const previous = process.env.PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED;
      delete process.env.PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED;
      try {
        await service().tick(OSLO_WINTER_0700);
        await settle();
        expect((await outboxRowsFor(agentId))[0]!.facts!.briefingPageLive).toBe(true);

        const agentId2 = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
        await service({ briefingPageLive: false }).tick(OSLO_WINTER_0700);
        await settle();
        expect((await outboxRowsFor(agentId2))[0]!.facts!.briefingPageLive).toBe(false);

        const agentId3 = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
        process.env.PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED = "false";
        await service().tick(OSLO_WINTER_0700);
        await settle();
        expect((await outboxRowsFor(agentId3))[0]!.facts!.briefingPageLive).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED;
        else process.env.PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED = previous;
      }
    });
  });

  describe("getOne", () => {
    it("returns one report's facts, company-scoped", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { ...baseSettings, sources: ["bbc"] });
      feeds[BBC_URL] = rssXml([{ title: "A headline", link: "https://bbc.example/x" }]);

      const svc = service();
      await svc.tick(OSLO_WINTER_0700);
      await settle();
      const [listed] = await svc.outbox(companyId);

      const fetched = await svc.getOne(companyId, listed!.id);
      expect(fetched).toMatchObject({ id: listed!.id, companyId, agentId });

      const otherCompanyId = await seedCompany();
      await expect(svc.getOne(otherCompanyId, listed!.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  // DUR-4059: the report becomes part of the quick agent's own Lane A chat
  // history, so a later "tell me more about number 3" in Telegram resolves
  // against the same headlines Filip was sent.
  describe("conversation continuity", () => {
    it("appends the report as an assistant turn owned by the company's board owner, and carries the conversationId in the outbox", async () => {
      const companyId = await seedCompany();
      const ownerUserId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: ownerUserId,
        membershipRole: "owner",
        status: "active",
      });
      const agentId = await seedAgent(companyId, baseSettings);
      feeds[BBC_URL] = rssXml([{ title: "A story worth a follow-up", link: "https://bbc.example/x" }]);
      feeds[DAGBLADET_URL] = rssXml([]);

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const [row] = await outboxRowsFor(agentId);
      expect(row!.conversationId).toBeTruthy();
      const messages = await db.select().from(laneAMessages).where(eq(laneAMessages.conversationId, row!.conversationId!));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: "assistant", agentId });
      expect(messages[0]!.content).toContain("A story worth a follow-up");
    });

    it("leaves conversationId null (never fails the report) when the company has no board owner", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, baseSettings);
      feeds[BBC_URL] = rssXml([]);
      feeds[DAGBLADET_URL] = rssXml([]);

      await service().tick(OSLO_WINTER_0700);
      await settle();

      const [row] = await outboxRowsFor(agentId);
      expect(row!.status).toBe("ready");
      expect(row!.conversationId).toBeNull();
    });
  });

  // DUR-4059: the settings card's "Send a test report now" button.
  describe("sendTestReportNow", () => {
    it("composes and returns a report immediately, prefixed as a test, without consuming the day's scheduled slot", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, baseSettings);
      feeds[BBC_URL] = rssXml([{ title: "A headline", link: "https://bbc.example/x" }]);
      feeds[DAGBLADET_URL] = rssXml([]);

      const svc = service();
      const result = await svc.sendTestReportNow(companyId, agentId);
      expect(result.text).toContain("🧪 Test report");

      const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agentRow).toMatchObject({ morningReportLastSentDate: null, morningReportLeaseUntil: null });

      // The real scheduled report still fires today — the test did not use up the slot.
      const tickResult = await svc.tick(OSLO_WINTER_0700);
      expect(tickResult.fired).toBe(1);
      await settle();
      expect(await outboxRowsFor(agentId)).toHaveLength(2);
    });

    it("rejects an unknown agent", async () => {
      const companyId = await seedCompany();
      await expect(service().sendTestReportNow(companyId, randomUUID())).rejects.toMatchObject({ status: 404 });
    });
  });
});
