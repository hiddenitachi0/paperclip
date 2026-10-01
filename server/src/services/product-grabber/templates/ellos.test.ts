import { describe, expect, it } from "vitest";
import { ellosProductTemplate } from "./ellos.js";

const PRODUCT_URL = new URL("https://www.ellos.no/produkter/sofa-123");

function pageWithJsonLd(json: unknown, extraHtml = ""): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body>${extraHtml}</body></html>`;
}

describe("ellosProductTemplate.matches", () => {
  it("matches ellos.no and its subdomains", () => {
    expect(ellosProductTemplate.matches(new URL("https://ellos.no/p/1"))).toBe(true);
    expect(ellosProductTemplate.matches(new URL("https://www.ellos.no/p/1"))).toBe(true);
  });

  it("does not match other hosts, including look-alikes", () => {
    expect(ellosProductTemplate.matches(new URL("https://not-ellos.no/p/1"))).toBe(false);
    expect(ellosProductTemplate.matches(new URL("https://ellos.no.evil.example/p/1"))).toBe(false);
    expect(ellosProductTemplate.matches(new URL("https://example.com/p/1"))).toBe(false);
  });
});

describe("ellosProductTemplate.extract", () => {
  it("extracts title, description, price, and images from a schema.org Product JSON-LD block", () => {
    const html = pageWithJsonLd({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "3-seter sofa",
      description: "En behagelig sofa i grått stoff.",
      image: ["https://www.ellos.no/img/1.jpg", "https://www.ellos.no/img/2.jpg"],
      offers: { "@type": "Offer", price: "4999.00", priceCurrency: "NOK" },
    });

    const result = ellosProductTemplate.extract(html, PRODUCT_URL);

    expect(result).toMatchObject({
      vendor: "ellos.no",
      title: "3-seter sofa",
      description: "En behagelig sofa i grått stoff.",
      priceAmount: 4999,
      priceCurrency: "NOK",
      imageUrls: ["https://www.ellos.no/img/1.jpg", "https://www.ellos.no/img/2.jpg"],
    });
    expect(result.rawFields.titleFallbackUsed).toBe(false);
  });

  it("falls back to the page's h1 for the title when there is no JSON-LD Product", () => {
    const html = `<!doctype html><html><body><h1>Lenestol Oslo</h1></body></html>`;
    const result = ellosProductTemplate.extract(html, PRODUCT_URL);
    expect(result.title).toBe("Lenestol Oslo");
    expect(result.priceAmount).toBeNull();
    expect(result.imageUrls).toEqual([]);
    expect(result.rawFields.titleFallbackUsed).toBe(true);
  });

  it("throws when neither JSON-LD nor an h1 gives a title", () => {
    const html = `<!doctype html><html><body><p>No title here.</p></body></html>`;
    expect(() => ellosProductTemplate.extract(html, PRODUCT_URL)).toThrow(/could not find a product title/);
  });
});
