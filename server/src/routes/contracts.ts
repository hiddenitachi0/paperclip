import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  aggregateContractTermQuerySchema,
  contractTermKeySchema,
  createContractDeadlineSchema,
  createContractPartySchema,
  createContractSchema,
  findContractsQuerySchema,
  linkPreviousContractVersionSchema,
  listContractDeadlinesQuerySchema,
  listContractsQuerySchema,
  registerContractSchema,
  searchContractTextQuerySchema,
  updateContractDeadlineSchema,
  updateContractPartySchema,
  updateContractSettingsSchema,
  updateContractSchema,
  uploadContractFieldsSchema,
  upsertContractTermSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { assetService, heartbeatService, logActivity } from "../services/index.js";
import { contractDeadlineReminderService } from "../services/contract-deadline-reminders.js";
import { actorMayUseContracts, contractService } from "../services/contracts.js";
import { contractFileService, validateContractUpload } from "../services/contract-files.js";
import { CONTRACT_FILE_CONTENT_TYPES, resolveContractUploadMaxBytes } from "../services/contract-file-guard.js";

/**
 * Contract register routes (Legal Phase 1, DUR-4852 under DUR-4851).
 *
 * Contracts are confidential, so access is narrower than the rest of the
 * company API:
 *   - Board members of the company, except read-only "viewer" members.
 *   - Agents of the same company that hold the Legal Advisor position or an
 *     explicit `contracts:access` grant. Every other agent gets 403.
 *   - Deleting a contract is board-only.
 * Every route is company-scoped through `companyScopeFromParam` (RLS plus the
 * company check), then `contractAccess()` decides inside that scope.
 *
 * Activity-log entries carry ids, enum values and the names of changed fields
 * only: never a title, summary, extracted text, term value or file name.
 *
 * Files (Legal Phase 2a, DUR-4853): PDF and DOCX go through the contract's own
 * upload routes, never the global attachment allowlist. Access is checked
 * before the body is read, the type is decided by the file's first bytes, and
 * the text is extracted in a capped worker (see services/contract-extraction.ts).
 */
export function contractRoutes(rawDb: Db, storage: StorageService, options: { maxUploadBytes?: number } = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = contractService(db, rawDb);
  const reminders = contractDeadlineReminderService(db, { heartbeat: heartbeatService(db) });

  /**
   * Keep reminder issues in step with a deadline change. The write the caller
   * asked for has already happened, so a failure here is logged (ids only) and
   * left for the next daily sweep rather than turned into an error response.
   */
  async function syncReminders(companyId: string, run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      logger.error({ err: error, companyId }, "contract deadline reminder sync failed after a deadline change");
    }
  }

  const maxUploadBytes = options.maxUploadBytes ?? resolveContractUploadMaxBytes();
  const files = contractFileService(db, storage, { maxBytes: maxUploadBytes });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes, files: 1, fields: 20 } });

  async function readUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
    });
    const file = (req as Request & { file?: { buffer: Buffer; originalname?: string } }).file;
    if (!file) throw badRequest("Missing file field 'file'");
    return file;
  }

  /** Multer's own errors become fixed 4xx messages. */
  function uploadErrors(error: unknown): never {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        throw unprocessable(`The file is larger than the ${Math.floor(maxUploadBytes / (1024 * 1024))} MB limit`);
      }
      throw badRequest("The upload could not be read");
    }
    throw error;
  }

  function scope() {
    return companyScopeFromParam(rawDb, assertCompanyAccess);
  }

  /** Runs inside the company scope, after assertCompanyAccess has accepted the actor. */
  function contractAccess() {
    return async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const companyId = req.params.companyId as string;
        if (!(await actorMayUseContracts(db, companyId, req.actor))) {
          throw forbidden(
            req.actor.type === "agent"
              ? "This agent does not have access to contracts"
              : "This caller does not have access to contracts",
          );
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  const access = () => [scope(), contractAccess()];
  const boardAccess = () => [
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    contractAccess(),
  ];

  function actorRef(actor: ReturnType<typeof getActorInfo>) {
    return { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null };
  }

  async function log(
    req: Request,
    companyId: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  // --- Term registry / aggregation (declared before the :id routes) ---
  router.get("/companies/:companyId/contract-terms", ...access(), async (req, res) => {
    res.json({ keys: await svc.listTermKeys(req.params.companyId as string) });
  });

  router.get("/companies/:companyId/contract-terms/:key/aggregate", ...access(), async (req, res) => {
    const key = contractTermKeySchema.safeParse(req.params.key);
    if (!key.success) throw badRequest("Invalid term key");
    const query = aggregateContractTermQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    const companyId = req.params.companyId as string;
    res.json(
      query.data.report === "true"
        ? await svc.aggregateTermReport(companyId, key.data, query.data)
        : await svc.aggregateTerm(companyId, key.data, query.data),
    );
  });

  // --- Reminder settings (default lead times per company; board only to change) ---
  router.get("/companies/:companyId/contract-settings", ...access(), async (req, res) => {
    res.json(await svc.getSettings(req.params.companyId as string));
  });

  router.patch(
    "/companies/:companyId/contract-settings",
    ...boardAccess(),
    validate(updateContractSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.updateSettings(companyId, req.body);
      await log(req, companyId, "contract.settings_updated", "company", companyId, {
        changed: Object.keys(req.body).sort(),
      });
      res.json(updated);
    },
  );

  // --- Deadlines across the company ---
  router.get("/companies/:companyId/contract-deadlines", ...access(), async (req, res) => {
    const query = listContractDeadlinesQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    res.json(await svc.listDeadlines(req.params.companyId as string, query.data));
  });

  // --- Contracts ---
  router.get("/companies/:companyId/contracts", ...access(), async (req, res) => {
    const query = listContractsQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    res.json(await svc.listContracts(req.params.companyId as string, query.data));
  });

  // Fixed-path routes first so ":id" never swallows them.
  router.get("/companies/:companyId/contracts/find", ...access(), async (req, res) => {
    const query = findContractsQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    res.json(await svc.findContracts(req.params.companyId as string, query.data));
  });

  router.get("/companies/:companyId/contracts/search-text", ...access(), async (req, res) => {
    const query = searchContractTextQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    const companyId = req.params.companyId as string;
    const result = await svc.searchContractText(companyId, query.data);
    // Who read contract text is on record; what they searched for and what matched is not.
    await log(req, companyId, "contract.text_searched", "company", companyId, {
      contractsInScope: result.contractsInScope,
      withExtractedText: result.withExtractedText,
      matchCount: result.matches.length,
    });
    res.json(result);
  });

  router.post("/companies/:companyId/contracts/register", ...access(), validate(registerContractSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const registered = await svc.registerContract(companyId, req.body, actorRef(getActorInfo(req)));
    await log(req, companyId, "contract.registered", "contract", registered.id, {
      type: registered.type,
      status: registered.status,
      partyCount: registered.partyCount,
      termCount: registered.termCount,
      deadlineCount: registered.deadlineCount,
      hasFile: Boolean(registered.assetId),
    });
    res.status(201).json(registered);
  });

  router.post("/companies/:companyId/contracts", ...access(), validate(createContractSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.createContract(companyId, req.body, actorRef(getActorInfo(req)));
    await log(req, companyId, "contract.created", "contract", created.id, {
      type: created.type,
      status: created.status,
      partyCount: Array.isArray(req.body.parties) ? req.body.parties.length : 0,
      hasFile: Boolean(created.assetId),
    });
    res.status(201).json(created);
  });

  // --- Files: upload, attach, re-extract, download (Legal Phase 2a, DUR-4853) ---
  /** What the operator and the agent are told about a file whose text could not be read. */
  function extractionHint(textStatus: string) {
    if (textStatus === "no_text_layer") {
      return "This file has no text layer (it looks like a scan) and needs OCR. An agent with contract access can read the PDF itself.";
    }
    if (textStatus === "failed") {
      return "The text could not be read from this file. The file is stored; you can try again with re-extract.";
    }
    return null;
  }

  /** Extracts and saves; a crash in storage or the database leaves `failed`, not a stuck `pending`. */
  async function extractSafely(companyId: string, contractId: string) {
    try {
      return await files.extractFor(companyId, contractId);
    } catch (error) {
      if (error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number") {
        const status = (error as { status: number }).status;
        if (status >= 400 && status < 500) throw error;
      }
      await svc.updateContract(companyId, contractId, { extractedText: null, textStatus: "failed" });
      return { textStatus: "failed" as const, reason: "failed" as const, truncated: false, pageCount: null, textLength: 0 };
    }
  }

  async function logExtraction(
    req: Request,
    companyId: string,
    contractId: string,
    outcome: Awaited<ReturnType<typeof extractSafely>>,
  ) {
    await log(req, companyId, "contract.text_extracted", "contract", contractId, {
      textStatus: outcome.textStatus,
      reason: outcome.reason,
      truncated: outcome.truncated,
      pageCount: outcome.pageCount,
      textLength: outcome.textLength,
    });
  }

  router.post("/companies/:companyId/contracts/upload", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const file = await readUpload(req, res).catch(uploadErrors);
    const fields = uploadContractFieldsSchema.safeParse(req.body ?? {});
    if (!fields.success) throw badRequest("Invalid contract fields", fields.error.flatten());
    const kind = validateContractUpload(file);
    const actor = actorRef(getActorInfo(req));

    const asset = await files.storeFile(companyId, file, kind, actor);
    const fallbackTitle = (file.originalname ?? "").replace(/\.[^.]*$/, "").trim().slice(0, 300) || "Untitled contract";
    const created = await svc.createContract(
      companyId,
      { ...fields.data, title: fields.data.title ?? fallbackTitle, assetId: asset.id, textStatus: "pending" },
      actor,
    );
    await log(req, companyId, "contract.created", "contract", created.id, {
      type: created.type,
      status: created.status,
      partyCount: 0,
      hasFile: true,
      fileKind: kind,
      byteSize: asset.byteSize,
    });
    const extraction = await extractSafely(companyId, created.id);
    await logExtraction(req, companyId, created.id, extraction);
    res.status(201).json({
      contract: await svc.getContract(companyId, created.id),
      extraction: { ...extraction, hint: extractionHint(extraction.textStatus) },
    });
  });

  router.post("/companies/:companyId/contracts/:id/file", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await svc.getFileState(companyId, id);
    const file = await readUpload(req, res).catch(uploadErrors);
    const kind = validateContractUpload(file);
    const asset = await files.storeFile(companyId, file, kind, actorRef(getActorInfo(req)));
    await svc.updateContract(companyId, id, { assetId: asset.id, extractedText: null, textStatus: "pending" });
    await log(req, companyId, "contract.file_attached", "contract", id, {
      fileKind: kind,
      byteSize: asset.byteSize,
    });
    const extraction = await extractSafely(companyId, id);
    await logExtraction(req, companyId, id, extraction);
    res.json({
      contract: await svc.getContract(companyId, id),
      extraction: { ...extraction, hint: extractionHint(extraction.textStatus) },
    });
  });

  router.post("/companies/:companyId/contracts/:id/re-extract", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await svc.getFileState(companyId, id);
    const extraction = await extractSafely(companyId, id);
    await logExtraction(req, companyId, id, extraction);
    res.json({
      contract: await svc.getContract(companyId, id),
      extraction: { ...extraction, hint: extractionHint(extraction.textStatus) },
    });
  });

  router.get("/companies/:companyId/contracts/:id/file", ...access(), async (req, res, next) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const state = await svc.getFileState(companyId, id);
    if (!state.assetId) throw notFound("This contract has no file");
    const asset = await assetService(db).getById(state.assetId);
    if (!asset || asset.companyId !== companyId) throw notFound("This contract has no file");
    const object = await storage.getObject(companyId, asset.objectKey);
    const isDocx = asset.contentType === CONTRACT_FILE_CONTENT_TYPES.docx;
    const contentType = isDocx ? CONTRACT_FILE_CONTENT_TYPES.docx : CONTRACT_FILE_CONTENT_TYPES.pdf;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    res.setHeader("Content-Disposition", `attachment; filename="contract${isDocx ? ".docx" : ".pdf"}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    await log(req, companyId, "contract.file_downloaded", "contract", id, {});
    object.stream.on("error", next);
    object.stream.pipe(res);
  });

  router.get("/companies/:companyId/contracts/:id", ...access(), async (req, res) => {
    const includeText = req.query.includeText === "true";
    res.json(await svc.getContract(req.params.companyId as string, req.params.id as string, { includeText }));
  });

  router.patch("/companies/:companyId/contracts/:id", ...access(), validate(updateContractSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const updated = await svc.updateContract(companyId, id, req.body);
    await log(req, companyId, "contract.updated", "contract", id, {
      changed: Object.keys(req.body).sort(),
      status: updated.status,
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/contracts/:id", ...boardAccess(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await reminders.closeForContract(companyId, id);
    const removed = await svc.removeContract(companyId, id);
    await log(req, companyId, "contract.deleted", "contract", id, { type: removed.type });
    res.json({ ok: true });
  });

  router.get("/companies/:companyId/contracts/:id/related", ...access(), async (req, res) => {
    res.json(await svc.findRelatedContracts(req.params.companyId as string, req.params.id as string));
  });

  // --- Version chain ---
  router.get("/companies/:companyId/contracts/:id/versions", ...access(), async (req, res) => {
    res.json(await svc.getVersionLog(req.params.companyId as string, req.params.id as string));
  });

  router.post(
    "/companies/:companyId/contracts/:id/link-previous-version",
    ...access(),
    validate(linkPreviousContractVersionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      // An agent never approves its own link: it needs a board-accepted confirmation (checked in the service).
      const viaAgent = req.actor.type === "agent";
      const result = await svc.linkPreviousVersion(companyId, id, req.body, { requireBoardConfirmation: viaAgent });
      await syncReminders(companyId, async () => {
        await reminders.syncContract(companyId, result.previousContractId);
        await reminders.syncContract(companyId, id);
      });
      await log(req, companyId, "contract.version_linked", "contract", id, {
        confirmationInteractionId: viaAgent ? req.body.confirmationInteractionId : null,
        previousContractId: result.previousContractId,
        versionNo: result.versionNo,
        carryDeadlines: result.carryDeadlines,
        movedDeadlines: result.movedDeadlines,
        supersededDeadlines: result.supersededDeadlines,
      });
      res.json(result);
    },
  );

  // --- Parties ---
  router.post(
    "/companies/:companyId/contracts/:id/parties",
    ...access(),
    validate(createContractPartySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const created = await svc.addParty(companyId, req.params.id as string, req.body);
      await log(req, companyId, "contract.party_added", "contract", req.params.id as string, {
        partyId: created.id,
        role: created.role,
        organizationId: created.organizationId,
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/contracts/:id/parties/:partyId",
    ...access(),
    validate(updateContractPartySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.updateParty(companyId, req.params.id as string, req.params.partyId as string, req.body);
      await log(req, companyId, "contract.party_updated", "contract", req.params.id as string, {
        partyId: updated.id,
        changed: Object.keys(req.body).sort(),
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/contracts/:id/parties/:partyId", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    await svc.removeParty(companyId, req.params.id as string, req.params.partyId as string);
    await log(req, companyId, "contract.party_removed", "contract", req.params.id as string, {
      partyId: req.params.partyId,
    });
    res.json({ ok: true });
  });

  // --- Deadlines ---
  router.post(
    "/companies/:companyId/contracts/:id/deadlines",
    ...access(),
    validate(createContractDeadlineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const created = await svc.addDeadline(companyId, req.params.id as string, req.body);
      await syncReminders(companyId, () => reminders.syncDeadline(companyId, created.id));
      await log(req, companyId, "contract.deadline_added", "contract", req.params.id as string, {
        deadlineId: created.id,
        kind: created.kind,
        dueDate: created.dueDate,
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/contracts/:id/deadlines/:deadlineId",
    ...access(),
    validate(updateContractDeadlineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.updateDeadline(
        companyId,
        req.params.id as string,
        req.params.deadlineId as string,
        req.body,
      );
      await syncReminders(companyId, () => reminders.syncDeadline(companyId, updated.id));
      await log(req, companyId, "contract.deadline_updated", "contract", req.params.id as string, {
        deadlineId: updated.id,
        changed: Object.keys(req.body).sort(),
        state: updated.state,
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/contracts/:id/deadlines/:deadlineId", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    await reminders.closeForDeadline(companyId, req.params.deadlineId as string);
    await svc.removeDeadline(companyId, req.params.id as string, req.params.deadlineId as string);
    await log(req, companyId, "contract.deadline_removed", "contract", req.params.id as string, {
      deadlineId: req.params.deadlineId,
    });
    res.json({ ok: true });
  });

  // --- Terms ---
  router.get("/companies/:companyId/contracts/:id/terms", ...access(), async (req, res) => {
    res.json(await svc.listTerms(req.params.companyId as string, req.params.id as string));
  });

  router.put(
    "/companies/:companyId/contracts/:id/terms/:key",
    ...access(),
    validate(upsertContractTermSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = contractTermKeySchema.safeParse(req.params.key);
      if (!key.success) throw badRequest("Invalid term key");
      const term = await svc.upsertTerm(companyId, req.params.id as string, key.data, req.body);
      await log(req, companyId, "contract.term_set", "contract", req.params.id as string, {
        key: term.key,
        valueKind: term.valueKind,
      });
      res.json(term);
    },
  );

  router.delete("/companies/:companyId/contracts/:id/terms/:key", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = contractTermKeySchema.safeParse(req.params.key);
    if (!key.success) throw badRequest("Invalid term key");
    await svc.removeTerm(companyId, req.params.id as string, key.data);
    await log(req, companyId, "contract.term_removed", "contract", req.params.id as string, { key: key.data });
    res.json({ ok: true });
  });

  return router;
}
