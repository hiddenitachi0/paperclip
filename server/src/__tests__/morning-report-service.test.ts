import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, morningReportOutbox } from "@paperclipai/db";
import { DEFAULT_MORNING_REPORT_SETTINGS, MORNING_REPORT_RSS_FEEDS, type MorningReportSettings } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
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
  let fetchCalls: string[] = [];
  let pending: Promise<void>[] = [];
  const transform = vi.fn();
  const webSearch = { search: vi.fn().mockRejectedValue(new Error("web search was not expected in this test")) };

  vi.setConfig({ testTimeout: 60_000 });

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    fetchCalls.push(url.href);
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return json({ results: [{ name: "Oslo", latitude: 59.91, longitude: 10.75, country: "Norway" }] });
    }
    if (url.hostname === "api.open-meteo.com") {
      return json({
        current: { temperature_2m: 2, wind_speed_10m: 8, precipitation: 0, weather_code: 1 },
        daily: { time: ["2026-01-15"], temperature_2m_max: [3], temperature_2m_min: [-1], precipitation_sum: [0], weather_code: [1] },
      });
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
      laneA: { transform } as unknown as MorningReportServiceDeps["laneA"],
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
    fetchCalls = [];
    pending = [];
    transform.mockReset();
    webSearch.search.mockReset();
    webSearch.search.mockRejectedValue(new Error("web search was not expected in this test"));
    transform.mockResolvedValue({ text: "Good morning! Here is your briefing.", model: "fake", provider: "anthropic" });
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
    expect(rows[0]).toMatchObject({ companyId, agentId, status: "ready", text: "Good morning! Here is your briefing." });

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

  it("falls back to the plain facts, with a note, when the agent cannot write the report", async () => {
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
    expect(row!.note ?? "").toContain("could not write this one");
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
      expect(listed[0]).toMatchObject({ companyId, agentId, text: "Good morning! Here is your briefing." });

      const ack1 = await svc.ack(companyId, listed[0]!.id, { outcome: "delivered" });
      expect(ack1).toEqual({ id: listed[0]!.id, status: "delivered" });
      // Already-delivered stays delivered on a retried ack, and the outbox no longer lists it.
      const ack2 = await svc.ack(companyId, listed[0]!.id, { outcome: "failed" });
      expect(ack2).toEqual({ id: listed[0]!.id, status: "delivered" });
      expect(await svc.outbox(companyId)).toHaveLength(0);
    });
  });
});
