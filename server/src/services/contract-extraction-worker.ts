import { parentPort, workerData } from "node:worker_threads";
import { inspectDocxArchive, type ContractFileKind } from "./contract-file-guard.js";

/**
 * Worker-thread entry for contract text extraction (Legal Phase 2a, DUR-4853).
 *
 * Runs in its own thread with a capped heap so a hostile or broken file can
 * take down only this thread: the parent enforces a wall-clock timeout and
 * terminates it. The file is read as data only; nothing in it is executed or
 * rendered (pdf.js runs with eval and font loading off, mammoth only reads the
 * text of word/document.xml).
 *
 * The reply carries the text or a fixed failure code, never a message built
 * from the document.
 */
export type ExtractionJob = { kind: ContractFileKind; bytes: Uint8Array; maxPages: number };
export type ExtractionReply =
  | { ok: true; text: string; pageCount: number | null }
  | { ok: false; code: "corrupt" | "encrypted" | "too_many_pages" | "rejected" | "failed" };

async function extractPdf(bytes: Uint8Array, maxPages: number): Promise<ExtractionReply> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  let pdf;
  try {
    // isEvalSupported is a real pdf.js option that unpdf's typings leave out.
    const options = { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 };
    pdf = await getDocumentProxy(bytes, options as Parameters<typeof getDocumentProxy>[1]);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return { ok: false, code: name === "PasswordException" ? "encrypted" : "corrupt" };
  }
  if (pdf.numPages > maxPages) return { ok: false, code: "too_many_pages" };
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { ok: true, text, pageCount: totalPages };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionReply> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  inspectDocxArchive(buffer);
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer });
  return { ok: true, text: result.value, pageCount: null };
}

async function run(job: ExtractionJob): Promise<ExtractionReply> {
  try {
    return job.kind === "pdf" ? await extractPdf(job.bytes, job.maxPages) : await extractDocx(job.bytes);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "DocxGuardError") return { ok: false, code: "rejected" };
    return { ok: false, code: "failed" };
  }
}

if (parentPort) {
  const port = parentPort;
  void run(workerData as ExtractionJob).then((reply) => port.postMessage(reply));
}
