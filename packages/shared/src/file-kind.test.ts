import { describe, expect, it } from "vitest";
import { classifyFileKind, DOCUMENT_MEDIA_CONTENT_TYPES, OFFICE_DOCUMENT_CONTENT_TYPES } from "./file-kind.js";

describe("classifyFileKind", () => {
  it("classifies PDF as a document with a plain-language name", () => {
    expect(classifyFileKind({ contentType: "application/pdf" })).toEqual({
      tileLabel: "PDF",
      plainName: "PDF document",
      mediaKind: "document",
    });
  });

  it("classifies Word MIME types and extensions as Word documents", () => {
    expect(classifyFileKind({ contentType: "application/msword" })).toMatchObject({
      tileLabel: "DOC",
      plainName: "Word document",
      mediaKind: "document",
    });
    expect(
      classifyFileKind({
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toMatchObject({
      tileLabel: "DOCX",
      plainName: "Word document",
      mediaKind: "document",
    });
    expect(
      classifyFileKind({ contentType: "application/octet-stream", filename: "report.docx" }),
    ).toMatchObject({
      tileLabel: "DOCX",
      plainName: "Word document",
      mediaKind: "document",
    });
  });

  it("classifies Excel MIME types and extensions as Excel spreadsheets", () => {
    expect(classifyFileKind({ contentType: "application/vnd.ms-excel" })).toMatchObject({
      tileLabel: "XLS",
      plainName: "Excel spreadsheet",
      mediaKind: "document",
    });
    expect(
      classifyFileKind({
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toMatchObject({
      tileLabel: "XLSX",
      plainName: "Excel spreadsheet",
      mediaKind: "document",
    });
    expect(classifyFileKind({ contentType: undefined, filename: "budget.xlsx" })).toMatchObject({
      tileLabel: "XLSX",
      plainName: "Excel spreadsheet",
      mediaKind: "document",
    });
  });

  it("classifies PowerPoint, OpenDocument, and RTF as documents", () => {
    expect(
      classifyFileKind({
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).toMatchObject({ tileLabel: "PPTX", plainName: "PowerPoint presentation", mediaKind: "document" });
    expect(classifyFileKind({ contentType: "application/vnd.ms-powerpoint" })).toMatchObject({
      tileLabel: "PPT",
      plainName: "PowerPoint presentation",
      mediaKind: "document",
    });
    expect(classifyFileKind({ contentType: "application/vnd.oasis.opendocument.text" })).toMatchObject({
      tileLabel: "ODT",
      plainName: "OpenDocument text document",
      mediaKind: "document",
    });
    expect(classifyFileKind({ contentType: "application/vnd.oasis.opendocument.spreadsheet" })).toMatchObject({
      tileLabel: "ODS",
      plainName: "OpenDocument spreadsheet",
      mediaKind: "document",
    });
    expect(classifyFileKind({ contentType: "application/vnd.oasis.opendocument.presentation" })).toMatchObject({
      tileLabel: "ODP",
      plainName: "OpenDocument presentation",
      mediaKind: "document",
    });
    expect(classifyFileKind({ contentType: "application/rtf" })).toMatchObject({
      tileLabel: "RTF",
      plainName: "Rich Text document",
      mediaKind: "document",
    });
    expect(classifyFileKind({ contentType: "text/rtf" })).toMatchObject({
      tileLabel: "RTF",
      plainName: "Rich Text document",
      mediaKind: "document",
    });
  });

  it("never returns a raw MIME string as plainName", () => {
    const inputs = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "application/wasm",
      "text/plain",
      "application/octet-stream",
    ];
    for (const contentType of inputs) {
      const { plainName } = classifyFileKind({ contentType });
      expect(plainName).not.toContain("/");
    }
  });

  it("classifies image and video by subtype", () => {
    expect(classifyFileKind({ contentType: "image/png" })).toEqual({
      tileLabel: "PNG",
      plainName: "Image",
      mediaKind: "image",
    });
    expect(classifyFileKind({ contentType: "video/mp4" })).toEqual({
      tileLabel: "MP4",
      plainName: "Video",
      mediaKind: "video",
    });
    expect(classifyFileKind({ contentType: "video/quicktime" })).toEqual({
      tileLabel: "MOV",
      plainName: "Video",
      mediaKind: "video",
    });
  });

  it("classifies text-like formats as text", () => {
    expect(classifyFileKind({ contentType: "text/markdown" })).toMatchObject({ tileLabel: "MD", mediaKind: "text" });
    expect(classifyFileKind({ contentType: "text/csv" })).toMatchObject({ tileLabel: "CSV", mediaKind: "text" });
    expect(classifyFileKind({ contentType: "application/json" })).toMatchObject({
      tileLabel: "JSON",
      mediaKind: "text",
    });
    expect(classifyFileKind({ contentType: "application/xml" })).toMatchObject({
      tileLabel: "XML",
      mediaKind: "text",
    });
    expect(classifyFileKind({ contentType: "text/html" })).toMatchObject({ tileLabel: "HTML", mediaKind: "text" });
    expect(classifyFileKind({ contentType: "text/plain" })).toMatchObject({ tileLabel: "TXT", mediaKind: "text" });
  });

  it("classifies zip and wasm as file", () => {
    expect(classifyFileKind({ contentType: "application/zip" })).toMatchObject({ tileLabel: "ZIP", mediaKind: "file" });
    expect(classifyFileKind({ contentType: "application/wasm" })).toMatchObject({ tileLabel: "WASM", mediaKind: "file" });
  });

  it("falls back to a generic binary classification", () => {
    expect(classifyFileKind({ contentType: "application/octet-stream" })).toEqual({
      tileLabel: "BIN",
      plainName: "File",
      mediaKind: "file",
    });
    expect(classifyFileKind({ contentType: null, filename: null })).toEqual({
      tileLabel: "BIN",
      plainName: "File",
      mediaKind: "file",
    });
  });
});

describe("DOCUMENT_MEDIA_CONTENT_TYPES", () => {
  it("includes PDF and all office MIME types", () => {
    expect(DOCUMENT_MEDIA_CONTENT_TYPES).toEqual(
      expect.arrayContaining([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.presentation",
        "application/rtf",
        "text/rtf",
      ]),
    );
  });

  it("keeps OFFICE_DOCUMENT_CONTENT_TYPES as the document list minus PDF", () => {
    expect(OFFICE_DOCUMENT_CONTENT_TYPES).not.toContain("application/pdf");
    expect(OFFICE_DOCUMENT_CONTENT_TYPES.length).toBe(DOCUMENT_MEDIA_CONTENT_TYPES.length - 1);
  });
});
