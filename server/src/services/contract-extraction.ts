import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ContractTextStatus } from "@paperclipai/shared";
import type { ExtractionJob, ExtractionReply } from "./contract-extraction-worker.js";
import type { ContractFileKind } from "./contract-file-guard.js";

/**
 * Contract text extraction (Legal Phase 2a, DUR-4853).
 *
 * The parse runs in a worker thread with a capped heap and a wall-clock
 * timeout, so a hostile file can neither hang the API nor exhaust its memory.
 * The result is a `text_status` plus (when there is one) the text. A failure
 * never carries a message built from the document: only a fixed reason code.
 */

/** Same ceiling the contracts API accepts for `extractedText`. */
export const MAX_EXTRACTED_TEXT_CHARS = 5_000_000;
/** Fewer visible characters than this in a whole PDF means "no text layer" (a scan). */
export const MIN_TEXT_LAYER_CHARS = 20;

export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HEAP_MB = 512;
const DEFAULT_MAX_PAGES = 2_000;
const MAX_CONCURRENT_EXTRACTIONS = 2;

export type ExtractionFailureReason =
  | "timeout"
  | "out_of_memory"
  | "corrupt"
  | "encrypted"
  | "too_many_pages"
  | "rejected"
  | "failed";

export type ContractExtractionResult =
  | { textStatus: Extract<ContractTextStatus, "extracted">; text: string; truncated: boolean; pageCount: number | null }
  | { textStatus: Extract<ContractTextStatus, "no_text_layer">; text: null; truncated: false; pageCount: number | null }
  | { textStatus: Extract<ContractTextStatus, "failed">; text: null; truncated: false; reason: ExtractionFailureReason };

export type ExtractionOptions = { timeoutMs?: number; maxHeapMb?: number; maxPages?: number };

/** Postgres text cannot hold NUL; other control characters are noise in a contract. */
export function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function resolveWorker(): { url: URL; execArgv: string[] } {
  const compiled = new URL("./contract-extraction-worker.js", import.meta.url);
  if (existsSync(compiled)) return { url: compiled, execArgv: [] };
  // Source run (tsx / vitest): load the .ts worker through tsx.
  return { url: new URL("./contract-extraction-worker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

let active = 0;
const waiting: Array<() => void> = [];

async function acquireSlot() {
  if (active < MAX_CONCURRENT_EXTRACTIONS) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

function runWorker(job: ExtractionJob, options: ExtractionOptions): Promise<ExtractionReply | { timedOut: true } | { oom: true }> {
  const { url, execArgv } = resolveWorker();
  return new Promise((resolve) => {
    const worker = new Worker(url, {
      workerData: job,
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb ?? DEFAULT_MAX_HEAP_MB },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (value: ExtractionReply | { timedOut: true } | { oom: true }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS);
    worker.once("message", (reply: ExtractionReply) => finish(reply));
    worker.once("error", (error) => {
      finish((error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? { oom: true } : { ok: false, code: "failed" });
    });
    worker.once("exit", () => finish({ ok: false, code: "failed" }));
  });
}

/** Never throws: any problem becomes `textStatus: "failed"` with a reason code. */
export async function extractContractText(
  kind: ContractFileKind,
  body: Buffer,
  options: ExtractionOptions = {},
): Promise<ContractExtractionResult> {
  await acquireSlot();
  try {
    // Copy: the worker gets its own bytes and the caller's buffer stays usable.
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(body);
    const reply = await runWorker({ kind, bytes, maxPages: options.maxPages ?? DEFAULT_MAX_PAGES }, options);
    if ("timedOut" in reply) return { textStatus: "failed", text: null, truncated: false, reason: "timeout" };
    if ("oom" in reply) return { textStatus: "failed", text: null, truncated: false, reason: "out_of_memory" };
    if (!reply.ok) return { textStatus: "failed", text: null, truncated: false, reason: reply.code };

    const normalized = normalizeExtractedText(reply.text);
    if (normalized.replace(/\s/g, "").length < MIN_TEXT_LAYER_CHARS) {
      return { textStatus: "no_text_layer", text: null, truncated: false, pageCount: reply.pageCount };
    }
    const truncated = normalized.length > MAX_EXTRACTED_TEXT_CHARS;
    return {
      textStatus: "extracted",
      text: truncated ? normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS) : normalized,
      truncated,
      pageCount: reply.pageCount,
    };
  } catch {
    return { textStatus: "failed", text: null, truncated: false, reason: "failed" };
  } finally {
    releaseSlot();
  }
}
