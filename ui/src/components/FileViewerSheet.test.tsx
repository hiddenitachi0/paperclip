// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceFileContent } from "@paperclipai/shared";
import type { FileViewerUrlState } from "@/context/FileViewerContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { describeDenial, FileContentViewer, FileViewerMetadataRow } from "./FileViewerSheet";

describe("describeDenial", () => {
  it("returns the curated body for too_large regardless of fallback", () => {
    expect(describeDenial("too_large", "").body).toBe(
      "This file exceeds the supported preview size.",
    );
    expect(describeDenial("too_large", "ignored fallback").body).toBe(
      "This file exceeds the supported preview size.",
    );
  });

  it("does not leak the raw denial code as body when fallback is empty", () => {
    for (const code of [
      "denied_by_policy_sensitive",
      "outside_workspace_root",
      "workspace_archived",
      "binary_unsupported",
      "remote_preview_unsupported",
    ]) {
      const { body } = describeDenial(code, "");
      expect(body).not.toBe(code);
      expect(body).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("describes unsupported previews in terms of text, image, and video", () => {
    expect(describeDenial("unsupported_content", "").body).toBe(
      "This file does not have a text, image, or video preview available.",
    );
  });

  it("falls back to the generic message for unknown codes with empty fallback", () => {
    const { body, title } = describeDenial("", "");
    expect(title).toBe("Can't preview this file");
    expect(body).toBe("The viewer was unable to load this file.");
  });

  it("prefers a human-readable server message for unknown codes", () => {
    const { body } = describeDenial("unknown_code", "Server refused the request.");
    expect(body).toBe("Server refused the request.");
  });
});

describe("FileContentViewer", () => {
  function content(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
    return {
      resource: {
        kind: "file",
        provider: "local_fs",
        title: "notes.txt",
        displayPath: "notes.txt",
        workspaceLabel: "Workspace",
        workspaceKind: "project_workspace",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        contentType: "text/plain; charset=utf-8",
        byteSize: 18,
        previewKind: "text",
        capabilities: { preview: true, download: true, listChildren: false },
      },
      content: {
        encoding: "utf8",
        data: "one very long line",
      },
      ...overrides,
    };
  }

  it("wraps text content instead of forcing horizontal preformatted scrolling", () => {
    const markup = renderToStaticMarkup(<FileContentViewer content={content()} highlightedLine={null} />);
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("break-words");
  });

  it("reserves code gutter space for at least four digit line numbers", () => {
    const markup = renderToStaticMarkup(
      <FileContentViewer
        content={content({
          content: {
            encoding: "utf8",
            data: "one\ntwo\nthree",
          },
        })}
        highlightedLine={null}
      />,
    );
    expect(markup).toContain("calc(4ch + 2rem)");
  });

  it("renders video previews with native controls", () => {
    const markup = renderToStaticMarkup(
      <FileContentViewer
        content={content({
          resource: {
            ...content().resource,
            title: "demo.mp4",
            displayPath: "demo.mp4",
            contentType: "video/mp4",
            previewKind: "video",
          },
          content: {
            encoding: "base64",
            data: "AAAA",
          },
        })}
        highlightedLine={null}
      />,
    );
    expect(markup).toContain("<video");
    expect(markup).toContain("controls");
    expect(markup).toContain("data:video/mp4;base64,AAAA");
  });

  it("shows an icon toggle for Markdown files and defaults to rendered Markdown", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider>
        <FileContentViewer
          content={content({
            resource: {
              ...content().resource,
              title: "README.md",
              displayPath: "docs/README.md",
              contentType: "text/markdown; charset=utf-8",
            },
            content: {
              encoding: "utf8",
              data: "# Heading\n\nBody",
            },
          })}
          highlightedLine={null}
        />
      </ThemeProvider>,
    );

    expect(markup).toContain("Markdown preview mode");
    expect(markup).toContain("Show rendered Markdown");
    expect(markup).toContain("Show raw Markdown");
    expect(markup).toContain("README.md rendered Markdown");
    expect(markup).not.toContain("README.md source");
  });

  it("does not show the Markdown toggle for non-Markdown text files", () => {
    const markup = renderToStaticMarkup(<FileContentViewer content={content()} highlightedLine={null} />);

    expect(markup).not.toContain("Markdown preview mode");
    expect(markup).toContain("notes.txt source");
  });
});

describe("FileViewerMetadataRow", () => {
  const state: FileViewerUrlState = {
    path: "videos/90-days-paperclip/tweet.md",
    workspace: "auto",
    line: null,
    column: null,
    projectId: null,
    workspaceId: null,
  };

  it("reserves metadata row height while file details load", () => {
    const markup = renderToStaticMarkup(<FileViewerMetadataRow state={state} />);
    expect(markup).toContain("min-h-[18px]");
    expect(markup).toContain("Loading file details");
  });

  it("does not render the raw previewKind enum", () => {
    const markup = renderToStaticMarkup(
      <FileViewerMetadataRow
        state={state}
        resolvedResource={{
          kind: "file",
          provider: "local_fs",
          title: "report.pdf",
          displayPath: "report.pdf",
          workspaceLabel: "Files",
          workspaceKind: "project_workspace",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          contentType: "application/pdf",
          byteSize: 1024,
          previewKind: "pdf",
          capabilities: { preview: true, download: true, listChildren: false },
        }}
      />,
    );
    expect(markup).not.toContain("previewKind");
    expect(markup).not.toMatch(/>\s*pdf\s*</i);
  });
});

// Filip (the non-developer operator) must never see internal jargon or raw
// MIME strings anywhere in the file viewer, regardless of file type.
const BANNED_SUBSTRINGS = [
  "artifact",
  "work product",
  "workspace",
  "attachment",
  "media kind",
  "object key",
  "previewkind",
  "execution",
];
const BANNED_MIME_PATTERN = /\b(application|text|image|video|audio)\/[a-z0-9.+-]+/i;

function assertNoLeakedJargon(markup: string) {
  const withoutAttributes = markup.replace(/\s[a-zA-Z-]+="[^"]*"/g, "");
  for (const banned of BANNED_SUBSTRINGS) {
    expect(withoutAttributes.toLowerCase()).not.toContain(banned);
  }
  expect(withoutAttributes).not.toMatch(BANNED_MIME_PATTERN);
}

describe("FileContentViewer plain-language fallback", () => {
  function unsupportedContent(overrides: Partial<WorkspaceFileContent["resource"]> = {}): WorkspaceFileContent {
    return {
      resource: {
        kind: "file",
        provider: "local_fs",
        title: "budget.xlsx",
        displayPath: "budget.xlsx",
        workspaceLabel: "Files",
        workspaceKind: "project_workspace",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: 2048,
        previewKind: "unsupported",
        capabilities: { preview: true, download: true, listChildren: false },
        ...overrides,
      },
      content: { encoding: "base64", data: "" },
    };
  }

  it.each([
    { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", title: "budget.xlsx" },
    {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      title: "brief.docx",
    },
    { contentType: "application/zip", title: "assets.zip" },
    { contentType: null, title: "mystery.bin" },
  ])("shows an honest file card with no leaked jargon or MIME strings for $title", ({ contentType, title }) => {
    const markup = renderToStaticMarkup(
      <FileContentViewer
        content={unsupportedContent({ contentType, title, displayPath: title })}
        highlightedLine={null}
        downloadUrl="/api/files/download?token=abc"
      />,
    );
    expect(markup).toContain(title);
    expect(markup).toContain("Download");
    assertNoLeakedJargon(markup);
  });

  it("shows real filename and file size, and a visible download control", () => {
    const markup = renderToStaticMarkup(
      <FileContentViewer
        content={unsupportedContent()}
        highlightedLine={null}
        downloadUrl="/api/files/download?token=abc"
      />,
    );
    expect(markup).toContain("budget.xlsx");
    expect(markup).toContain("2.0 KB");
    expect(markup).toContain(">Download<");
  });
});

describe("FileContentViewer PDF preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom does not implement Blob URL creation; stub it so the effect that
    // builds the blob: URL for the sandboxed iframe can run.
    URL.createObjectURL = vi.fn(() => "blob:mock-pdf-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function pdfContent(): WorkspaceFileContent {
    return {
      resource: {
        kind: "file",
        provider: "local_fs",
        title: "report.pdf",
        displayPath: "report.pdf",
        workspaceLabel: "Files",
        workspaceKind: "project_workspace",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        contentType: "application/pdf",
        byteSize: 4096,
        previewKind: "pdf",
        capabilities: { preview: true, download: true, listChildren: false },
      },
      content: { encoding: "base64", data: btoa("%PDF-1.4 fake") },
    };
  }

  it("renders the PDF in a blob: iframe sandboxed to allow-same-origin only (never allow-scripts)", async () => {
    flushSync(() => {
      root.render(<FileContentViewer content={pdfContent()} highlightedLine={null} />);
    });
    // The blob: URL is built in a passive effect, which flushSync does not
    // guarantee runs synchronously — wait a tick for it to commit.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src")).toBe("blob:mock-pdf-url");
    expect(iframe!.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(iframe!.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("revokes the blob URL on unmount", async () => {
    const localContainer = document.createElement("div");
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);
    flushSync(() => {
      localRoot.render(<FileContentViewer content={pdfContent()} highlightedLine={null} />);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => localRoot.unmount());
    localContainer.remove();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-pdf-url");
  });
});
