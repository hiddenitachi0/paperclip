/**
 * DUR-4013 step 3 / DUR-4065: the server's HTTP client for the browser
 * worker's control endpoint (design section "Server↔worker control"). Holds
 * the `PAPERCLIP_SERVER_BROWSER_TOKEN` bearer token -- never sent to an
 * agent, kept out of agent envs the same way as every other
 * `PAPERCLIP_SERVER_` variable (`packages/adapter-utils/src/server-env-secrets.ts`).
 *
 * Talks over the Unix socket on the shared `browser-control` volume
 * (`PAPERCLIP_SERVER_BROWSER_WORKER_SOCKET`) in production -- per the design,
 * the worker has no network route back to the server, database or tailnet,
 * so a plain HTTP URL is not reachable from it at all. The HTTP URL option
 * (`PAPERCLIP_SERVER_BROWSER_WORKER_URL`) is kept for local/test setups where
 * running a worker container with a shared volume is impractical. If both are
 * set, the socket wins.
 */

import { request as httpRequest } from "node:http";
import type {
  AccessibilitySnapshot,
  ElementDescriptor,
} from "@paperclipai/adapter-utils/browser-tools";

export interface BrowserWorkerSessionHandle {
  workerSessionId: string;
  snapshot: AccessibilitySnapshot;
}

/**
 * One call per plain browser tool, mirroring `BrowserDriver` in
 * `packages/adapter-utils/src/browser-tools.ts` but scoped to a worker
 * session id over the wire instead of an in-process Playwright page.
 */
export interface BrowserWorkerClient {
  openSession(input: { agentId: string; companyId: string; purpose: string }): Promise<BrowserWorkerSessionHandle>;
  navigate(workerSessionId: string, url: string): Promise<AccessibilitySnapshot>;
  snapshot(workerSessionId: string): Promise<AccessibilitySnapshot>;
  readText(workerSessionId: string): Promise<string>;
  describeElement(workerSessionId: string, ref: string): Promise<ElementDescriptor | null>;
  performClick(workerSessionId: string, ref: string): Promise<AccessibilitySnapshot>;
  performType(workerSessionId: string, ref: string, text: string): Promise<AccessibilitySnapshot>;
  performSelect(workerSessionId: string, ref: string, value: string): Promise<AccessibilitySnapshot>;
  performCheck(workerSessionId: string, ref: string, checked: boolean): Promise<AccessibilitySnapshot>;
  focusedFormSubmitTarget(workerSessionId: string): Promise<ElementDescriptor | null>;
  performPressKey(workerSessionId: string, key: string): Promise<AccessibilitySnapshot>;
  screenshot(workerSessionId: string): Promise<Uint8Array>;
  wait(workerSessionId: string, ms: number): Promise<void>;
  back(workerSessionId: string): Promise<AccessibilitySnapshot>;
  close(workerSessionId: string): Promise<void>;
}

export class BrowserWorkerNotConfiguredError extends Error {
  constructor() {
    super(
      "The browser worker is not configured on this instance yet (PAPERCLIP_SERVER_BROWSER_WORKER_SOCKET / " +
        "PAPERCLIP_SERVER_BROWSER_WORKER_URL / PAPERCLIP_SERVER_BROWSER_TOKEN are unset). The browser overlay " +
        "has not been deployed here.",
    );
    this.name = "BrowserWorkerNotConfiguredError";
  }
}

export interface HttpBrowserWorkerClientConfig {
  /** Unix socket path on the shared browser-control volume. Wins over baseUrl when both are set. */
  socketPath?: string;
  /** Plain HTTP URL to the worker. Local/test convenience only -- not reachable in production. */
  baseUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function parseWorkerResponseBody<T>(path: string, status: number, ok: boolean, text: string): T {
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Browser worker request to ${path} failed with ${status}`;
    throw new Error(message);
  }
  return parsed as T;
}

/**
 * Real implementation: one JSON request per call against the worker's
 * control endpoint. The worker holds no policy of its own -- every method
 * here maps 1:1 to a `BrowserDriver` method, so `browserService` can drive a
 * worker session exactly as `BrowserToolHandler` drives an in-process one.
 */
export class HttpBrowserWorkerClient implements BrowserWorkerClient {
  constructor(private readonly config: HttpBrowserWorkerClientConfig) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    if (this.config.socketPath) {
      return this.requestOverSocket<T>(this.config.socketPath, path, body);
    }
    return this.requestOverHttp<T>(path, body);
  }

  private async requestOverHttp<T>(path: string, body?: unknown): Promise<T> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const baseUrl = this.config.baseUrl;
    if (!baseUrl) throw new Error("HttpBrowserWorkerClient: neither socketPath nor baseUrl is configured");
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    return parseWorkerResponseBody<T>(path, response.status, response.ok, text);
  }

  private requestOverSocket<T>(socketPath: string, path: string, body?: unknown): Promise<T> {
    const payload = JSON.stringify(body ?? {});
    return new Promise<T>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          path,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
              resolve(parseWorkerResponseBody<T>(path, res.statusCode ?? 0, ok, text));
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  async openSession(input: { agentId: string; companyId: string; purpose: string }): Promise<BrowserWorkerSessionHandle> {
    return this.request<BrowserWorkerSessionHandle>("/sessions", input);
  }
  navigate(workerSessionId: string, url: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/navigate`, { url });
  }
  snapshot(workerSessionId: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/snapshot`);
  }
  readText(workerSessionId: string): Promise<string> {
    return this.request(`/sessions/${workerSessionId}/read-text`);
  }
  describeElement(workerSessionId: string, ref: string): Promise<ElementDescriptor | null> {
    return this.request(`/sessions/${workerSessionId}/describe-element`, { ref });
  }
  performClick(workerSessionId: string, ref: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/click`, { ref });
  }
  performType(workerSessionId: string, ref: string, text: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/type`, { ref, text });
  }
  performSelect(workerSessionId: string, ref: string, value: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/select`, { ref, value });
  }
  performCheck(workerSessionId: string, ref: string, checked: boolean): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/check`, { ref, checked });
  }
  focusedFormSubmitTarget(workerSessionId: string): Promise<ElementDescriptor | null> {
    return this.request(`/sessions/${workerSessionId}/focused-form-submit-target`);
  }
  performPressKey(workerSessionId: string, key: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/press-key`, { key });
  }
  async screenshot(workerSessionId: string): Promise<Uint8Array> {
    const { base64 } = await this.request<{ base64: string }>(`/sessions/${workerSessionId}/screenshot`);
    return Buffer.from(base64, "base64");
  }
  async wait(workerSessionId: string, ms: number): Promise<void> {
    await this.request(`/sessions/${workerSessionId}/wait`, { ms });
  }
  back(workerSessionId: string): Promise<AccessibilitySnapshot> {
    return this.request(`/sessions/${workerSessionId}/back`);
  }
  async close(workerSessionId: string): Promise<void> {
    await this.request(`/sessions/${workerSessionId}/close`);
  }
}

/** Refuses every call with `BrowserWorkerNotConfiguredError` -- the safe default before step 2 is deployed anywhere. */
export class UnconfiguredBrowserWorkerClient implements BrowserWorkerClient {
  openSession(): Promise<BrowserWorkerSessionHandle> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  navigate(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  snapshot(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  readText(): Promise<string> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  describeElement(): Promise<ElementDescriptor | null> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  performClick(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  performType(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  performSelect(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  performCheck(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  focusedFormSubmitTarget(): Promise<ElementDescriptor | null> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  performPressKey(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  screenshot(): Promise<Uint8Array> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  wait(): Promise<void> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  back(): Promise<AccessibilitySnapshot> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
  close(): Promise<void> {
    return Promise.reject(new BrowserWorkerNotConfiguredError());
  }
}

export function createBrowserWorkerClientFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserWorkerClient {
  const socketPath = env.PAPERCLIP_SERVER_BROWSER_WORKER_SOCKET?.trim();
  const baseUrl = env.PAPERCLIP_SERVER_BROWSER_WORKER_URL?.trim();
  const token = env.PAPERCLIP_SERVER_BROWSER_TOKEN?.trim();
  if (!token || (!socketPath && !baseUrl)) return new UnconfiguredBrowserWorkerClient();
  return new HttpBrowserWorkerClient({ socketPath, baseUrl, token });
}
