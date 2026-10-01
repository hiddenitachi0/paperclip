import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ProductExtractorTemplate } from "./extractor.js";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../activity-log.js", () => ({ logActivity: mockLogActivity }));

const { productGrabberService } = await import("./service.js");

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "user-1";
const NOW = new Date("2026-10-01T00:00:00.000Z");

function fakeSelectOne(row: Record<string, unknown> | undefined) {
  return { from: () => ({ where: () => Promise.resolve(row ? [row] : []) }) };
}

function fakeSelectList(rows: Record<string, unknown>[]) {
  return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) };
}

function fakeInsert(row: Record<string, unknown>) {
  return { values: () => ({ returning: () => Promise.resolve([row]) }) };
}

function fakeUpdate(row: Record<string, unknown> | undefined) {
  return { set: () => ({ where: () => ({ returning: () => Promise.resolve(row ? [row] : []) }) }) };
}

function stagedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    companyId: COMPANY_ID,
    vendor: "example.com",
    sourceUrl: "https://example.com/p/1",
    rawFields: { title: "Widget" },
    imageUrls: ["https://example.com/img.jpg"],
    status: "pending",
    approvedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const passthroughTemplate: ProductExtractorTemplate = {
  vendor: "example.com",
  matches: (url) => url.hostname.endsWith("example.com"),
  extract: () => ({
    vendor: "example.com",
    title: "Widget",
    description: "A fine widget.",
    priceAmount: 10,
    priceCurrency: "USD",
    imageUrls: ["https://example.com/img.jpg"],
    rawFields: { foo: "bar" },
  }),
};

beforeEach(() => {
  mockLogActivity.mockClear();
});

describe("productGrabberService.extractAndStage", () => {
  it("refuses when the company has not turned the feature on", async () => {
    const db = { select: vi.fn().mockReturnValue(fakeSelectOne(undefined)) } as unknown as Db;
    const svc = productGrabberService(db, { templates: [passthroughTemplate] });

    await expect(svc.extractAndStage(COMPANY_ID, { url: "https://example.com/p/1" }, { userId: USER_ID })).rejects.toThrow(
      /turned off/,
    );
  });

  it("refuses when no template is registered for the host", async () => {
    const db = { select: vi.fn().mockReturnValue(fakeSelectOne({ companyId: COMPANY_ID, enabled: true })) } as unknown as Db;
    const svc = productGrabberService(db, { templates: [] });

    await expect(
      svc.extractAndStage(COMPANY_ID, { url: "https://unknown.example.org/p/1" }, { userId: USER_ID }),
    ).rejects.toThrow(/No product grabber template/);
  });

  it("refuses and logs the blocked fetch when robots.txt disallows the URL", async () => {
    const db = { select: vi.fn().mockReturnValue(fakeSelectOne({ companyId: COMPANY_ID, enabled: true })) } as unknown as Db;
    const crawl = vi.fn();
    const svc = productGrabberService(db, {
      templates: [passthroughTemplate],
      robots: { isAllowed: vi.fn().mockResolvedValue(false) },
      rateLimiter: { waitForTurn: vi.fn().mockResolvedValue(undefined) } as any,
      crawl4ai: { crawl, health: vi.fn() },
    });

    await expect(svc.extractAndStage(COMPANY_ID, { url: "https://example.com/p/1" }, { userId: USER_ID })).rejects.toThrow(
      /robots\.txt/,
    );
    expect(crawl).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      action: "product_grabber_source_fetched",
      details: expect.objectContaining({ blockedByRobotsTxt: true }),
    });
  });

  it("refuses when the fetch itself fails", async () => {
    const db = { select: vi.fn().mockReturnValue(fakeSelectOne({ companyId: COMPANY_ID, enabled: true })) } as unknown as Db;
    const svc = productGrabberService(db, {
      templates: [passthroughTemplate],
      robots: { isAllowed: vi.fn().mockResolvedValue(true) },
      rateLimiter: { waitForTurn: vi.fn().mockResolvedValue(undefined) } as any,
      crawl4ai: {
        crawl: vi.fn().mockResolvedValue({
          url: "https://example.com/p/1",
          success: false,
          statusCode: 503,
          markdown: null,
          html: null,
          links: { internal: [], external: [] },
          error: "upstream unavailable",
        }),
        health: vi.fn(),
      },
    });

    await expect(svc.extractAndStage(COMPANY_ID, { url: "https://example.com/p/1" }, { userId: USER_ID })).rejects.toThrow(
      /upstream unavailable/,
    );
  });

  it("rate-limits per host, fetches, extracts, stages the row, and logs the source fetch", async () => {
    const insertedRow = stagedRow();
    const db = {
      select: vi.fn().mockReturnValue(fakeSelectOne({ companyId: COMPANY_ID, enabled: true })),
      insert: vi.fn().mockReturnValue(fakeInsert(insertedRow)),
    } as unknown as Db;
    const waitForTurn = vi.fn().mockResolvedValue(undefined);
    const crawl = vi.fn().mockResolvedValue({
      url: "https://example.com/p/1",
      success: true,
      statusCode: 200,
      markdown: null,
      html: "<html></html>",
      links: { internal: [], external: [] },
      error: null,
    });
    const svc = productGrabberService(db, {
      templates: [passthroughTemplate],
      robots: { isAllowed: vi.fn().mockResolvedValue(true) },
      rateLimiter: { waitForTurn } as any,
      crawl4ai: { crawl, health: vi.fn() },
    });

    const result = await svc.extractAndStage(COMPANY_ID, { url: "https://example.com/p/1" }, { userId: USER_ID });

    expect(waitForTurn).toHaveBeenCalledWith("example.com");
    expect(crawl).toHaveBeenCalledWith("https://example.com/p/1");
    expect(result.id).toBe("item-1");
    expect(result.status).toBe("pending");
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: USER_ID,
      action: "product_grabber_source_fetched",
      entityType: "product_grabber_source_url",
      details: expect.objectContaining({ url: "https://example.com/p/1", success: true, statusCode: 200 }),
    });
  });
});

describe("productGrabberService.list", () => {
  it("maps rows into the shared staged-item summary shape", async () => {
    const db = { select: vi.fn().mockReturnValue(fakeSelectList([stagedRow()])) } as unknown as Db;
    const svc = productGrabberService(db, { templates: [] });

    const items = await svc.list(COMPANY_ID);

    expect(items).toEqual([
      {
        id: "item-1",
        companyId: COMPANY_ID,
        vendor: "example.com",
        sourceUrl: "https://example.com/p/1",
        rawFields: { title: "Widget" },
        imageUrls: ["https://example.com/img.jpg"],
        status: "pending",
        approvedByUserId: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]);
  });
});

describe("productGrabberService.review", () => {
  it("approves a staged item and records the approving user", async () => {
    const updated = stagedRow({ status: "approved", approvedByUserId: USER_ID });
    const db = { update: vi.fn().mockReturnValue(fakeUpdate(updated)) } as unknown as Db;
    const svc = productGrabberService(db, { templates: [] });

    const result = await svc.review(COMPANY_ID, "item-1", { status: "approved" }, { userId: USER_ID });

    expect(result.status).toBe("approved");
    expect(result.approvedByUserId).toBe(USER_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "product_grabber_item_approved", entityId: "item-1" }),
    );
  });

  it("rejects a staged item without recording an approver", async () => {
    const updated = stagedRow({ status: "rejected", approvedByUserId: null });
    const db = { update: vi.fn().mockReturnValue(fakeUpdate(updated)) } as unknown as Db;
    const svc = productGrabberService(db, { templates: [] });

    const result = await svc.review(COMPANY_ID, "item-1", { status: "rejected" }, { userId: USER_ID });

    expect(result.status).toBe("rejected");
    expect(result.approvedByUserId).toBeNull();
  });

  it("throws not-found when the staged item does not exist in this company", async () => {
    const db = { update: vi.fn().mockReturnValue(fakeUpdate(undefined)) } as unknown as Db;
    const svc = productGrabberService(db, { templates: [] });

    await expect(svc.review(COMPANY_ID, "missing", { status: "approved" }, { userId: USER_ID })).rejects.toThrow(
      /not found/,
    );
  });
});
