import { describe, expect, it } from "vitest";
import { extractContractText, normalizeExtractedText } from "../services/contract-extraction.js";
import {
  DEFAULT_DOCX_GUARD_LIMITS,
  DocxGuardError,
  detectContractFileKind,
  inspectDocxArchive,
  resolveContractUploadMaxBytes,
} from "../services/contract-file-guard.js";
import { buildDocx, buildPdf, buildZip, docxEntries } from "./helpers/contract-fixtures.js";

const SENTENCE = "The tenant shall give six months written notice before the lease ends.";

// Deflating 120 MB takes seconds on a busy CI runner: build the bomb once, and
// give the tests that inflate large archives more than vitest's 5 s default.
const SLOW = { timeout: 60_000 };
let cachedBomb: Buffer | null = null;
function zipBomb() {
  cachedBomb ??= buildZip([...docxEntries([SENTENCE]), { name: "word/media/bomb.bin", data: Buffer.alloc(120 * 1024 * 1024) }]);
  return cachedBomb;
}

function guardCode(buffer: Buffer, limits = DEFAULT_DOCX_GUARD_LIMITS) {
  try {
    inspectDocxArchive(buffer, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(DocxGuardError);
    return (error as DocxGuardError).code;
  }
  return null;
}

describe("detectContractFileKind (DUR-4853)", () => {
  it("goes by the first bytes, not by what the client called the file", () => {
    expect(detectContractFileKind(buildPdf(SENTENCE))).toBe("pdf");
    expect(detectContractFileKind(buildDocx([SENTENCE]))).toBe("docx");
    expect(detectContractFileKind(Buffer.from("MZ\x90\x00 an executable"))).toBeNull();
    expect(detectContractFileKind(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectContractFileKind(Buffer.alloc(0))).toBeNull();
    expect(detectContractFileKind(Buffer.from("%PD"))).toBeNull();
  });
});

describe("resolveContractUploadMaxBytes (DUR-4853)", () => {
  it("defaults to 25 MB, honours the setting and never exceeds 100 MB", () => {
    expect(resolveContractUploadMaxBytes(undefined)).toBe(25 * 1024 * 1024);
    expect(resolveContractUploadMaxBytes("nonsense")).toBe(25 * 1024 * 1024);
    expect(resolveContractUploadMaxBytes("-5")).toBe(25 * 1024 * 1024);
    expect(resolveContractUploadMaxBytes("1048576")).toBe(1048576);
    expect(resolveContractUploadMaxBytes("999999999999")).toBe(100 * 1024 * 1024);
  });
});

describe("inspectDocxArchive (DUR-4853)", () => {
  it("accepts a normal Word document", () => {
    expect(guardCode(buildDocx([SENTENCE]))).toBeNull();
  });

  it("rejects a non-Word zip, a macro-enabled document and encrypted entries", () => {
    expect(guardCode(buildZip([{ name: "readme.txt", data: Buffer.from("hi") }]))).toBe("not_a_word_document");
    expect(
      guardCode(buildZip([...docxEntries([SENTENCE]), { name: "word/vbaProject.bin", data: Buffer.from("macro") }])),
    ).toBe("macro_enabled");
    const encrypted = docxEntries([SENTENCE]);
    encrypted[2] = { ...encrypted[2], encrypted: true };
    expect(guardCode(buildZip(encrypted))).toBe("encrypted_entry");
  });

  it("rejects too many entries", () => {
    const many = [...docxEntries([SENTENCE])];
    for (let index = 0; index < 20; index += 1) many.push({ name: `word/media/${index}.txt`, data: Buffer.from("x") });
    expect(guardCode(buildZip(many), { ...DEFAULT_DOCX_GUARD_LIMITS, maxEntries: 10 })).toBe("too_many_entries");
  });

  it("rejects a zip bomb: a few hundred KB that inflates past the cap", SLOW, () => {
    const bomb = zipBomb();
    expect(bomb.length).toBeLessThan(500 * 1024);
    expect(guardCode(bomb)).toMatch(/^(entry_too_large|archive_too_large)$/);
  });

  it("rejects a high-ratio archive that stays under the size caps", SLOW, () => {
    const squashed = buildZip([...docxEntries([SENTENCE]), { name: "word/media/zeros.bin", data: Buffer.alloc(40 * 1024 * 1024) }]);
    expect(guardCode(squashed)).toBe("compression_ratio");
  });

  it("does not trust declared sizes: an entry that lies about its size is caught by the real inflate", SLOW, () => {
    const lying = buildZip([
      ...docxEntries([SENTENCE]),
      { name: "word/media/liar.bin", data: Buffer.alloc(20 * 1024 * 1024), declaredSize: 10 },
    ]);
    const code = guardCode(lying, { ...DEFAULT_DOCX_GUARD_LIMITS, maxEntryUncompressedBytes: 1024 * 1024 });
    expect(code).toMatch(/^(archive_too_large|size_mismatch)$/);
    expect(guardCode(lying)).toBe("size_mismatch");
  });

  it("rejects truncated archives and random zip-looking bytes", () => {
    const docx = buildDocx([SENTENCE]);
    expect(guardCode(docx.subarray(0, docx.length - 40))).toBe("not_a_zip");
    expect(guardCode(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]))).toBe("not_a_zip");
  });
});

describe("normalizeExtractedText (DUR-4853)", () => {
  it("strips NUL and control characters and collapses blank runs", () => {
    expect(normalizeExtractedText("a\u0000b\r\nc\u0007\n\n\n\n\n\nd  \n")).toBe("ab\nc\n\n\nd");
  });
});

describe("extractContractText (DUR-4853)", () => {
  it("extracts the text of a DOCX", async () => {
    const result = await extractContractText("docx", buildDocx([SENTENCE, "Rent is NOK 12 000 per month."]));
    expect(result.textStatus).toBe("extracted");
    expect(result.text).toContain("six months written notice");
    expect(result.text).toContain("NOK 12 000");
  });

  it("extracts the text layer of a PDF", async () => {
    const result = await extractContractText("pdf", buildPdf(SENTENCE));
    expect(result.textStatus).toBe("extracted");
    expect(result.text).toContain("six months written notice");
  });

  it("marks an image-only (scanned) PDF as no_text_layer", async () => {
    const result = await extractContractText("pdf", buildPdf());
    expect(result).toMatchObject({ textStatus: "no_text_layer", text: null });
  });

  it("fails closed on a truncated PDF", async () => {
    const pdf = buildPdf(SENTENCE);
    const result = await extractContractText("pdf", pdf.subarray(0, Math.floor(pdf.length / 3)));
    expect(result.textStatus).toBe("failed");
    expect(result.text).toBeNull();
  });

  it("fails closed on garbage that starts with %PDF-", async () => {
    const result = await extractContractText("pdf", Buffer.from("%PDF-1.7\nthis is not a pdf at all"));
    expect(result.textStatus).toBe("failed");
  });

  it("fails closed on a zip-bomb DOCX without reading it into memory", SLOW, async () => {
    const bomb = zipBomb();
    const result = await extractContractText("docx", bomb);
    expect(result).toMatchObject({ textStatus: "failed", reason: "rejected" });
  });

  it("fails closed on a truncated DOCX", async () => {
    const docx = buildDocx([SENTENCE]);
    const result = await extractContractText("docx", docx.subarray(0, docx.length - 40));
    expect(result.textStatus).toBe("failed");
  });

  it("stops a run that outlives the timeout", async () => {
    const result = await extractContractText("pdf", buildPdf(SENTENCE), { timeoutMs: 1 });
    expect(result).toMatchObject({ textStatus: "failed", reason: "timeout" });
  });

  it("never puts document text in a failure result", SLOW, async () => {
    const bomb = zipBomb();
    const failures = [
      await extractContractText("docx", bomb),
      await extractContractText("pdf", Buffer.from("%PDF-1.7\n" + SENTENCE)),
    ];
    for (const failure of failures) expect(JSON.stringify(failure)).not.toContain("tenant");
  });
});
