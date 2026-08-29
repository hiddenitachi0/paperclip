import { Router, type Request, type Response } from "express";
import multer from "multer";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, assets as assetsTable, createRequestScopedDb } from "@paperclipai/db";
import {
  createAssetImageMetadataSchema,
  ALLOWED_IMAGE_UPLOAD_CONTENT_TYPES,
  MAX_AGENT_AVATAR_BYTES,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { accessService, agentService, assetService, logActivity } from "../services/index.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { forbidden, notFound } from "../errors.js";
import { assertCanUpdateAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
const SVG_CONTENT_TYPE = "image/svg+xml";
const ALLOWED_COMPANY_LOGO_CONTENT_TYPES = new Set<string>(ALLOWED_IMAGE_UPLOAD_CONTENT_TYPES);
const ALLOWED_AGENT_AVATAR_CONTENT_TYPES = new Set<string>(ALLOWED_IMAGE_UPLOAD_CONTENT_TYPES);

function sanitizeSvgBuffer(input: Buffer): Buffer | null {
  const raw = input.toString("utf8").trim();
  if (!raw) return null;

  const baseDom = new JSDOM("");
  const domPurify = createDOMPurify(
    baseDom.window as unknown as Parameters<typeof createDOMPurify>[0],
  );
  domPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    const attrName = data.attrName.toLowerCase();
    const attrValue = (data.attrValue ?? "").trim();

    if (attrName.startsWith("on")) {
      data.keepAttr = false;
      return;
    }

    if ((attrName === "href" || attrName === "xlink:href") && attrValue && !attrValue.startsWith("#")) {
      data.keepAttr = false;
    }
  });

  let parsedDom: JSDOM | null = null;
  try {
    const sanitized = domPurify.sanitize(raw, {
      USE_PROFILES: { svg: true, svgFilters: true, html: false },
      FORBID_TAGS: ["script", "foreignObject"],
      FORBID_CONTENTS: ["script", "foreignObject"],
      RETURN_TRUSTED_TYPE: false,
    });

    parsedDom = new JSDOM(sanitized, { contentType: SVG_CONTENT_TYPE });
    const document = parsedDom.window.document;
    const root = document.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return null;

    for (const el of Array.from(root.querySelectorAll("script, foreignObject"))) {
      el.remove();
    }
    for (const el of Array.from(root.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        const attrName = attr.name.toLowerCase();
        const attrValue = attr.value.trim();
        if (attrName.startsWith("on")) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((attrName === "href" || attrName === "xlink:href") && attrValue && !attrValue.startsWith("#")) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const output = root.outerHTML.trim();
    if (!output || !/^<svg[\s>]/i.test(output)) return null;
    return Buffer.from(output, "utf8");
  } catch {
    return null;
  } finally {
    parsedDom?.window.close();
    baseDom.window.close();
  }
}

export function assetRoutes(rawDb: Db, storage: StorageService) {
  const router = Router();
  // DUR-394 (DUR-277 Wave 3): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope agent/asset lookups below (see
  // middleware/company-scope.ts).
  const db = createRequestScopedDb(rawDb);
  const svc = assetService(db);
  const rawSvc = assetService(rawDb);
  const assetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  const companyLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  const agentAvatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AGENT_AVATAR_BYTES, files: 1 },
  });

  async function runSingleFileUpload(
    upload: ReturnType<typeof multer>,
    req: Request,
    res: Response,
  ) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.post(
    "/companies/:companyId/assets/images",
    companyScopeFromParam(rawDb, (req, companyId) => assertCompanyAccess(req, companyId)),
    async (req, res) => {
    const companyId = req.params.companyId as string;

    try {
      await runSingleFileUpload(assetUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const parsedMeta = createAssetImageMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid image metadata", details: parsedMeta.error.issues });
      return;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? "general";
    const contentType = (file.mimetype || "").toLowerCase();
    if (contentType !== SVG_CONTENT_TYPE && !isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported file type: ${contentType || "unknown"}` });
      return;
    }
    let fileBody = file.buffer;
    if (contentType === SVG_CONTENT_TYPE) {
      const sanitized = sanitizeSvgBuffer(file.buffer);
      if (!sanitized || sanitized.length <= 0) {
        res.status(422).json({ error: "SVG could not be sanitized" });
        return;
      }
      fileBody = sanitized;
    }
    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  router.post(
    "/companies/:companyId/logo",
    companyScopeFromParam(rawDb, (req, companyId) => assertCompanyAccess(req, companyId)),
    async (req, res) => {
    const companyId = req.params.companyId as string;

    try {
      await runSingleFileUpload(companyLogoUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_COMPANY_LOGO_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }

    let fileBody = file.buffer;
    if (contentType === SVG_CONTENT_TYPE) {
      const sanitized = sanitizeSvgBuffer(file.buffer);
      if (!sanitized || sanitized.length <= 0) {
        res.status(422).json({ error: "SVG could not be sanitized" });
        return;
      }
      fileBody = sanitized;
    }

    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/companies",
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        namespace: "assets/companies",
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  async function loadAgentForAvatarMutation(scopedDb: Db, req: Request, companyId: string, agentId: string) {
    if (req.actor.type === "agent") {
      throw forbidden("Agent-authenticated callers cannot manage an agent's avatar");
    }
    const agentRow = await scopedDb
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agentRow || agentRow.companyId !== companyId) {
      throw notFound("Agent not found");
    }
    await assertCanUpdateAgent(req, agentRow, accessService(scopedDb));
    return agentRow;
  }

  function scopeFromAvatarParams() {
    return companyScopeFromParam(rawDb, async (req, companyId) => {
      await loadAgentForAvatarMutation(rawDb, req, companyId, req.params.agentId as string);
    });
  }

  router.post(
    "/companies/:companyId/agents/:agentId/avatar",
    scopeFromAvatarParams(),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const agentRow = await loadAgentForAvatarMutation(db, req, companyId, agentId);

    try {
      await runSingleFileUpload(agentAvatarUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_AGENT_AVATAR_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_AGENT_AVATAR_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }

    let fileBody = file.buffer;
    if (contentType === SVG_CONTENT_TYPE) {
      const sanitized = sanitizeSvgBuffer(file.buffer);
      if (!sanitized || sanitized.length <= 0) {
        res.status(422).json({ error: "SVG could not be sanitized" });
        return;
      }
      fileBody = sanitized;
    }
    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/agents",
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const previousAsset = agentRow.avatarAssetId ? await svc.getById(agentRow.avatarAssetId) : null;

    const createdAsset = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const created = await assetService(txDb).create(companyId, {
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await tx
        .update(agentsTable)
        .set({ avatarAssetId: created.id, updatedAt: new Date() })
        .where(eq(agentsTable.id, agentId));
      if (previousAsset) {
        await tx.delete(assetsTable).where(eq(assetsTable.id, previousAsset.id));
      }
      return created;
    });

    if (previousAsset) {
      await storage.deleteObject(companyId, previousAsset.objectKey);
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.avatar_updated",
      entityType: "agent",
      entityId: agentId,
      details: {
        assetId: createdAsset.id,
        contentType: createdAsset.contentType,
        byteSize: createdAsset.byteSize,
        replacedAssetId: previousAsset?.id ?? null,
      },
    });

    const updatedAgent = await agentService(db).getById(agentId);
    res.status(201).json(updatedAgent);
  });

  router.delete(
    "/companies/:companyId/agents/:agentId/avatar",
    scopeFromAvatarParams(),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const agentRow = await loadAgentForAvatarMutation(db, req, companyId, agentId);

    if (!agentRow.avatarAssetId) {
      res.status(200).json(await agentService(db).getById(agentId));
      return;
    }

    const previousAsset = await svc.getById(agentRow.avatarAssetId);

    await db.transaction(async (tx) => {
      await tx
        .update(agentsTable)
        .set({ avatarAssetId: null, updatedAt: new Date() })
        .where(eq(agentsTable.id, agentId));
      if (previousAsset) {
        await tx.delete(assetsTable).where(eq(assetsTable.id, previousAsset.id));
      }
    });

    if (previousAsset) {
      await storage.deleteObject(companyId, previousAsset.objectKey);
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.avatar_cleared",
      entityType: "agent",
      entityId: agentId,
      details: {
        removedAssetId: previousAsset?.id ?? null,
      },
    });

    res.status(200).json(await agentService(db).getById(agentId));
  });

  router.get(
    "/assets/:assetId/content",
    companyScope(rawDb, async (req) => {
      const asset = await rawSvc.getById(req.params.assetId as string);
      if (!asset) throw notFound("Asset not found");
      assertCompanyAccess(req, asset.companyId);
      return asset.companyId;
    }),
    async (req, res, next) => {
    const assetId = req.params.assetId as string;
    const asset = await svc.getById(assetId);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const object = await storage.getObject(asset.companyId, asset.objectKey);
    const responseContentType = asset.contentType || object.contentType || "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = asset.originalFilename ?? "asset";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  return router;
}
