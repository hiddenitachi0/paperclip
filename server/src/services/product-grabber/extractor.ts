/**
 * DUR-4187: the vendor-agnostic product extractor interface. A "template"
 * describes how to recognize and parse one vendor's product pages; adding a
 * second vendor means adding a new template to the registry below, never
 * touching this file, the fetch path, or the staging service.
 */

export interface ExtractedProduct {
  vendor: string;
  title: string;
  description: string | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  imageUrls: string[];
  /** The template's own output, as-extracted, for the reviewer to inspect verbatim. */
  rawFields: Record<string, unknown>;
}

export interface ProductExtractorTemplate {
  /** Short vendor id, e.g. "ellos.no". Stored on the staging row. */
  vendor: string;
  /** Whether this template knows how to parse pages at this URL. */
  matches(url: URL): boolean;
  /** Parse one fetched page's HTML into product fields. Throws on a page shape it cannot make sense of. */
  extract(html: string, url: URL): ExtractedProduct;
}

export class NoMatchingTemplateError extends Error {
  constructor(hostname: string) {
    super(`No product grabber template is registered for host "${hostname}".`);
    this.name = "NoMatchingTemplateError";
  }
}

export interface ProductExtractorRegistry {
  templates: readonly ProductExtractorTemplate[];
  findTemplate(url: URL): ProductExtractorTemplate | null;
  extract(html: string, url: URL): ExtractedProduct;
}

export function createProductExtractorRegistry(templates: readonly ProductExtractorTemplate[]): ProductExtractorRegistry {
  function findTemplate(url: URL): ProductExtractorTemplate | null {
    return templates.find((template) => template.matches(url)) ?? null;
  }

  return {
    templates,
    findTemplate,
    extract(html: string, url: URL): ExtractedProduct {
      const template = findTemplate(url);
      if (!template) throw new NoMatchingTemplateError(url.hostname);
      return template.extract(html, url);
    },
  };
}

// ─── JSON-LD helpers (shared across templates; most e-commerce sites embed
// schema.org Product data this way, so templates can start here and fall
// back to CSS selectors only where a vendor's JSON-LD is incomplete) ───────

export interface JsonLdProduct {
  name?: unknown;
  description?: unknown;
  image?: unknown;
  offers?: unknown;
  [key: string]: unknown;
}

function flattenJsonLdNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLdNodes(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  out.push(record);
  if (Array.isArray(record["@graph"])) flattenJsonLdNodes(record["@graph"], out);
}

function isProductType(record: Record<string, unknown>): boolean {
  const type = record["@type"];
  if (typeof type === "string") return type.toLowerCase() === "product";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.toLowerCase() === "product");
  return false;
}

/** Finds every schema.org Product node embedded as JSON-LD in a parsed document. */
export function findJsonLdProducts(document: Document): JsonLdProduct[] {
  const products: JsonLdProduct[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of Array.from(scripts)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    flattenJsonLdNodes(parsed, nodes);
    for (const node of nodes) {
      if (isProductType(node)) products.push(node as JsonLdProduct);
    }
  }
  return products;
}

export function jsonLdImageUrls(image: unknown): string[] {
  if (typeof image === "string") return [image];
  if (Array.isArray(image)) return image.filter((v): v is string => typeof v === "string");
  if (image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string") {
    return [(image as Record<string, unknown>).url as string];
  }
  return [];
}

export function jsonLdOfferPrice(offers: unknown): { amount: number | null; currency: string | null } {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== "object") return { amount: null, currency: null };
  const record = offer as Record<string, unknown>;
  const price = record.price;
  const amount =
    typeof price === "number" ? price : typeof price === "string" && price.trim() !== "" ? Number(price) : null;
  const currency = typeof record.priceCurrency === "string" ? record.priceCurrency : null;
  return { amount: amount !== null && Number.isFinite(amount) ? amount : null, currency };
}
