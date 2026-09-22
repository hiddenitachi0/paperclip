import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSafeOutboundFetch,
  createWooCommerceOutboundPolicy,
  FIKEN_OUTBOUND_POLICY,
  SafeOutboundFetchError,
  SHOPIFY_OUTBOUND_POLICY,
  type OutboundHostPolicy,
} from "../services/safe-outbound-fetch.js";
import { getDataSourceKind } from "../services/data-sources/registry.js";

/**
 * DUR-3997 slice 3: the outbound guard holds one host pattern per source
 * kind. WooCommerce's is the operator's own store host, exactly and nothing
 * else; Fiken's is fixed to api.fiken.no; Shopify's is unchanged. The SSRF
 * checks (public address only, https only, port 443 only, no redirects) apply
 * to every kind the same way.
 *
 * Requests that pass every check end at a local HTTP server through the
 * guard's test-only dial override; refused requests never reach it.
 */

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

async function expectRefusal(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (err: unknown) => err);
  expect(error, `expected refusal ${code}`).toBeInstanceOf(SafeOutboundFetchError);
  expect((error as SafeOutboundFetchError).code).toBe(code);
}

describe("DUR-3997 outbound policies per source kind", () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url ?? ""}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const guarded = (policy: OutboundHostPolicy, lookup = PUBLIC) =>
    createSafeOutboundFetch(policy, { lookup, testOnlyDial: { host: "127.0.0.1", port } });

  describe("WooCommerce: the store host saved on the connection, and only that", () => {
    it("builds a policy from a valid https store URL and lets that one host through", async () => {
      const policy = createWooCommerceOutboundPolicy("https://Butikken.no/wp-admin/");
      expect(policy.sourceKind).toBe("woocommerce");
      expect(policy.protocols).toEqual(["https:"]);
      const response = await guarded(policy)("https://butikken.no/wp-json/wc/v3/orders?per_page=1");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, host: "butikken.no" });
    });

    it("refuses every other host, including subdomains, look-alikes and other kinds' hosts", async () => {
      const fetchImpl = guarded(createWooCommerceOutboundPolicy("https://butikken.no"));
      for (const url of [
        "https://shop.butikken.no/wp-json/",
        "https://butikken.no.evil.example/wp-json/",
        "https://evil.example/butikken.no",
        "https://butikken.com/wp-json/",
        "https://api.fiken.no/api/v2/companies",
        "https://nordstrand.myshopify.com/admin/api/2026-07/graphql.json",
        "https://127.0.0.1/wp-json/",
      ]) {
        const before = hits.length;
        await expectRefusal(fetchImpl(url), "host_not_allowed");
        expect(hits.length, `no request may be sent for ${url}`).toBe(before);
      }
    });

    it("keeps the SSRF checks: plain http, another port, credentials in the URL, private or mixed DNS answers", async () => {
      const policy = createWooCommerceOutboundPolicy("https://butikken.no");
      await expectRefusal(guarded(policy)("http://butikken.no/wp-json/"), "protocol_not_allowed");
      await expectRefusal(guarded(policy)("https://butikken.no:8443/wp-json/"), "port_not_allowed");
      await expectRefusal(guarded(policy)("https://user:pw@butikken.no/wp-json/"), "credentials_in_url");
      for (const address of ["10.0.0.5", "127.0.0.1", "192.168.1.10", "169.254.169.254", "100.101.102.103", "::ffff:10.1.2.3"]) {
        const before = hits.length;
        await expectRefusal(
          guarded(policy, async () => [{ address, family: address.includes(":") ? 6 : 4 }])("https://butikken.no/wp-json/"),
          "address_not_public",
        );
        expect(hits.length, `no request may be sent for ${address}`).toBe(before);
      }
      await expectRefusal(
        guarded(policy, async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ])("https://butikken.no/wp-json/"),
        "address_not_public",
      );
    });

    it("refuses to build a policy from a store URL that is not a public https address", () => {
      for (const bad of [
        "http://butikken.no",
        "https://butikken.no:8443",
        "https://user:pw@butikken.no",
        "https://10.0.0.5",
        "https://[::1]",
        "https://localhost",
        "https://intranett",
        "https://nas.local",
        "https://butikken.internal",
        "ftp://butikken.no",
        "not a url",
        "",
      ]) {
        let error: unknown = null;
        try {
          createWooCommerceOutboundPolicy(bad);
        } catch (err) {
          error = err;
        }
        expect(error, `should refuse ${JSON.stringify(bad)}`).toBeInstanceOf(SafeOutboundFetchError);
        expect((error as SafeOutboundFetchError).code).toBe("host_not_allowed");
      }
    });

    it("is what the registry hands out for a WooCommerce connection", () => {
      const policy = getDataSourceKind("woocommerce").outboundPolicy({ kind: "woocommerce", storeUrl: "https://butikken.no" });
      expect(policy?.hostPattern.test("butikken.no")).toBe(true);
      expect(policy?.hostPattern.test("xbutikken.no")).toBe(false);
      expect(policy?.hostPattern.test("butikken.nox")).toBe(false);
      // A regex-special character in the host is matched literally, never as a pattern.
      const dotted = createWooCommerceOutboundPolicy("https://shop.butikken.no");
      expect(dotted.hostPattern.test("shopxbutikken.no")).toBe(false);
    });
  });

  describe("Fiken: fixed to api.fiken.no", () => {
    it("lets api.fiken.no through and refuses everything else", async () => {
      const fetchImpl = guarded(FIKEN_OUTBOUND_POLICY);
      const response = await fetchImpl("https://api.fiken.no/api/v2/companies");
      expect(response.status).toBe(200);
      for (const url of ["https://fiken.no/", "https://api.fiken.no.evil.example/", "https://apixfiken.no/", "https://www.api.fiken.no/"]) {
        await expectRefusal(fetchImpl(url), "host_not_allowed");
      }
      await expectRefusal(fetchImpl("http://api.fiken.no/api/v2/companies"), "protocol_not_allowed");
      expect(getDataSourceKind("fiken").outboundPolicy({ kind: "fiken", companySlug: "x" })).toBe(FIKEN_OUTBOUND_POLICY);
    });
  });

  describe("Shopify: unchanged", () => {
    it("still allows *.myshopify.com only", async () => {
      const fetchImpl = guarded(SHOPIFY_OUTBOUND_POLICY);
      expect((await fetchImpl("https://nordstrand-test.myshopify.com/ok")).status).toBe(200);
      await expectRefusal(fetchImpl("https://butikken.no/wp-json/"), "host_not_allowed");
      expect(getDataSourceKind("shopify").outboundPolicy({ kind: "shopify" })).toBe(SHOPIFY_OUTBOUND_POLICY);
    });
  });

  it("SFTP files have no HTTP policy in this slice: nothing opens a socket for them", () => {
    expect(
      getDataSourceKind("sftp_file").outboundPolicy({ kind: "sftp_file", host: "filer.butikken.no", port: 22, username: "u", remotePath: "/" }),
    ).toBeNull();
  });
});
