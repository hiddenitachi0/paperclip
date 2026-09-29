/**
 * DUR-4065: entrypoint for the `browser` container (docker/docker-compose.browser.yml).
 * Binds the control socket, checks the bearer token on every request, and
 * (DUR-4078) drives a real per-session Chromium process behind each route via
 * `SessionManager`/`PlaywrightBrowserDriver` -- see those files for the
 * hardening (proxy, locale/timezone, autofill/service-workers/downloads off)
 * and the session caps (2 per instance, 1 per agent, 20 min wall clock,
 * 5 min idle, 300 actions).
 *
 * Routes mirror `BrowserWorkerClient` in server/src/services/browser-worker-client.ts
 * 1:1, and their request/response shapes are dictated by that client, not by
 * this file -- see its `HttpBrowserWorkerClient` methods for the exact body
 * shape each route must accept/return.
 */

import { createServer } from "node:http";
import { existsSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { SessionExpiredError, SessionLimitError, SessionManager, SessionNotFoundError } from "../session-manager.js";

const SOCKET_PATH = process.env.BROWSER_CONTROL_SOCKET?.trim();
const TOKEN = process.env.PAPERCLIP_SERVER_BROWSER_TOKEN?.trim();

if (!SOCKET_PATH) {
  // eslint-disable-next-line no-console
  console.error("BROWSER_CONTROL_SOCKET is not set -- refusing to start with no control endpoint to bind.");
  process.exit(1);
}
if (!TOKEN) {
  // eslint-disable-next-line no-console
  console.error("PAPERCLIP_SERVER_BROWSER_TOKEN is not set -- refusing to start with no way to authenticate the server.");
  process.exit(1);
}

const sessionManager = new SessionManager();

const app = express();
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/healthz") {
    next();
    return;
  }
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (presented !== TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

/** Every session route's shared error shape: `describeElement`/etc unknown-ref errors, navigation failures, and the session-lifecycle errors below are all reported the same way the deployability stub already did -- `{error: message}` with a non-2xx status -- so `HttpBrowserWorkerClient.parseWorkerResponseBody` throws the message unchanged. */
function statusFor(error: unknown): number {
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof SessionLimitError) return 409;
  if (error instanceof SessionExpiredError) return 410;
  return 500;
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "browser-worker: unexpected error";
      res.status(statusFor(error)).json({ error: message });
    });
  };
}

function sessionId(req: Request): string {
  return String(req.params.id);
}

app.post(
  "/sessions",
  handle(async (req, res) => {
    const { agentId, companyId, purpose } = req.body as { agentId: string; companyId: string; purpose: string };
    const result = await sessionManager.openSession({ agentId, companyId, purpose });
    res.status(200).json(result);
  }),
);

app.post(
  "/sessions/:id/navigate",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { url } = req.body as { url: string };
    res.status(200).json(await driver.navigate(url));
  }),
);

app.post(
  "/sessions/:id/snapshot",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    res.status(200).json(await driver.snapshot());
  }),
);

app.post(
  "/sessions/:id/read-text",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    res.status(200).json(await driver.readText());
  }),
);

app.post(
  "/sessions/:id/describe-element",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { ref } = req.body as { ref: string };
    res.status(200).json(await driver.describeElement(ref));
  }),
);

app.post(
  "/sessions/:id/click",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { ref } = req.body as { ref: string };
    res.status(200).json(await driver.performClick(ref));
  }),
);

app.post(
  "/sessions/:id/type",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { ref, text } = req.body as { ref: string; text: string };
    res.status(200).json(await driver.performType(ref, text));
  }),
);

app.post(
  "/sessions/:id/select",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { ref, value } = req.body as { ref: string; value: string };
    res.status(200).json(await driver.performSelect(ref, value));
  }),
);

app.post(
  "/sessions/:id/check",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { ref, checked } = req.body as { ref: string; checked: boolean };
    res.status(200).json(await driver.performCheck(ref, checked));
  }),
);

app.post(
  "/sessions/:id/focused-form-submit-target",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    res.status(200).json(await driver.focusedFormSubmitTarget());
  }),
);

app.post(
  "/sessions/:id/press-key",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { key } = req.body as { key: string };
    res.status(200).json(await driver.performPressKey(key));
  }),
);

app.post(
  "/sessions/:id/screenshot",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const bytes = await driver.screenshot();
    res.status(200).json({ base64: Buffer.from(bytes).toString("base64") });
  }),
);

app.post(
  "/sessions/:id/wait",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    const { ms } = req.body as { ms: number };
    await driver.wait(ms);
    res.status(200).json(null);
  }),
);

app.post(
  "/sessions/:id/back",
  handle(async (req, res) => {
    const driver = sessionManager.getDriver(sessionId(req));
    res.status(200).json(await driver.back());
  }),
);

app.post(
  "/sessions/:id/close",
  handle(async (req, res) => {
    // Not `getDriver`: closing an already-expired/unknown session must be a
    // no-op, not an error -- the server's own `browserService.close()` calls
    // this from a `finally` block after any other failure.
    await sessionManager.closeSession(sessionId(req));
    res.status(200).json(null);
  }),
);

// A crashed previous run can leave a stale socket file behind; remove it
// before binding so a restart does not fail with EADDRINUSE.
mkdirSync(dirname(SOCKET_PATH), { recursive: true });
if (existsSync(SOCKET_PATH)) {
  unlinkSync(SOCKET_PATH);
}

const server = createServer(app);
server.listen(SOCKET_PATH, () => {
  // Server and worker run as different container users on the shared
  // browser-control volume; 0o660 lets both read/write the socket without
  // opening it to anyone else on the volume.
  chmodSync(SOCKET_PATH, 0o660);
  // eslint-disable-next-line no-console
  console.log(`browser-worker listening on ${SOCKET_PATH}`);
});

function shutdown(): void {
  server.close(() => {
    void sessionManager.closeAll().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
