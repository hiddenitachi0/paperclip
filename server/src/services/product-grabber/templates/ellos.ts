import { JSDOM } from "jsdom";
import {
  findJsonLdProducts,
  jsonLdImageUrls,
  jsonLdOfferPrice,
  type ExtractedProduct,
  type ProductExtractorTemplate,
} from "../extractor.js";

/**
 * DUR-4187: the first concrete product grabber template. ellos.no, like most
 * modern e-commerce platforms, embeds a schema.org `Product` node as
 * JSON-LD on every product page -- that is the primary (and, for v1, only)
 * source this template reads from, since it is both the most stable surface
 * (survives front-end redesigns that would break CSS selectors) and the one
 * Filip's permission to use ellos.no's product images/data was scoped
 * against (the vendor's own structured product data, not arbitrary page
 * scraping).
 *
 * Falls back to an `h1` for the title only when no JSON-LD Product is
 * present, so a page ellos.no has not tagged yet still produces a usable
 * staging row rather than silently failing -- but throws rather than
 * guessing at price/images in that case, since a wrong price or image is
 * worse than a staging row a human has to fill in by hand.
 */
export const ellosProductTemplate: ProductExtractorTemplate = {
  vendor: "ellos.no",

  matches(url: URL): boolean {
    return /(^|\.)ellos\.no$/i.test(url.hostname);
  },

  extract(html: string, url: URL): ExtractedProduct {
    const dom = new JSDOM(html, { url: url.toString() });
    const document = dom.window.document;
    const products = findJsonLdProducts(document);
    const product = products[0];

    const title =
      (typeof product?.name === "string" ? product.name : null) ?? document.querySelector("h1")?.textContent?.trim() ?? null;
    if (!title) {
      throw new Error(`ellos.no template: could not find a product title at ${url.toString()}`);
    }

    const description = typeof product?.description === "string" ? product.description : null;
    const imageUrls = product ? jsonLdImageUrls(product.image) : [];
    const { amount: priceAmount, currency: priceCurrency } = product ? jsonLdOfferPrice(product.offers) : { amount: null, currency: null };

    return {
      vendor: "ellos.no",
      title,
      description,
      priceAmount,
      priceCurrency,
      imageUrls,
      rawFields: {
        sourceUrl: url.toString(),
        jsonLd: product ?? null,
        titleFallbackUsed: !product?.name,
      },
    };
  },
};
