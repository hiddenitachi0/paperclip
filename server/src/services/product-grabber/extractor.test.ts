import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  NoMatchingTemplateError,
  createProductExtractorRegistry,
  findJsonLdProducts,
  jsonLdImageUrls,
  jsonLdOfferPrice,
  type ProductExtractorTemplate,
} from "./extractor.js";

function documentWithJsonLd(json: unknown): Document {
  const dom = new JSDOM(`<script type="application/ld+json">${JSON.stringify(json)}</script>`);
  return dom.window.document;
}

describe("findJsonLdProducts", () => {
  it("finds a top-level Product node", () => {
    const doc = documentWithJsonLd({ "@type": "Product", name: "Chair" });
    expect(findJsonLdProducts(doc)).toEqual([{ "@type": "Product", name: "Chair" }]);
  });

  it("finds a Product nested inside @graph", () => {
    const doc = documentWithJsonLd({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "WebPage" }, { "@type": "Product", name: "Lamp" }],
    });
    expect(findJsonLdProducts(doc)).toEqual([{ "@type": "Product", name: "Lamp" }]);
  });

  it("returns an empty list when there is no Product node", () => {
    const doc = documentWithJsonLd({ "@type": "WebPage" });
    expect(findJsonLdProducts(doc)).toEqual([]);
  });

  it("ignores a script tag with invalid JSON instead of throwing", () => {
    const dom = new JSDOM(`<script type="application/ld+json">{not json}</script>`);
    expect(findJsonLdProducts(dom.window.document)).toEqual([]);
  });
});

describe("jsonLdImageUrls", () => {
  it("handles a single string, an array, and an ImageObject", () => {
    expect(jsonLdImageUrls("https://x/1.jpg")).toEqual(["https://x/1.jpg"]);
    expect(jsonLdImageUrls(["https://x/1.jpg", "https://x/2.jpg"])).toEqual(["https://x/1.jpg", "https://x/2.jpg"]);
    expect(jsonLdImageUrls({ "@type": "ImageObject", url: "https://x/1.jpg" })).toEqual(["https://x/1.jpg"]);
    expect(jsonLdImageUrls(undefined)).toEqual([]);
  });
});

describe("jsonLdOfferPrice", () => {
  it("reads price and currency off a single offer or the first of an array", () => {
    expect(jsonLdOfferPrice({ price: "199.00", priceCurrency: "NOK" })).toEqual({ amount: 199, currency: "NOK" });
    expect(jsonLdOfferPrice([{ price: 50, priceCurrency: "USD" }, { price: 60, priceCurrency: "USD" }])).toEqual({
      amount: 50,
      currency: "USD",
    });
    expect(jsonLdOfferPrice(undefined)).toEqual({ amount: null, currency: null });
    expect(jsonLdOfferPrice({ price: "not-a-number" })).toEqual({ amount: null, currency: null });
  });
});

describe("createProductExtractorRegistry", () => {
  const fakeTemplate: ProductExtractorTemplate = {
    vendor: "example.com",
    matches: (url) => url.hostname.endsWith("example.com"),
    extract: () => ({
      vendor: "example.com",
      title: "Widget",
      description: null,
      priceAmount: null,
      priceCurrency: null,
      imageUrls: [],
      rawFields: {},
    }),
  };

  it("finds the matching template by hostname", () => {
    const registry = createProductExtractorRegistry([fakeTemplate]);
    expect(registry.findTemplate(new URL("https://shop.example.com/p/1"))).toBe(fakeTemplate);
    expect(registry.findTemplate(new URL("https://other.com/p/1"))).toBeNull();
  });

  it("extracts via the matching template", () => {
    const registry = createProductExtractorRegistry([fakeTemplate]);
    const result = registry.extract("<html></html>", new URL("https://shop.example.com/p/1"));
    expect(result.title).toBe("Widget");
  });

  it("throws NoMatchingTemplateError when no template matches the host", () => {
    const registry = createProductExtractorRegistry([fakeTemplate]);
    expect(() => registry.extract("<html></html>", new URL("https://unknown.example.org/p/1"))).toThrow(
      NoMatchingTemplateError,
    );
  });

  it("adding a template to the registry array is the only step -- no core-code change needed", () => {
    const secondVendor: ProductExtractorTemplate = {
      vendor: "second.com",
      matches: (url) => url.hostname.endsWith("second.com"),
      extract: () => ({
        vendor: "second.com",
        title: "Gadget",
        description: null,
        priceAmount: null,
        priceCurrency: null,
        imageUrls: [],
        rawFields: {},
      }),
    };
    const registry = createProductExtractorRegistry([fakeTemplate, secondVendor]);
    expect(registry.extract("<html></html>", new URL("https://second.com/p/1")).title).toBe("Gadget");
  });
});
