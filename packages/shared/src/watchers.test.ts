import { describe, expect, it } from "vitest";
import { createWatcherSchema, watcherWebPageUrlProblem } from "./watchers.js";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

describe("watcherWebPageUrlProblem", () => {
  it("accepts an ordinary public https URL", () => {
    expect(watcherWebPageUrlProblem("https://example.com/product/123")).toBeNull();
  });

  it("rejects a non-http(s) scheme", () => {
    expect(watcherWebPageUrlProblem("file:///etc/passwd")).not.toBeNull();
  });

  it("rejects localhost", () => {
    expect(watcherWebPageUrlProblem("http://localhost:8080/admin")).not.toBeNull();
  });

  it("rejects the cloud metadata address", () => {
    expect(watcherWebPageUrlProblem("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
  });

  it("rejects loopback, private, and link-local IPv4 ranges", () => {
    expect(watcherWebPageUrlProblem("http://127.0.0.1/")).not.toBeNull();
    expect(watcherWebPageUrlProblem("http://10.0.0.5/")).not.toBeNull();
    expect(watcherWebPageUrlProblem("http://172.16.0.5/")).not.toBeNull();
    expect(watcherWebPageUrlProblem("http://192.168.1.1/")).not.toBeNull();
  });

  it("rejects IPv6 loopback and link-local", () => {
    expect(watcherWebPageUrlProblem("http://[::1]/")).not.toBeNull();
    expect(watcherWebPageUrlProblem("http://[fe80::1]/")).not.toBeNull();
  });

  it("rejects an unparseable string", () => {
    expect(watcherWebPageUrlProblem("not a url")).not.toBeNull();
  });
});

describe("createWatcherSchema cross-field rule/source check", () => {
  it("accepts a web_page source with a web-page rule", () => {
    const result = createWatcherSchema.safeParse({
      name: "Competitor price",
      agentId: AGENT_ID,
      source: "web_page",
      symbol: "Competitor product page",
      rule: { kind: "price", url: "https://example.com/p", selector: ".price", direction: "below", targetPrice: 100, currency: "USD" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a web_page source with a numeric (change/level) rule", () => {
    const result = createWatcherSchema.safeParse({
      name: "Competitor price",
      agentId: AGENT_ID,
      source: "web_page",
      symbol: "Competitor product page",
      rule: { kind: "change", percent: 5 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-web_page source with a web-page rule", () => {
    const result = createWatcherSchema.safeParse({
      name: "Bitcoin",
      agentId: AGENT_ID,
      source: "crypto",
      symbol: "BTC",
      rule: { kind: "stock", url: "https://example.com/p", selector: ".buy", inStockPhrase: "Add to cart", alertWhen: "becomes_in_stock" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a web-page price rule whose url is a private address", () => {
    const result = createWatcherSchema.safeParse({
      name: "Internal",
      agentId: AGENT_ID,
      source: "web_page",
      symbol: "Internal page",
      rule: { kind: "price", url: "http://10.0.0.5/price", selector: ".price", direction: "below", targetPrice: 100, currency: "USD" },
    });
    expect(result.success).toBe(false);
  });
});
