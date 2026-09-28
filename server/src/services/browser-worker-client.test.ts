import { describe, expect, it, vi } from "vitest";
import {
  HttpBrowserWorkerClient,
  UnconfiguredBrowserWorkerClient,
  BrowserWorkerNotConfiguredError,
  createBrowserWorkerClientFromEnv,
  type BrowserWorkerClient,
} from "./browser-worker-client.js";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("HttpBrowserWorkerClient", () => {
  it("sends the bearer token and posts to the right path", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ tree: "t", url: "https://x", title: "X" }));
    const client = new HttpBrowserWorkerClient({ baseUrl: "http://worker.internal:9000", token: "secret-token", fetchImpl: fetchImpl as any });

    const result = await client.navigate("session-1", "https://x");

    expect(result).toEqual({ tree: "t", url: "https://x", title: "X" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://worker.internal:9000/sessions/session-1/navigate");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body)).toEqual({ url: "https://x" });
  });

  it("throws with the worker's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ error: "no such session" }, 404));
    const client = new HttpBrowserWorkerClient({ baseUrl: "http://worker.internal:9000", token: "t", fetchImpl: fetchImpl as any });

    await expect(client.snapshot("gone")).rejects.toThrow("no such session");
  });

  it("base64-decodes the screenshot payload into bytes", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ base64: Buffer.from("png-bytes").toString("base64") }));
    const client = new HttpBrowserWorkerClient({ baseUrl: "http://worker.internal:9000", token: "t", fetchImpl: fetchImpl as any });

    const bytes = await client.screenshot("session-1");

    expect(Buffer.from(bytes).toString()).toBe("png-bytes");
  });
});

describe("UnconfiguredBrowserWorkerClient", () => {
  it("refuses every call", async () => {
    const client: BrowserWorkerClient = new UnconfiguredBrowserWorkerClient();
    await expect(client.openSession({ agentId: "a", companyId: "c", purpose: "test" })).rejects.toBeInstanceOf(
      BrowserWorkerNotConfiguredError,
    );
    await expect(client.close("x")).rejects.toBeInstanceOf(BrowserWorkerNotConfiguredError);
  });
});

describe("createBrowserWorkerClientFromEnv", () => {
  it("returns the unconfigured client when the env vars are unset", () => {
    const client = createBrowserWorkerClientFromEnv({});
    expect(client).toBeInstanceOf(UnconfiguredBrowserWorkerClient);
  });

  it("returns an HTTP client when both env vars are set", () => {
    const client = createBrowserWorkerClientFromEnv({
      PAPERCLIP_SERVER_BROWSER_WORKER_URL: "http://worker.internal:9000",
      PAPERCLIP_SERVER_BROWSER_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(HttpBrowserWorkerClient);
  });
});
