import { describe, expect, it, vi } from "vitest";
import { createRobotsTxtChecker, parseRobotsTxt } from "./robots.js";

describe("parseRobotsTxt", () => {
  it("allows everything when the file is empty", () => {
    const robots = parseRobotsTxt("");
    expect(robots.isAllowed("/anything", "MyBot")).toBe(true);
  });

  it("disallows everything under a wildcard Disallow: /", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /");
    expect(robots.isAllowed("/products/123", "MyBot")).toBe(false);
  });

  it("lets a longer Allow override a shorter Disallow", () => {
    const robots = parseRobotsTxt(["User-agent: *", "Disallow: /private", "Allow: /private/public"].join("\n"));
    expect(robots.isAllowed("/private/secret", "MyBot")).toBe(false);
    expect(robots.isAllowed("/private/public/page", "MyBot")).toBe(true);
  });

  it("an empty Disallow value means allow everything", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow:");
    expect(robots.isAllowed("/anything", "MyBot")).toBe(true);
  });

  it("prefers a group matching our own user agent over the wildcard group", () => {
    const robots = parseRobotsTxt(
      ["User-agent: mybot", "Disallow: /no-bots", "", "User-agent: *", "Disallow: /"].join("\n"),
    );
    expect(robots.isAllowed("/other-page", "MyBot/1.0")).toBe(true);
    expect(robots.isAllowed("/no-bots/x", "MyBot/1.0")).toBe(false);
  });

  it("merges consecutive User-agent lines into one group", () => {
    const robots = parseRobotsTxt(["User-agent: a", "User-agent: b", "Disallow: /x"].join("\n"));
    expect(robots.isAllowed("/x/1", "b-crawler")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const robots = parseRobotsTxt(["# a comment", "", "User-agent: *", "Disallow: /blocked # trailing comment"].join("\n"));
    expect(robots.isAllowed("/blocked", "MyBot")).toBe(false);
    expect(robots.isAllowed("/open", "MyBot")).toBe(true);
  });
});

describe("createRobotsTxtChecker", () => {
  it("fetches robots.txt for the URL's origin and evaluates the path against it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("User-agent: *\nDisallow: /blocked", { status: 200 }));
    const checker = createRobotsTxtChecker({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as any });

    expect(await checker.isAllowed("https://example.com/blocked/page")).toBe(false);
    expect(await checker.isAllowed("https://example.com/open/page")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/robots.txt", { headers: { "User-Agent": "TestBot/1.0" } });
  });

  it("caches the parsed robots.txt per origin instead of refetching every call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("User-agent: *\nDisallow:", { status: 200 }));
    const checker = createRobotsTxtChecker({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as any });

    await checker.isAllowed("https://example.com/a");
    await checker.isAllowed("https://example.com/b");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails open (allows) when the fetch throws or 404s", async () => {
    const notFound = createRobotsTxtChecker({
      userAgent: "TestBot/1.0",
      fetchImpl: vi.fn().mockResolvedValue(new Response("", { status: 404 })) as any,
    });
    expect(await notFound.isAllowed("https://example.com/anything")).toBe(true);

    const networkError = createRobotsTxtChecker({
      userAgent: "TestBot/1.0",
      fetchImpl: vi.fn().mockRejectedValue(new Error("network down")) as any,
    });
    expect(await networkError.isAllowed("https://example.com/anything")).toBe(true);
  });

  it("never fetches robots.txt directly when the hostname resolves to a private/loopback/metadata address", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("User-agent: *\nDisallow: /", { status: 200 }));
    const lookupImpl = vi.fn().mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const checker = createRobotsTxtChecker({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as any, lookupImpl });

    // Allowed (fails open on the skipped robots fetch), and -- the actual security property --
    // no direct request was ever issued to the resolved internal address.
    expect(await checker.isAllowed("https://rebinds-to-metadata.example.com/anything")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupImpl).toHaveBeenCalledWith("rebinds-to-metadata.example.com");
  });

  it("fetches normally when the hostname resolves to a public address", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("User-agent: *\nDisallow: /blocked", { status: 200 }));
    const lookupImpl = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const checker = createRobotsTxtChecker({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as any, lookupImpl });

    expect(await checker.isAllowed("https://example.com/blocked")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/robots.txt", { headers: { "User-Agent": "TestBot/1.0" } });
  });
});
