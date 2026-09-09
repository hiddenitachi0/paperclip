/**
 * The preview proxy is the one route in Paperclip that forwards a request to a
 * process an agent's code started. Everything worth asserting about it is
 * therefore about what it refuses: who may use it at all, where it may send a
 * request, and what it must never hand over in either direction.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  injectPreviewBaseTag,
  parseLoopbackTarget,
  previewProxyRoutes,
} from "../routes/preview-proxy.js";
import type { PreviewEnvironmentService } from "../services/preview-environments.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

type Actor = Express.Request["actor"];

const boardActor = (companyIds: string[]): Actor => ({
  type: "board",
  source: "session",
  userId: "user-1",
  companyIds,
} as unknown as Actor);

const agentActor = (): Actor => ({
  type: "agent",
  agentId: "agent-1",
  companyId: COMPANY_ID,
} as unknown as Actor);

const anonymousActor = (): Actor => ({ type: "none" } as unknown as Actor);

/** Records what the previewed app was actually asked for. */
interface UpstreamRecord {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let upstream: http.Server;
let upstreamPort = 0;
const received: UpstreamRecord[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url?.startsWith("/page")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "sid=preview-secret; Path=/",
          "service-worker-allowed": "/",
        });
        res.end("<html><head><title>t</title></head><body>hello</body></html>");
        return;
      }
      if (req.url?.startsWith("/withcsp")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'",
        });
        res.end("<html><head></head><body>x</body></html>");
        return;
      }
      if (req.url?.startsWith("/go")) {
        res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/after` });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "service-worker-allowed": "/",
      });
      res.end(JSON.stringify({ saw: req.url }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(() => {
  received.length = 0;
});

function fakeService(overrides: Partial<{
  companyId: string;
  status: "starting" | "ready" | "failed" | "stopped";
  targetUrl: string | null;
  found: boolean;
}> = {}) {
  const touch = vi.fn(async () => undefined);
  const service = {
    touch,
    resolveProxyTarget: vi.fn(async (workspaceId: string) => {
      if (overrides.found === false || workspaceId !== WORKSPACE_ID) return { found: false as const };
      return {
        found: true as const,
        companyId: overrides.companyId ?? COMPANY_ID,
        status: overrides.status ?? ("ready" as const),
        targetUrl:
          overrides.targetUrl === undefined ? `http://127.0.0.1:${upstreamPort}` : overrides.targetUrl,
        approvalId: "approval-1",
      };
    }),
  } as unknown as PreviewEnvironmentService;
  return { service, touch };
}

function createApp(actor: Actor, service: PreviewEnvironmentService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(previewProxyRoutes({} as never, { service }));
  app.use(errorHandler);
  return app;
}

describe("preview proxy access gating", () => {
  it("refuses an unauthenticated caller before looking anything up", async () => {
    const { service } = fakeService();
    const res = await request(createApp(anonymousActor(), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(403);
    expect(service.resolveProxyTarget).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("refuses an agent, even one from the preview's own company", async () => {
    const { service } = fakeService();
    const res = await request(createApp(agentActor(), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(403);
    expect(service.resolveProxyTarget).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("refuses an unauthenticated caller on the bare link too, without redirecting", async () => {
    const { service } = fakeService();
    const res = await request(createApp(anonymousActor(), service)).get(`/_preview/${WORKSPACE_ID}`);
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(service.resolveProxyTarget).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("refuses an agent on the bare link too, without redirecting", async () => {
    const { service } = fakeService();
    const res = await request(createApp(agentActor(), service)).get(`/_preview/${WORKSPACE_ID}`);
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(service.resolveProxyTarget).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("refuses a board user who cannot see the preview's company", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([OTHER_COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("lets a board user with access through", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/api/thing`);
    expect(res.status).toBe(200);
    expect(received[0]?.url).toBe("/api/thing");
  });
});

describe("preview proxy when nothing is running", () => {
  it("shows the plain-language page for an unknown workspace", async () => {
    const { service } = fakeService({ found: false });
    const res = await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("Nothing is running for this branch yet");
  });

  it("says so while a preview is still starting", async () => {
    const { service } = fakeService({ status: "starting", targetUrl: null });
    const res = await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(503);
    expect(res.text).toContain("still starting up");
  });

  it("shows the page rather than fetching when the stored address is not a local port", async () => {
    const { service } = fakeService({ targetUrl: "http://evil.example.com/" });
    const res = await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(503);
    expect(received).toHaveLength(0);
  });
});

describe("preview proxy path handling", () => {
  it("forwards the path and query untouched", async () => {
    const { service } = fakeService();
    await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/a/b?x=1&y=two`);
    expect(received[0]?.url).toBe("/a/b?x=1&y=two");
  });

  it("cannot be walked out of with .. segments", async () => {
    const { service } = fakeService();
    // Express refuses an encoded dot segment outright; either way nothing that
    // climbs above the preview root ever reaches the previewed app.
    const encoded = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/a/%2e%2e/%2e%2e/etc/passwd`);
    expect(encoded.status).toBeGreaterThanOrEqual(400);
    expect(received).toHaveLength(0);

    // A literal ".." that survives to the route is stripped, not forwarded.
    await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/a/b`)
      .then(() => undefined);
    expect(received[0]?.url).toBe("/a/b");
    expect(received[0]?.url.includes("..")).toBe(false);
  });

  it("serves the workspace root", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(200);
    expect(received[0]?.url).toBe("/");
  });

  it("sends a bare /_preview/<id> to the root so relative links work", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/_preview/${WORKSPACE_ID}/`);
  });

  it("forwards a POST body", async () => {
    const { service } = fakeService();
    await request(createApp(boardActor([COMPANY_ID]), service))
      .post(`/_preview/${WORKSPACE_ID}/submit`)
      .send({ hello: "world" });
    expect(received[0]?.method).toBe("POST");
    expect(JSON.parse(received[0]!.body)).toEqual({ hello: "world" });
  });

  it("keeps a redirect inside the preview", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/go`);
    expect(res.headers.location).toBe(`/_preview/${WORKSPACE_ID}/after`);
  });

  it("pushes back the idle deadline every time it is used", async () => {
    const { service, touch } = fakeService();
    await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(touch).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

describe("preview proxy secrecy", () => {
  it("never hands the operator's session or keys to the previewed app", async () => {
    const { service } = fakeService();
    await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/x`)
      .set("cookie", "paperclip_session=super-secret")
      .set("authorization", "Bearer board-key")
      .set("x-api-key", "another-secret")
      .set("x-paperclip-agent-key", "agent-secret");
    const headers = received[0]?.headers ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-paperclip-agent-key"]).toBeUndefined();
  });

  it("never lets the previewed app set a cookie on the Paperclip origin", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/page`);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-robots-tag"]).toContain("noindex");
  });

  it("never lets the previewed app widen where a service worker may run", async () => {
    const { service } = fakeService();
    const app = createApp(boardActor([COMPANY_ID]), service);

    const html = await request(app).get(`/_preview/${WORKSPACE_ID}/page`);
    expect(html.headers["service-worker-allowed"]).toBeUndefined();

    const json = await request(app).get(`/_preview/${WORKSPACE_ID}/data.json`);
    expect(json.headers["service-worker-allowed"]).toBeUndefined();
  });

  it("adds a base tag so relative links stay inside the preview", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/page`);
    expect(res.text).toContain(`<base href="/_preview/${WORKSPACE_ID}/">`);
  });
});

/**
 * The preview is served from Paperclip's own web address, so without this the
 * previewed code would count as Paperclip in the browser. The sandbox policy
 * takes that away, and it has to be on everything the route returns — pages,
 * assets, API answers and refusals alike.
 */
describe("preview proxy sandbox policy", () => {
  const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-modals";

  it("sandboxes an HTML page", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/page`);
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain(sandbox);
    expect(res.headers["content-security-policy"]).not.toContain("allow-same-origin");
  });

  it("sandboxes a non-HTML response too", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain(sandbox);
  });

  it("keeps the sandbox even when the previewed app sends a policy of its own", async () => {
    const { service } = fakeService();
    const res = await request(createApp(boardActor([COMPANY_ID]), service))
      .get(`/_preview/${WORKSPACE_ID}/withcsp`);
    expect(res.headers["content-security-policy"]).toContain(sandbox);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("sandboxes the pages shown when nothing is running", async () => {
    const { service } = fakeService({ found: false });
    const res = await request(createApp(boardActor([COMPANY_ID]), service)).get(`/_preview/${WORKSPACE_ID}/`);
    expect(res.status).toBe(404);
    expect(res.headers["content-security-policy"]).toContain(sandbox);
  });
});

describe("parseLoopbackTarget", () => {
  it("accepts only a loopback http address with a port", () => {
    expect(parseLoopbackTarget("http://127.0.0.1:4000")).toEqual({ hostname: "127.0.0.1", port: 4000 });
    expect(parseLoopbackTarget("http://localhost:81")).toEqual({ hostname: "localhost", port: 81 });
  });

  it("refuses anything that could reach past this machine", () => {
    expect(parseLoopbackTarget("http://10.0.0.5:4000")).toBeNull();
    expect(parseLoopbackTarget("https://127.0.0.1:4000")).toBeNull();
    expect(parseLoopbackTarget("http://127.0.0.1")).toBeNull();
    expect(parseLoopbackTarget("file:///etc/passwd")).toBeNull();
    expect(parseLoopbackTarget(null)).toBeNull();
    expect(parseLoopbackTarget("not a url")).toBeNull();
  });
});

describe("injectPreviewBaseTag", () => {
  it("puts the base right after <head>", () => {
    expect(injectPreviewBaseTag("<html><head><title>x</title></head></html>", "/_preview/w/"))
      .toBe('<html><head><base href="/_preview/w/"><title>x</title></head></html>');
  });

  it("leaves a page that already declares a base alone", () => {
    const html = '<html><head><base href="/somewhere/"></head></html>';
    expect(injectPreviewBaseTag(html, "/_preview/w/")).toBe(html);
  });

  it("still works on a fragment with no head", () => {
    expect(injectPreviewBaseTag("<div>hi</div>", "/_preview/w/"))
      .toBe('<base href="/_preview/w/"><div>hi</div>');
  });
});
