import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, contracts } from "@paperclipai/db";
import type { ContractTextStatus } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { assetService } from "./assets.js";
import {
  extractContractText,
  type ExtractionFailureReason,
  type ExtractionOptions,
} from "./contract-extraction.js";
import {
  CONTRACT_FILE_CONTENT_TYPES,
  CONTRACT_FILE_EXTENSIONS,
  detectContractFileKind,
  docxHasMacroPart,
  type ContractFileKind,
} from "./contract-file-guard.js";

/**
 * Contract files (Legal Phase 2a, DUR-4853): store the uploaded PDF/DOCX as a
 * company asset, extract its text, and keep `contracts.extracted_text` and
 * `text_status` in step with it.
 *
 * Confidentiality: error messages are fixed strings (never a file name, never
 * document text) and the result of an extraction reports a status and a reason
 * code only.
 */

type ActorRef = { agentId?: string | null; userId?: string | null };

export type ContractExtractionOutcome = {
  textStatus: ContractTextStatus;
  /** Why it failed, when it did. */
  reason: ExtractionFailureReason | null;
  truncated: boolean;
  pageCount: number | null;
  /** Characters of text stored (not the text). */
  textLength: number;
};

/**
 * Checks an upload before anything is stored. The kind comes from the file's
 * first bytes; the client's name and MIME type only have to agree with it, so
 * a renamed executable or a PDF called `.docx` is refused.
 */
export function validateContractUpload(file: { buffer: Buffer; originalname?: string | null }): ContractFileKind {
  if (!file.buffer || file.buffer.length === 0) throw unprocessable("The file is empty");
  const kind = detectContractFileKind(file.buffer);
  if (!kind) throw unprocessable("Only PDF and Word (.docx) files can be uploaded as a contract");
  const extension = path.extname(file.originalname ?? "").toLowerCase();
  if (extension && extension !== CONTRACT_FILE_EXTENSIONS[kind]) {
    throw unprocessable("The file content does not match its file extension");
  }
  // A macro-enabled document is refused outright. Every other structural problem
  // (truncated, zip bomb, not really Word) is handled by the extraction worker:
  // the file is kept and the contract gets text_status=failed.
  if (kind === "docx" && docxHasMacroPart(file.buffer)) {
    throw unprocessable("Macro-enabled Word documents are not accepted");
  }
  return kind;
}

async function readCapped(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw unprocessable("The stored file is larger than the allowed size");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function contractFileService(
  db: Db,
  storage: StorageService,
  options: { maxBytes: number; extraction?: ExtractionOptions },
) {
  const assetsSvc = assetService(db);

  /** Stores a validated file and records it as an asset of the company. */
  async function storeFile(
    companyId: string,
    file: { buffer: Buffer; originalname?: string | null },
    kind: ContractFileKind,
    actor: ActorRef,
  ) {
    const stored = await storage.putFile({
      companyId,
      namespace: "contracts",
      originalFilename: file.originalname || null,
      // Our own detected type, never the client's.
      contentType: CONTRACT_FILE_CONTENT_TYPES[kind],
      body: file.buffer,
    });
    return assetsSvc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
    });
  }

  /**
   * Extracts the text of the contract's current file and saves it. The write is
   * pinned to the asset that was read, so a file replaced mid-extraction cannot
   * receive the old file's text.
   */
  async function extractFor(companyId: string, contractId: string): Promise<ContractExtractionOutcome> {
    const row = await db
      .select({ id: contracts.id, assetId: contracts.assetId })
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Contract not found");
    if (!row.assetId) throw unprocessable("This contract has no file to read");
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, row.assetId), eq(assets.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!asset) throw unprocessable("This contract has no file to read");

    const object = await storage.getObject(companyId, asset.objectKey);
    const body = await readCapped(object.stream, options.maxBytes);
    const kind = detectContractFileKind(body);
    const result = kind
      ? await extractContractText(kind, body, options.extraction)
      : ({ textStatus: "failed", text: null, truncated: false, reason: "corrupt" } as const);

    await db
      .update(contracts)
      .set({
        extractedText: result.text,
        textStatus: result.textStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId), eq(contracts.assetId, asset.id)));

    return {
      textStatus: result.textStatus,
      reason: "reason" in result ? result.reason : null,
      truncated: result.truncated,
      pageCount: "pageCount" in result ? result.pageCount : null,
      textLength: result.text?.length ?? 0,
    };
  }

  return { storeFile, extractFor, kindOf: (buffer: Buffer) => detectContractFileKind(buffer) };
}
