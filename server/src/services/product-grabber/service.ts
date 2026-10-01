/**
 * DUR-4187: orchestrates one product grabber extraction end to end --
 * feature flag check, template lookup, robots.txt check, per-host rate
 * limit, fetch via the shared Crawl4AI client (DUR-4161), template parse,
 * staging row write, and an audit log entry for the source URL fetched.
 * Also owns the staging list's read/review paths.
 *
 * The grabber never writes anywhere but this staging table -- publishing an
 * approved row to a storefront is explicitly out of scope here (see
 * doc/plans/2026-09-30-web-data-engine-crawl4ai-watchers-product-grabber.md
 * §3).
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { productGrabberStagedItems } from "@paperclipai/db";
import {
  PRODUCT_GRABBER_STAGING_STATUSES,
  type ExtractProductGrabberUrlInput,
  type ProductGrabberStagedItemSummary,
  type ProductGrabberStagingStatus,
  type ReviewProductGrabberStagedItemInput,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { createCrawl4aiClientFromEnv, type Crawl4aiClient } from "../crawl4ai-client.js";
import { createProductExtractorRegistry, type ProductExtractorTemplate } from "./extractor.js";
import { createRobotsTxtChecker, type RobotsTxtChecker } from "./robots.js";
import { PerHostRateLimiter } from "./rate-limiter.js";
import { productGrabberSettingsService } from "./settings.js";
import { ellosProductTemplate } from "./templates/ellos.js";

export const PRODUCT_GRABBER_USER_AGENT = "PaperclipProductGrabberBot/1.0 (+https://paperclip.ing)";
export const PRODUCT_GRABBER_MIN_HOST_INTERVAL_MS = 3_000;

export const DEFAULT_PRODUCT_EXTRACTOR_TEMPLATES: readonly ProductExtractorTemplate[] = [ellosProductTemplate];

type StagedItemRow = typeof productGrabberStagedItems.$inferSelect;

export interface ProductGrabberActor {
  userId: string | null;
}

export interface ProductGrabberServiceDeps {
  crawl4ai?: Crawl4aiClient;
  templates?: readonly ProductExtractorTemplate[];
  robots?: RobotsTxtChecker;
  rateLimiter?: PerHostRateLimiter;
}

function toSummary(row: StagedItemRow): ProductGrabberStagedItemSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    vendor: row.vendor,
    sourceUrl: row.sourceUrl,
    rawFields: row.rawFields,
    imageUrls: row.imageUrls,
    status: row.status as ProductGrabberStagingStatus,
    approvedByUserId: row.approvedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function productGrabberService(db: Db, deps: ProductGrabberServiceDeps = {}) {
  const crawl4ai = deps.crawl4ai ?? createCrawl4aiClientFromEnv();
  const registry = createProductExtractorRegistry(deps.templates ?? DEFAULT_PRODUCT_EXTRACTOR_TEMPLATES);
  const robots = deps.robots ?? createRobotsTxtChecker({ userAgent: PRODUCT_GRABBER_USER_AGENT });
  const rateLimiter = deps.rateLimiter ?? new PerHostRateLimiter(PRODUCT_GRABBER_MIN_HOST_INTERVAL_MS);
  const settings = productGrabberSettingsService(db);

  async function logSourceFetch(
    companyId: string,
    actor: ProductGrabberActor,
    details: Record<string, unknown>,
  ): Promise<void> {
    await logActivity(db, {
      companyId,
      actorType: actor.userId ? "user" : "system",
      actorId: actor.userId ?? "product-grabber",
      action: "product_grabber_source_fetched",
      entityType: "product_grabber_source_url",
      entityId: String(details.url),
      details,
    });
  }

  async function extractAndStage(
    companyId: string,
    input: ExtractProductGrabberUrlInput,
    actor: ProductGrabberActor,
  ): Promise<ProductGrabberStagedItemSummary> {
    const { enabled } = await settings.get(companyId);
    if (!enabled) throw forbidden("Product grabber is turned off for this company. Turn it on before fetching products.");

    const url = new URL(input.url);
    const template = registry.findTemplate(url);
    if (!template) throw unprocessable(`No product grabber template is registered for "${url.hostname}" yet.`);

    const allowed = await robots.isAllowed(input.url);
    if (!allowed) {
      await logSourceFetch(companyId, actor, { url: input.url, vendor: template.vendor, blockedByRobotsTxt: true });
      throw forbidden(`robots.txt for ${url.hostname} disallows fetching ${input.url}.`);
    }

    await rateLimiter.waitForTurn(url.hostname);
    const result = await crawl4ai.crawl(input.url);

    await logSourceFetch(companyId, actor, {
      url: input.url,
      vendor: template.vendor,
      success: result.success,
      statusCode: result.statusCode,
    });

    if (!result.success || !result.html) {
      throw unprocessable(`Fetching ${input.url} failed${result.error ? `: ${result.error}` : "."}`);
    }

    const extracted = registry.extract(result.html, url);
    const [row] = await db
      .insert(productGrabberStagedItems)
      .values({
        companyId,
        vendor: extracted.vendor,
        sourceUrl: input.url,
        rawFields: {
          title: extracted.title,
          description: extracted.description,
          priceAmount: extracted.priceAmount,
          priceCurrency: extracted.priceCurrency,
          ...extracted.rawFields,
        },
        imageUrls: extracted.imageUrls,
        status: "pending",
      })
      .returning();

    return toSummary(row);
  }

  async function list(companyId: string, status?: ProductGrabberStagingStatus): Promise<ProductGrabberStagedItemSummary[]> {
    const conditions = status
      ? and(eq(productGrabberStagedItems.companyId, companyId), eq(productGrabberStagedItems.status, status))
      : eq(productGrabberStagedItems.companyId, companyId);
    const rows = await db
      .select()
      .from(productGrabberStagedItems)
      .where(conditions)
      .orderBy(desc(productGrabberStagedItems.createdAt));
    return rows.map(toSummary);
  }

  async function review(
    companyId: string,
    itemId: string,
    input: ReviewProductGrabberStagedItemInput,
    actor: ProductGrabberActor,
  ): Promise<ProductGrabberStagedItemSummary> {
    const [row] = await db
      .update(productGrabberStagedItems)
      .set({
        status: input.status,
        approvedByUserId: input.status === "approved" ? actor.userId : null,
        updatedAt: new Date(),
      })
      .where(and(eq(productGrabberStagedItems.id, itemId), eq(productGrabberStagedItems.companyId, companyId)))
      .returning();
    if (!row) throw notFound("That staged product was not found.");

    await logActivity(db, {
      companyId,
      actorType: actor.userId ? "user" : "system",
      actorId: actor.userId ?? "product-grabber",
      action: input.status === "approved" ? "product_grabber_item_approved" : "product_grabber_item_rejected",
      entityType: "product_grabber_staged_item",
      entityId: row.id,
      details: { sourceUrl: row.sourceUrl, vendor: row.vendor },
    });

    return toSummary(row);
  }

  return { settings, extractAndStage, list, review };
}

export type ProductGrabberService = ReturnType<typeof productGrabberService>;
export { PRODUCT_GRABBER_STAGING_STATUSES };
