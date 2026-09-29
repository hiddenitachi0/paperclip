/**
 * DUR-4065: entrypoint for the `browser` container (docker/docker-compose.browser.yml).
 * This is the deployability skeleton only: it binds the control socket, checks
 * the bearer token on every request, and answers every session route with a
 * clear 501 -- it does NOT drive a real Chromium session yet. Wiring a real
 * `BrowserDriver` (packages/adapter-utils/src/browser-tools.ts) backed by
 * `playwright-core` here is the worker's step-1 implementation, tracked
 * separately (see PR #387/#394's own notes that the image was a placeholder
 * because that work had not landed); this PR only makes the container build,
 * start, listen on the shared Unix socket, and refuse cleanly, so the rest of
 * the deploy path (image build, socket wiring, isolation, host steps) can be
 * proven end-to-end before that driver exists.
 *
 * Routes mirror `BrowserWorkerClient` in server/src/services/browser-worker-client.ts
 * 1:1 so wiring the real driver in later is a body-only change, not a route change.
 */

import { createServer } from "node:http";
import { existsSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";

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

function notImplemented(_req: Request, res: Response): void {
  res.status(501).json({
    error: "browser-worker: no Playwright driver wired yet (deployability-only build, see worker.ts)",
  });
}

app.post("/sessions", notImplemented);
app.post("/sessions/:id/navigate", notImplemented);
app.post("/sessions/:id/snapshot", notImplemented);
app.post("/sessions/:id/read-text", notImplemented);
app.post("/sessions/:id/describe-element", notImplemented);
app.post("/sessions/:id/click", notImplemented);
app.post("/sessions/:id/type", notImplemented);
app.post("/sessions/:id/select", notImplemented);
app.post("/sessions/:id/check", notImplemented);
app.post("/sessions/:id/focused-form-submit-target", notImplemented);
app.post("/sessions/:id/press-key", notImplemented);
app.post("/sessions/:id/screenshot", notImplemented);
app.post("/sessions/:id/wait", notImplemented);
app.post("/sessions/:id/back", notImplemented);
app.post("/sessions/:id/close", notImplemented);

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

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
