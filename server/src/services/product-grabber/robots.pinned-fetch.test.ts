import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createPinnedFetch } from "./robots.js";

// Deliberately does NOT mock node:http/node:https. The mocked suite in robots.test.ts
// stubs `request` entirely, so it can't catch a `lookup`-callback signature mismatch with
// Node's real `net` connection logic (autoSelectFamily's Happy Eyeballs path drives `lookup`
// differently than the single-address callback shape used before). This test exercises the
// real Node HTTP client against a real local server to catch that class of regression.
describe("createPinnedFetch against a real local server", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("connects and fetches successfully when pinned to a real vetted address", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nAllow: /");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // Must be a non-literal-IP hostname: Node's `net` connection logic skips calling the
    // custom `lookup` entirely when the hostname is already an IP address, which would hide
    // the autoSelectFamily/lookup-signature mismatch this test exists to catch.
    const pinnedFetch = createPinnedFetch("127.0.0.1", 4);
    const response = await pinnedFetch(`http://pinned-fetch.test:${port}/robots.txt`, {
      headers: { "User-Agent": "TestBot/1.0" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("User-agent: *\nAllow: /");
  });
});
