import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSafeOutboundFetch,
  executePinnedHttpRequest,
  SHOPIFY_OUTBOUND_POLICY,
  type ValidatedFetchTarget,
} from "../services/safe-outbound-fetch.js";

/**
 * Pictures downloaded through the host's outbound fetch arrived damaged: the
 * body was turned into UTF-8 text, so every byte that is not valid UTF-8 (most
 * of a JPEG or PNG) became a replacement character. The exact bytes are now
 * kept alongside the text.
 */

// A JPEG header plus bytes that are not valid UTF-8 on their own.
const PICTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0x81, 0xfe, 0xff, 0xc0, 0x00]);

describe("host outbound fetch keeps binary bodies exact", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(PICTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns the picture bytes exactly, next to the (lossy) text", async () => {
    const target: ValidatedFetchTarget = {
      parsedUrl: new URL("https://pictures.example.com/p.jpg"),
      resolvedAddress: "93.184.216.34",
      hostHeader: "pictures.example.com",
      tlsServername: "pictures.example.com",
      useTls: true,
    };

    const response = await executePinnedHttpRequest(target, undefined, new AbortController().signal, {
      testOnlyDial: { host: "127.0.0.1", port },
    });

    expect(Buffer.compare(response.bodyBytes, PICTURE)).toBe(0);
    // The text form is what used to be handed to plugins: it is not the picture.
    expect(Buffer.from(response.body, "utf8").equals(PICTURE)).toBe(false);
  });

  it("the guarded fetch (API tools, data sources) gives back the exact bytes too", async () => {
    const guarded = createSafeOutboundFetch(SHOPIFY_OUTBOUND_POLICY, {
      lookup: async () => [{ address: "23.227.38.65", family: 4 }],
      testOnlyDial: { host: "127.0.0.1", port },
    });

    const response = await guarded("https://shop.myshopify.com/picture.jpg");
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(Buffer.compare(bytes, PICTURE)).toBe(0);
  });
});
