import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { HttpError, notFound, unauthorized } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";
import { logActivity } from "../services/activity-log.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "../services/data-connections.js";
import { fetchPaperlessDocumentDownload, PaperlessDocumentNotFoundError } from "../services/data-sources/paperless-documents-client.js";
import { DataSourceUpstreamError } from "../services/data-sources/contract.js";
import { DOCUMENTS_DATASET } from "../services/documents-data.js";
import { documentsSettingsService } from "../services/documents-settings.js";
import { verifyDocumentDownloadToken } from "../services/documents-download-token.js";
import { instanceSettingsService } from "../services/instance-settings.js";

/**
 * DUR-4303: the proxied download path get_document's link points at. The
 * browser/agent holding the link never sees paperless-ngx's own URL or
 * token (design doc) -- this route is the only thing that does, and only
 * for the one request it is serving.
 *
 * Security-critical property (DUR-4305's follow-up focus for this slice):
 * the token names only `companyId` + `documentId` + an expiry, NEVER a
 * connectionId, host or credential. Every request:
 *   1. verifies the token's signature and expiry (documents-download-token.ts)
 *   2. establishes company scope from the token's OWN companyId via the
 *      same `runInCompanyScope` primitive every other company-scoped route
 *      uses, so the database layer itself -- not just this file's logic --
 *      confines every query to that one company
 *   3. inside that scope, looks up THIS company's own active "documents"
 *      connection row FRESH from the database (dataConnectionService),
 *      never a cached value and never anything named in the token
 * A token minted for company A can therefore never be replayed to reach
 * company B's container: there is no connectionId or host in the token for
 * a replay to point elsewhere, and the scope + fresh lookup together mean
 * the row read is always this request's own company's row, not stale state
 * carried over from when the token was minted.
 *
 * Deliberately unauthenticated (no bearer token): the link must work for
 * whoever the quick agent handed it to (e.g. in a Telegram chat), who may
 * have no Paperclip session at all. The short TTL (documents-download-
 * token.ts) is what bounds the exposure, the same tradeoff routines.ts's
 * public webhook trigger already makes for a similar "whoever holds this
 * one capability may use it, briefly" shape.
 */
export function documentsDownloadRoutes(rawDb: Db, deps: DataConnectionServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const connections = dataConnectionService(db, deps);
  const documentsSettings = documentsSettingsService(db);
  const instanceSettings = instanceSettingsService(db);

  router.get(
    "/documents/download/:token",
    companyScope(rawDb, (req) => {
      const claims = verifyDocumentDownloadToken(req.params.token as string);
      if (!claims) throw unauthorized("This download link has expired or is invalid. Ask for a new one.");
      return claims.companyId;
    }),
    async (req, res) => {
      // Re-verified (cheap, pure HMAC check): the resolver above only
      // returns companyId to the scope primitive, so documentId is read
      // again here rather than stashed on `req`.
      const claims = verifyDocumentDownloadToken(req.params.token as string);
      if (!claims) throw unauthorized("This download link has expired or is invalid. Ask for a new one.");
      const { companyId, documentId } = claims;

      const experimental = await instanceSettings.getExperimental();
      if (experimental.enableBusinessData !== true) {
        throw notFound("This download link is no longer available.");
      }
      if (!(await documentsSettings.isEnabled(companyId))) {
        throw notFound("This download link is no longer available.");
      }
      const row = await connections.getActiveDatasetSource(companyId, DOCUMENTS_DATASET);
      if (!row) throw notFound("This download link is no longer available.");

      const { read } = await connections.openReadContext(
        companyId,
        row.id,
        { actorType: "system", actorId: "documents_download_token" },
        { maxRequests: 2, deadlineMs: 15_000 },
      );
      if (read.kind !== "paperless_ngx") throw notFound("This download link is no longer available.");

      let upstream: Response;
      try {
        upstream = await fetchPaperlessDocumentDownload(read, documentId);
      } catch (error) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "documents_download_token",
          action: "document.download_failed",
          entityType: "data_connection",
          entityId: row.id,
          details: { documentId, reason: error instanceof Error ? error.name : "unknown" },
        });
        if (error instanceof PaperlessDocumentNotFoundError) throw notFound("No such document.");
        if (error instanceof DataSourceUpstreamError) throw new HttpError(502, error.message);
        throw error;
      }

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "documents_download_token",
        action: "document.downloaded",
        entityType: "data_connection",
        entityId: row.id,
        details: { documentId },
      });

      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.status(200);
      res.set("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
      const disposition = upstream.headers.get("content-disposition");
      res.set("Content-Disposition", disposition ?? `attachment; filename="document-${documentId}"`);
      res.set("Cache-Control", "no-store");
      res.send(bytes);
    },
  );

  return router;
}
