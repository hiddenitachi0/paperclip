import http from "node:http";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  PREVIEW_NOT_RUNNING_HEADLINE,
  PREVIEW_PROXY_PATH_PREFIX,
  normalizePreviewForwardPath,
  previewNotRunningBody,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { previewEnvironmentService, type PreviewEnvironmentService } from "../services/preview-environments.js";

/**
 * The operator-only window onto a preview.
 *
 * Everything about this route is deliberately narrow. It answers only for a
 * board user who can already see the company the preview belongs to — never an
 * agent, never an unauthenticated caller — and the only place it can send a
 * request is the one local port that preview's own process is listening on.
 * The target address is never taken from the URL, a header or a query
 * parameter: it is read from the runtime-service row Paperclip itself wrote.
 */

/** Headers that carry the operator's Paperclip identity. They never leave the server. */
const REQUEST_HEADERS_NEVER_FORWARDED = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-agent-key",
  "x-paperclip-agent-key",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

/** Headers a previewed app must not be able to set on the Paperclip origin. */
const RESPONSE_HEADERS_NEVER_RETURNED = new Set([
  "set-cookie",
  "set-cookie2",
  "strict-transport-security",
  "public-key-pins",
  // A previewed app must never widen the scope a service worker may claim on
  // the Paperclip origin. Belt and braces next to the sandbox policy below,
  // which already denies the previewed page a service worker at all.
  "service-worker-allowed",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Every byte this route returns is served from Paperclip's own web address, so
 * without this header the previewed app would count as Paperclip: it could read
 * the operator's session cookie and browser storage, call Paperclip's own API as
 * the operator, and install a service worker over the whole site.
 *
 * The `sandbox` policy drops the page into an origin of its own. It is left
 * with no cookies, no storage, no service worker and no same-origin API calls,
 * while scripts, forms, pop-ups and dialogs still work so the preview is worth
 * looking at. `allow-same-origin` is deliberately absent — adding it would give
 * the previewed code the operator's Paperclip session.
 */
export const PREVIEW_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals";

/** Set before anything else, so even a refusal page is sandboxed. */
function applyPreviewSandbox(res: Response) {
  res.setHeader("Content-Security-Policy", PREVIEW_SANDBOX_CSP);
}

/** Cap on an HTML page we rewrite in memory; anything bigger is streamed untouched. */
const HTML_REWRITE_MAX_BYTES = 4 * 1024 * 1024;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The page the operator gets instead of a preview. Plain words, no status
 * codes, and it says what to do next.
 */
export function renderPreviewNotRunningPage(detail?: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(PREVIEW_NOT_RUNNING_HEADLINE)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background:#f7f7f8; color:#1c1c1e; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .5rem; color:#4a4a52; }
</style></head>
<body><main>
  <h1>${escapeHtml(PREVIEW_NOT_RUNNING_HEADLINE)}</h1>
  <p>${escapeHtml(previewNotRunningBody(detail ?? null))}</p>
</main></body></html>`;
}

/**
 * Only ever a loopback HTTP address on this machine. Anything else — another
 * host, https, a unix socket, a missing port — is refused rather than fetched,
 * so a corrupted or hand-edited row can never turn the proxy into an open
 * relay.
 */
export function parseLoopbackTarget(rawUrl: string | null | undefined): { hostname: string; port: number } | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1") return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { hostname: parsed.hostname, port };
}

function buildForwardHeaders(req: Request, target: { hostname: string; port: number }) {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (REQUEST_HEADERS_NEVER_FORWARDED.has(lower)) continue;
    // Any header a plugin or the board session adds for Paperclip's own use
    // stays on this side of the proxy.
    if (lower.startsWith("x-paperclip-")) continue;
    headers[key] = value as string | string[];
  }
  headers.host = `${target.hostname}:${target.port}`;
  // Compression is decided between the browser and this server, not the
  // preview: asking for identity keeps the HTML rewrite below honest.
  headers["accept-encoding"] = "identity";
  return headers;
}

function rewriteLocationHeader(value: string, target: { hostname: string; port: number }, previewBase: string) {
  const origins = [`http://${target.hostname}:${target.port}`, `http://127.0.0.1:${target.port}`];
  for (const origin of origins) {
    if (value.startsWith(origin)) {
      return `${previewBase}${normalizePreviewForwardPath(value.slice(origin.length)).slice(1)}`;
    }
  }
  if (value.startsWith("/")) return `${previewBase}${value.slice(1)}`;
  return value;
}

/**
 * Serve a previewed page under `/_preview/<id>/` without the app having to know
 * it lives there. A `<base>` tag makes every *relative* link in the page resolve
 * back through the proxy. Links written from the site root ("/assets/app.js")
 * still point at Paperclip itself — see the note on the approval card.
 */
export function injectPreviewBaseTag(html: string, previewBase: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${previewBase}">`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch && htmlMatch.index !== undefined) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
  }
  return `${tag}${html}`;
}

export function previewProxyRoutes(
  rawDb: Db,
  opts: { service?: PreviewEnvironmentService } = {},
) {
  const router = Router();
  const previews = opts.service ?? previewEnvironmentService(rawDb);

  async function handle(req: Request, res: Response) {
    applyPreviewSandbox(res);
    // Operator-only. An agent key or an anonymous caller is refused here,
    // before anything is looked up, so a preview is never an agent's side door
    // into a running app.
    assertBoard(req);

    const rawWorkspaceId = req.params.workspaceId;
    const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId : "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(workspaceId)) {
      res.status(404).type("html").send(renderPreviewNotRunningPage());
      return;
    }

    const resolved = await previews.resolveProxyTarget(workspaceId);
    if (!resolved.found) {
      res.status(404).type("html").send(renderPreviewNotRunningPage());
      return;
    }

    // Same company rule as everywhere else: seeing a preview is seeing that
    // company's code running.
    assertCompanyAccess(req, resolved.companyId);

    if (resolved.status === "starting") {
      res
        .status(503)
        .type("html")
        .send(renderPreviewNotRunningPage("This copy is still starting up. Give it a moment and reload."));
      return;
    }
    const target = parseLoopbackTarget(resolved.targetUrl);
    if (!target) {
      res.status(503).type("html").send(renderPreviewNotRunningPage());
      return;
    }

    const rawParam = req.params.previewPath;
    const rawPath = Array.isArray(rawParam) ? rawParam.join("/") : ((rawParam as string | undefined) ?? "");
    const forwardPath = normalizePreviewForwardPath(rawPath);
    const queryIndex = req.originalUrl.indexOf("?");
    const search = queryIndex === -1 ? "" : req.originalUrl.slice(queryIndex);
    const previewBase = `${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}/`;

    void previews.touch(workspaceId);

    await new Promise<void>((resolve) => {
      const upstream = http.request(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: `${forwardPath}${search}`,
          headers: buildForwardHeaders(req, target),
        },
        (upstreamRes) => {
          const contentType = String(upstreamRes.headers["content-type"] ?? "");
          const isHtml = contentType.toLowerCase().includes("text/html");

          res.status(upstreamRes.statusCode ?? 502);
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue;
            const lower = key.toLowerCase();
            if (RESPONSE_HEADERS_NEVER_RETURNED.has(lower)) continue;
            if (lower === "location" && typeof value === "string") {
              res.setHeader(key, rewriteLocationHeader(value, target, previewBase));
              continue;
            }
            if (lower === "content-security-policy") {
              // The previewed app may have a policy of its own; it is added
              // alongside ours rather than replacing it, and a browser applies
              // both. The sandbox can only ever be made tighter this way.
              res.append(key, value as string | string[]);
              continue;
            }
            if (isHtml && (lower === "content-length" || lower === "content-encoding")) continue;
            res.setHeader(key, value);
          }
          res.setHeader("X-Robots-Tag", "noindex, nofollow");

          if (!isHtml) {
            upstreamRes.pipe(res);
            upstreamRes.on("end", () => resolve());
            upstreamRes.on("error", () => {
              res.end();
              resolve();
            });
            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          let overflowed = false;
          upstreamRes.on("data", (chunk: Buffer) => {
            if (overflowed) return;
            bytes += chunk.length;
            if (bytes > HTML_REWRITE_MAX_BYTES) {
              overflowed = true;
              for (const buffered of chunks) res.write(buffered);
              chunks.length = 0;
              res.write(chunk);
              upstreamRes.pipe(res);
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on("end", () => {
            if (overflowed) {
              res.end();
              resolve();
              return;
            }
            const body = injectPreviewBaseTag(Buffer.concat(chunks).toString("utf8"), previewBase);
            res.end(body);
            resolve();
          });
          upstreamRes.on("error", () => {
            res.end();
            resolve();
          });
        },
      );

      upstream.on("error", (err) => {
        logger.warn({ err, workspaceId }, "preview: the copy stopped answering");
        if (!res.headersSent) {
          res
            .status(502)
            .type("html")
            .send(renderPreviewNotRunningPage("The copy stopped answering. Start it again from the approval card."));
        } else {
          res.end();
        }
        resolve();
      });

      // express.json() may already have read a JSON body off the request, so
      // send that back out rather than piping an exhausted stream.
      const parsedBody = (req as Request & { body?: unknown }).body;
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (parsedBody && typeof parsedBody === "object" && contentType.includes("application/json")) {
        const payload = Buffer.from(JSON.stringify(parsedBody), "utf8");
        upstream.setHeader("content-length", String(payload.length));
        upstream.end(payload);
        return;
      }
      if (req.readableEnded) {
        upstream.end();
        return;
      }
      req.pipe(upstream);
    });
  }

  /**
   * The bare form, with or without a trailing slash. A GET without the slash is
   * what an operator gets from copying the link out of a card, so send them to
   * the real root first -- otherwise every relative link in the previewed page
   * would resolve one level too high.
   */
  async function handleRoot(req: Request, res: Response) {
    applyPreviewSandbox(res);
    // Same operator-only rule as the main handler, and it comes first: an agent
    // or a signed-out caller is refused outright rather than being told where
    // the preview lives by a redirect.
    assertBoard(req);
    if (req.method === "GET" && !req.path.endsWith("/")) {
      res.redirect(302, `${PREVIEW_PROXY_PATH_PREFIX}/${encodeURIComponent(String(req.params.workspaceId))}/`);
      return;
    }
    await handle(req, res);
  }

  router.get("/_preview/:workspaceId/*previewPath", handle);
  router.post("/_preview/:workspaceId/*previewPath", handle);
  router.put("/_preview/:workspaceId/*previewPath", handle);
  router.patch("/_preview/:workspaceId/*previewPath", handle);
  router.delete("/_preview/:workspaceId/*previewPath", handle);
  router.get("/_preview/:workspaceId", handleRoot);
  router.post("/_preview/:workspaceId", handleRoot);
  router.put("/_preview/:workspaceId", handleRoot);
  router.patch("/_preview/:workspaceId", handleRoot);
  router.delete("/_preview/:workspaceId", handleRoot);

  return router;
}
