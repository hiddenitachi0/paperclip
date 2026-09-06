// DUR-3909: "Connect & sign in" for MCP tool-library entries. The start and
// status routes are board-only, same posture as mcp-tool-library.ts — an
// agent can never kick off or poll one of these handshakes. The callback
// route is deliberately unauthenticated: it's hit by the operator's browser
// coming back from a third-party authorization server, which cannot carry
// our session auth across that redirect. It's gated instead by the
// unguessable `state` token minted in start() and the session row's short
// TTL (see mcp-oauth.ts).
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { mcpOAuthService, pruneExpiredMcpOAuthConnections } from "../services/mcp-oauth.js";
import { getMcpTool } from "../services/mcp-tool-library.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackLandingPage(input: { ok: boolean; message: string }): string {
  const title = input.ok ? "Connected" : "Could not connect";
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; color: #1a1a1a;">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(input.message)}</p>
  <p>You can close this window.</p>
  <script>try { window.close(); } catch (e) {}</script>
</body>
</html>`;
}

function requestOrigin(req: { protocol: string; get(name: string): string | undefined }): string {
  return `${req.protocol}://${req.get("host") ?? ""}`;
}

export function mcpOAuthRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);

  function scopeFromTool(toolIdParam: string) {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const tool = await getMcpTool(rawDb, req.params[toolIdParam] as string);
      if (!tool) throw notFound("Tool not found");
      assertCompanyAccess(req, tool.companyId);
      return tool.companyId;
    });
  }

  router.post("/mcp-tools/:toolId/oauth/start", scopeFromTool("toolId"), async (req, res) => {
    const toolId = req.params.toolId as string;
    const tool = await getMcpTool(db, toolId);
    if (!tool) throw notFound("Tool not found");
    const svc = mcpOAuthService(db);
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    const result = await svc.start({
      companyId: tool.companyId,
      toolId,
      requestOrigin: requestOrigin(req),
      userId,
    });
    res.status(201).json(result);
  });

  router.get(
    "/mcp-tools/:toolId/oauth/sessions/:sessionId",
    scopeFromTool("toolId"),
    async (req, res) => {
      const toolId = req.params.toolId as string;
      const tool = await getMcpTool(db, toolId);
      if (!tool) throw notFound("Tool not found");
      const svc = mcpOAuthService(db);
      const status = await svc.status(req.params.sessionId as string, tool.companyId);
      if (status.toolId !== toolId) {
        res.status(404).json({ error: "OAuth connect session not found" });
        return;
      }
      res.json(status);
    },
  );

  // Unauthenticated on purpose — see file header. Not company-scoped since
  // there is no session/board auth on this leg to scope with; completeCallback
  // itself re-derives and re-checks the company/tool from the session row.
  router.get("/mcp-tools/oauth/callback/:sessionId", async (req, res) => {
    await pruneExpiredMcpOAuthConnections(rawDb).catch(() => undefined);
    const svc = mcpOAuthService(rawDb);
    const query = req.query as Record<string, unknown>;
    const result = await svc
      .completeCallback({
        sessionId: req.params.sessionId as string,
        code: typeof query.code === "string" ? query.code : undefined,
        state: typeof query.state === "string" ? query.state : undefined,
        error: typeof query.error === "string" ? query.error : undefined,
        errorDescription: typeof query.error_description === "string" ? query.error_description : undefined,
      })
      .catch((error) => ({
        ok: false as const,
        toolName: null,
        message: error instanceof Error ? error.message : "Could not complete the OAuth connect flow.",
      }));
    res.status(result.ok ? 200 : 400).type("html").send(callbackLandingPage(result));
  });

  return router;
}
