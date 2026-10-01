import { describe, expect, it, vi } from "vitest";

const httpRequestMock = vi.fn();
vi.mock("node:http", () => ({ request: (...args: unknown[]) => httpRequestMock(...args) }));
vi.mock("node:https", () => ({ request: (...args: unknown[]) => httpRequestMock(...args) }));

const { createPinnedFetch, createRobotsTxtChecker, isDisallowedAddress, parseRobotsTxt } = await import("./robots.js");

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

  it("never falls back to an unpinned fetch when DNS resolution itself fails", async () => {
    // A thrown/rejected lookup is not proof the hostname is unreachable -- a resolver hiccup
    // on this one lookup doesn't guarantee a later, independent resolution (e.g. by a plain
    // `fetch`) would also fail. Falling back to an unpinned fetch here would resurrect the
    // exact TOCTOU gap this module exists to close.
    const fetchImpl = vi.fn().mockResolvedValue(new Response("User-agent: *\nDisallow: /", { status: 200 }));
    const lookupImpl = vi.fn().mockRejectedValue(new Error("resolver hiccup"));
    const checker = createRobotsTxtChecker({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as any, lookupImpl });

    expect(await checker.isAllowed("https://flaky-resolver.example.com/anything")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("isDisallowedAddress", () => {
  it("disallows IPv4 loopback/private/link-local addresses", () => {
    expect(isDisallowedAddress("127.0.0.1", 4)).toBe(true);
    expect(isDisallowedAddress("169.254.169.254", 4)).toBe(true);
    expect(isDisallowedAddress("93.184.216.34", 4)).toBe(false);
  });

  it("disallows IPv4-mapped IPv6 addresses by unwrapping to the embedded IPv4 address", () => {
    // "::ffff:a.b.c.d" is a live, routable alias for the IPv4 address -- not just a string
    // that happens to look similar. An attacker-controlled DNS zone can return this as an
    // AAAA record to reach loopback/private/metadata addresses once pinning is wired up.
    expect(isDisallowedAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isDisallowedAddress("::ffff:169.254.169.254", 6)).toBe(true);
    expect(isDisallowedAddress("::ffff:10.0.0.5", 6)).toBe(true);
    expect(isDisallowedAddress("::ffff:93.184.216.34", 6)).toBe(false);
  });

  it("still disallows the native IPv6 loopback/link-local/unique-local ranges", () => {
    expect(isDisallowedAddress("::1", 6)).toBe(true);
    expect(isDisallowedAddress("fe80::1", 6)).toBe(true);
    expect(isDisallowedAddress("fc00::1", 6)).toBe(true);
    expect(isDisallowedAddress("fd00::1", 6)).toBe(true);
    expect(isDisallowedAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
});

describe("createPinnedFetch (DNS-rebinding TOCTOU close)", () => {
  it("pins the TCP connection to the checked address, ignoring any attacker-controlled re-resolution at connect time", async () => {
    // This is the actual security property: once an address has been vetted, the real
    // request must not let the HTTP client re-resolve the hostname on its own -- that
    // second, independent resolution is exactly what a DNS-rebinding attacker flips.
    httpRequestMock.mockImplementation((_opts: any, cb: any) => {
      // Simulate an attacker-controlled resolver: if the pinned `lookup` were bypassed
      // and the real hostname were re-resolved here, this would be the rebind target.
      _opts.lookup("attacker-controlled-hostname.example.com", {}, (err: Error | null, address: string, family: number) => {
        expect(err).toBeNull();
        expect(address).toBe("93.184.216.34"); // must stay pinned, never the attacker's answer
        expect(family).toBe(4);
      });
      const fakeRes: any = {
        statusCode: 200,
        on: (event: string, handler: (arg?: unknown) => void) => {
          if (event === "data") handler(Buffer.from("User-agent: *\nAllow: /"));
          if (event === "end") handler();
          return fakeRes;
        },
      };
      cb(fakeRes);
      const fakeReq: any = { on: () => fakeReq, end: () => {} };
      return fakeReq;
    });

    const pinnedFetch = createPinnedFetch("93.184.216.34", 4);
    const response = await pinnedFetch("https://example.com/robots.txt", { headers: { "User-Agent": "TestBot/1.0" } });
    expect(response.ok).toBe(true);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    const calledOpts = httpRequestMock.mock.calls[0][0] as any;
    expect(calledOpts.hostname).toBe("example.com"); // Host/SNI stays the real hostname
  });
});
