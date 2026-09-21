import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSafeOutboundFetch,
  isNonPublicAddress,
  isPrivateIP,
  SafeOutboundFetchError,
  SHOPIFY_OUTBOUND_POLICY,
  validateAndResolveFetchUrl,
} from "../services/safe-outbound-fetch.js";
import * as pluginHost from "../services/plugin-host-services.js";

/**
 * DUR-3972 S1 acceptance (c): the outbound-call guard for business-data
 * sources refuses hosts that are not *.myshopify.com, plain http, a host that
 * resolves to a private address, and a redirect to another host.
 *
 * The redirect and size tests run against a real local HTTP server: the
 * request passes the host and address checks exactly as in production (with
 * a DNS answer injected), and only the final socket goes to 127.0.0.1.
 */

const PUBLIC = async () => [{ address: "23.227.38.65", family: 4 }];

async function expectRefusal(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, `expected refusal ${code}`).toBeInstanceOf(SafeOutboundFetchError);
  expect((error as SafeOutboundFetchError).code).toBe(code);
}

describe("DUR-3972 safe outbound fetch (Shopify policy)", () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://evil.example.com/steal" });
        res.end();
        return;
      }
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("x".repeat(SHOPIFY_OUTBOUND_POLICY.maxResponseBytes + 10));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const guarded = (lookup = PUBLIC) =>
    createSafeOutboundFetch(SHOPIFY_OUTBOUND_POLICY, { lookup, testOnlyDial: { host: "127.0.0.1", port } });

  it("lets an allowed https *.myshopify.com request through, pinned, with the original Host header", async () => {
    const response = await guarded()("https://nordstrand-test.myshopify.com/ok");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, host: "nordstrand-test.myshopify.com" });
  });

  it("refuses hosts that are not *.myshopify.com", async () => {
    const fetchImpl = guarded();
    await expectRefusal(fetchImpl("https://example.com/admin"), "host_not_allowed");
    await expectRefusal(fetchImpl("https://myshopify.com/admin"), "host_not_allowed");
    await expectRefusal(fetchImpl("https://shop.myshopify.com.evil.example/admin"), "host_not_allowed");
    await expectRefusal(fetchImpl("https://evil.example/shop.myshopify.com"), "host_not_allowed");
    await expectRefusal(fetchImpl("https://127.0.0.1/admin"), "host_not_allowed");
  });

  it("refuses plain http, a non-standard port, and credentials in the URL", async () => {
    const fetchImpl = guarded();
    await expectRefusal(fetchImpl("http://nordstrand-test.myshopify.com/ok"), "protocol_not_allowed");
    await expectRefusal(fetchImpl("https://nordstrand-test.myshopify.com:8443/ok"), "port_not_allowed");
    await expectRefusal(fetchImpl("https://user:pw@nordstrand-test.myshopify.com/ok"), "credentials_in_url");
  });

  it("refuses a myshopify host that resolves to a private, loopback or tailnet (CGNAT) address", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "192.168.1.10", "169.254.169.254", "100.101.102.103", "::ffff:10.1.2.3"]) {
      const before = hits.length;
      await expectRefusal(
        guarded(async () => [{ address, family: address.includes(":") ? 6 : 4 }])(
          "https://nordstrand-test.myshopify.com/ok",
        ),
        "address_not_public",
      );
      expect(hits.length, `no request may be sent for ${address}`).toBe(before);
    }
  });

  it("refuses a host that resolves to a mix of public and private addresses", async () => {
    await expectRefusal(
      guarded(async () => [
        { address: "23.227.38.65", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ])("https://nordstrand-test.myshopify.com/ok"),
      "address_not_public",
    );
  });

  it("refuses a redirect instead of following it to another host", async () => {
    await expectRefusal(guarded()("https://nordstrand-test.myshopify.com/redirect"), "redirect_refused");
    expect(hits.filter((path) => path === "/steal")).toHaveLength(0);
  });

  it("refuses a response larger than the cap", async () => {
    await expectRefusal(guarded()("https://nordstrand-test.myshopify.com/huge"), "response_too_large");
  });

  it("never puts request headers in a refusal message", async () => {
    const error = await guarded()("https://example.com/", {
      headers: { "X-Shopify-Access-Token": "shp" + "at_supersecretvalue1234567890" },
    }).catch((err: unknown) => err as Error);
    expect(String((error as Error).message)).not.toContain("shp" + "at_");
  });
});

describe("DUR-3972 plugin fetch rule unchanged by the move", () => {
  it("still re-exports the same functions from plugin-host-services", () => {
    expect(pluginHost.isPrivateIP).toBe(isPrivateIP);
    expect(pluginHost.validateAndResolveFetchUrl).toBe(validateAndResolveFetchUrl);
  });

  it("keeps the plugin address rule: private ranges blocked, CGNAT not (unchanged behaviour)", () => {
    expect(isPrivateIP("10.1.2.3")).toBe(true);
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("100.101.102.103")).toBe(false);
    expect(isPrivateIP("23.227.38.65")).toBe(false);
  });

  it("keeps the plugin behaviour of using the public half of a mixed answer", async () => {
    const target = await validateAndResolveFetchUrl("http://example.test/x", {
      lookup: async () => [
        { address: "10.0.0.5", family: 4 },
        { address: "23.227.38.65", family: 4 },
      ],
    });
    expect(target.resolvedAddress).toBe("23.227.38.65");
    expect(target.useTls).toBe(false);
  });

  it("the stricter data-source rule refuses what the plugin rule lets through", () => {
    expect(isNonPublicAddress("100.64.0.1")).toBe(true);
    expect(isNonPublicAddress("0.1.2.3")).toBe(true);
    expect(isNonPublicAddress("224.0.0.1")).toBe(true);
    expect(isNonPublicAddress("ff02::1")).toBe(true);
    expect(isNonPublicAddress("not-an-ip")).toBe(true);
    expect(isNonPublicAddress("23.227.38.65")).toBe(false);
    expect(isNonPublicAddress("2620:127:f00f:5::")).toBe(false);
  });
});
