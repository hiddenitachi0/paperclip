import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPaperlessNgxOutboundPolicy,
  createPinnedInternalFetch,
  SafeOutboundFetchError,
} from "../services/safe-outbound-fetch.js";

/**
 * DUR-4302: the pinned-internal transport behind a `paperless_ngx` connection
 * is the mirror image of the public-only guard (dur3972-safe-outbound-fetch):
 * it may reach only the exact host:port recorded on that company's own
 * connection row, only a private/internal address, and never follows a
 * redirect -- not even to the same host.
 */

const PRIVATE = async () => [{ address: "10.0.0.5", family: 4 }];
const PUBLIC = async () => [{ address: "23.227.38.65", family: 4 }];

async function expectRefusal(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, `expected refusal ${code}`).toBeInstanceOf(SafeOutboundFetchError);
  expect((error as SafeOutboundFetchError).code).toBe(code);
}

describe("DUR-4302 pinned internal fetch (paperless-ngx policy)", () => {
  let server: http.Server;
  let serverPort = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `http://paperless.internal:8123/documents/` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const policy = createPaperlessNgxOutboundPolicy("paperless.internal", 8123);
  const guarded = (lookup = PRIVATE) =>
    createPinnedInternalFetch(policy, { lookup, testOnlyDial: { host: "127.0.0.1", port: serverPort } });

  it("lets the exact pinned host:port through when it resolves to a private address", async () => {
    const response = await guarded()("http://paperless.internal:8123/documents/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, host: "paperless.internal:8123" });
  });

  it("refuses any other host", async () => {
    await expectRefusal(guarded()("http://other.internal:8123/documents/"), "host_not_allowed");
    await expectRefusal(guarded()("http://paperless.internal.evil.example:8123/documents/"), "host_not_allowed");
  });

  it("refuses any other port", async () => {
    await expectRefusal(guarded()("http://paperless.internal:9999/documents/"), "host_not_allowed");
    await expectRefusal(guarded()("http://paperless.internal/documents/"), "host_not_allowed");
  });

  it("refuses https and credentials in the URL", async () => {
    await expectRefusal(guarded()("https://paperless.internal:8123/documents/"), "protocol_not_allowed");
    await expectRefusal(guarded()("http://user:pw@paperless.internal:8123/documents/"), "credentials_in_url");
  });

  it("refuses the pinned host if it resolves to a public address", async () => {
    await expectRefusal(guarded(PUBLIC)("http://paperless.internal:8123/documents/"), "address_not_internal");
  });

  it("never follows a redirect, even to the same pinned host", async () => {
    await expectRefusal(guarded()("http://paperless.internal:8123/redirect"), "redirect_refused");
  });
});
