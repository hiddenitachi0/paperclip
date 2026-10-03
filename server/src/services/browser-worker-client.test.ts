import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("HttpBrowserWorkerClient over a Unix socket", () => {
  let server: Server | undefined;
  let socketDir: string | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (socketDir) {
      rmSync(socketDir, { recursive: true, force: true });
      socketDir = undefined;
    }
  });

  function startSocketServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
    socketDir = mkdtempSync(join(tmpdir(), "browser-worker-client-test-"));
    const socketPath = join(socketDir, "control.sock");
    server = createServer(handler);
    return new Promise<string>((resolve) => {
      server!.listen(socketPath, () => resolve(socketPath));
    });
  }

  it("sends the bearer token and posts to the right path over the socket", async () => {
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    let receivedBody = "";
    const socketPath = await startSocketServer((req, res) => {
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      req.on("data", (chunk: Buffer) => {
        receivedBody += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tree: "t", url: "https://x", title: "X" }));
      });
    });

    const client = new HttpBrowserWorkerClient({ socketPath, token: "secret-token" });
    const result = await client.navigate("session-1", "https://x");

    expect(result).toEqual({ tree: "t", url: "https://x", title: "X" });
    expect(receivedAuth).toBe("Bearer secret-token");
    expect(receivedPath).toBe("/sessions/session-1/navigate");
    expect(JSON.parse(receivedBody)).toEqual({ url: "https://x" });
  });

  it("throws with the worker's error message on a non-ok response over the socket", async () => {
    const socketPath = await startSocketServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such session" }));
    });

    const client = new HttpBrowserWorkerClient({ socketPath, token: "t" });
    await expect(client.snapshot("gone")).rejects.toThrow("no such session");
  });

  it("prefers the socket over baseUrl when both are configured", async () => {
    const fetchImpl = vi.fn();
    const socketPath = await startSocketServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tree: "t", url: "https://x", title: "X" }));
    });

    const client = new HttpBrowserWorkerClient({
      socketPath,
      baseUrl: "http://worker.internal:9000",
      token: "t",
      fetchImpl: fetchImpl as any,
    });
    await client.navigate("session-1", "https://x");

    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("returns an HTTP client when the URL and token are set", () => {
    const client = createBrowserWorkerClientFromEnv({
      PAPERCLIP_SERVER_BROWSER_WORKER_URL: "http://worker.internal:9000",
      PAPERCLIP_SERVER_BROWSER_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(HttpBrowserWorkerClient);
  });

  it("returns a socket-backed client when the socket path and token are set", () => {
    const client = createBrowserWorkerClientFromEnv({
      PAPERCLIP_SERVER_BROWSER_WORKER_SOCKET: "/run/browser-control/control.sock",
      PAPERCLIP_SERVER_BROWSER_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(HttpBrowserWorkerClient);
  });

  it("stays unconfigured when the token is missing even if the socket path is set", () => {
    const client = createBrowserWorkerClientFromEnv({
      PAPERCLIP_SERVER_BROWSER_WORKER_SOCKET: "/run/browser-control/control.sock",
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(UnconfiguredBrowserWorkerClient);
  });
});
