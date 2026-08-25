// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    disableIssueQuicklook,
    ...props
  }: {
    to: string;
    children: ReactNode;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} data-disable-issue-quicklook={disableIssueQuicklook ? "true" : undefined} {...props}>
      {children}
    </a>
  ),
}));

import { ArtifactCard } from "./ArtifactCard";
import type { CompanyArtifact } from "@/api/artifacts";

function makeArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "art-1",
    source: "attachment",
    mediaKind: "image",
    title: "Hero shot",
    previewText: null,
    contentType: "image/png",
    contentPath: "/files/art-1.png",
    openPath: "/files/art-1.png",
    downloadPath: "/files/art-1.png?download=1",
    issue: { id: "issue-1", identifier: "PAP-10306", title: "Landing visuals" },
    project: { id: "proj-1", name: "Paperclip App" },
    createdByAgent: { id: "agent-1", name: "ClaudeCoder" },
    updatedAt: "2026-06-01T12:00:00.000Z",
    href: "/issues/PAP-10306#attachment-art-1",
    ...overrides,
  };
}

describe("ArtifactCard", () => {
  it("renders an image preview with cover image and links to the issue anchor", () => {
    const markup = renderToStaticMarkup(<ArtifactCard artifact={makeArtifact()} />);
    expect(markup).toContain('href="/issues/PAP-10306#attachment-art-1"');
    expect(markup).toContain('data-disable-issue-quicklook="true"');
    expect(markup).toContain('data-media-kind="image"');
    expect(markup).toContain("rounded-[8px]");
    expect(markup).toContain('src="/files/art-1.png"');
    expect(markup).toContain("object-cover");
    expect(markup).toContain("Hero shot");
    expect(markup).toContain("flex h-7 items-start justify-between gap-2");
    expect(markup).toContain("leading-7");
    expect(markup).toContain("Last edited Jun 1, 2026");
    expect(markup).not.toContain("Landing visuals");
    expect(markup).not.toContain("Edited ");
  });

  it("renders only the artifact subject and absolute metadata under the preview", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        artifact={makeArtifact({
          title: "Social launch clip",
          issue: { id: "issue-2", identifier: "PAP-10370", title: "Make artifact page look like this" },
          updatedAt: "2025-10-08T12:00:00.000Z",
          createdByAgent: null,
        })}
      />,
    );

    expect(markup).toContain("Social launch clip");
    expect(markup).toContain("Last edited Oct 8, 2025");
    expect(markup).not.toContain("Make artifact page look like this");
    expect(markup).not.toContain(">PAP-10370<");
  });

  it("renders a video preview with a video element and play glyph", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        artifact={makeArtifact({ mediaKind: "video", contentType: "video/mp4", contentPath: "/files/clip.mp4" })}
      />,
    );
    expect(markup).toContain('data-media-kind="video"');
    expect(markup).toContain("<video");
    expect(markup).toContain('preload="metadata"');
  });

  it("seeks video previews after metadata loads so a thumbnail frame is painted", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        <ArtifactCard
          artifact={makeArtifact({ mediaKind: "video", contentType: "video/mp4", contentPath: "/files/clip.mp4" })}
        />,
      );
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.dataset.frameReady).toBe("false");

    Object.defineProperty(video, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_METADATA,
    });

    flushSync(() => {
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    });

    expect(video.currentTime).toBe(0.05);

    flushSync(() => {
      video.dispatchEvent(new Event("seeked", { bubbles: true }));
    });

    expect(video.dataset.frameReady).toBe("true");

    flushSync(() => root.unmount());
    container.remove();
  });

  it("reveals video previews if the browser does not report seek completion", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      flushSync(() => {
        root.render(
          <ArtifactCard
            artifact={makeArtifact({ mediaKind: "video", contentType: "video/mp4", contentPath: "/files/clip.mp4" })}
          />,
        );
      });

      const video = container.querySelector("video") as HTMLVideoElement;
      expect(video).not.toBeNull();
      expect(video.dataset.frameReady).toBe("false");

      flushSync(() => {
        video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
      });

      expect(video.currentTime).toBe(0.05);
      expect(video.dataset.frameReady).toBe("false");

      flushSync(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(video.dataset.frameReady).toBe("true");
    } finally {
      flushSync(() => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it("renders a falling-back video placeholder when no content path exists", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard artifact={makeArtifact({ mediaKind: "video", contentPath: null })} />,
    );
    expect(markup).toContain('data-media-kind="video"');
    expect(markup).not.toContain("<video");
  });

  it("renders a document preview excerpt", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        artifact={makeArtifact({
          source: "document",
          mediaKind: "document",
          contentType: "text/markdown",
          contentPath: null,
          previewText: "This is the plan preview excerpt.",
        })}
      />,
    );
    expect(markup).toContain('data-media-kind="document"');
    expect(markup).toContain("This is the plan preview excerpt.");
    expect(markup).toContain("text-base");
    expect(markup).toContain("leading-6");
    expect(markup).toContain("max-h-full");
    expect(markup).toContain("overflow-hidden");
    expect(markup).not.toContain('data-lucide="file-text"');
  });

  it("renders a placeholder for empty artifacts without an image or video", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        artifact={makeArtifact({ mediaKind: "empty", contentType: null, contentPath: null, previewText: null })}
      />,
    );
    expect(markup).toContain('data-media-kind="empty"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<video");
  });

  it("omits open/download actions when no file paths exist (e.g. documents)", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        artifact={makeArtifact({
          source: "document",
          mediaKind: "document",
          contentPath: null,
          openPath: null,
          downloadPath: null,
          previewText: "Plan body",
        })}
      />,
    );
    expect(markup).not.toContain('aria-label="Download file"');
    expect(markup).not.toContain('aria-label="Open file in new tab"');
  });

  it("reserves the same title row height when file actions are absent", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        artifact={makeArtifact({
          openPath: null,
          downloadPath: null,
          createdByAgent: null,
        })}
      />,
    );

    expect(markup).toContain("flex h-7 items-start justify-between gap-2");
    expect(markup).toContain("leading-7");
    expect(markup).toContain("Last edited Jun 1, 2026");
    expect(markup).not.toContain('aria-label="Download file"');
    expect(markup).not.toContain('aria-label="Open file in new tab"');
  });

  it("always shows the open/download controls, not just on hover", () => {
    const markup = renderToStaticMarkup(<ArtifactCard artifact={makeArtifact()} />);
    expect(markup).not.toContain("opacity-0");
  });

  // Filip (the non-developer operator) must never see internal jargon or raw
  // MIME strings in a rendered card, regardless of file type.
  const BANNED_SUBSTRINGS = [
    "artifact",
    "work product",
    "workspace",
    "attachment",
    "media kind",
    "object key",
    "previewKind",
    "execution",
  ];
  const BANNED_MIME_PATTERN = /\b(application|text|image|video|audio)\/[a-z0-9.+-]+/i;

  it.each([
    { mediaKind: "image" as const, contentType: "image/png" },
    { mediaKind: "video" as const, contentType: "video/mp4" },
    { mediaKind: "document" as const, contentType: "application/pdf" },
    {
      mediaKind: "document" as const,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    { mediaKind: "text" as const, contentType: "text/csv" },
    { mediaKind: "file" as const, contentType: "application/zip" },
    { mediaKind: "file" as const, contentType: "application/octet-stream" },
    { mediaKind: "empty" as const, contentType: null },
  ])("never leaks internal terms or raw MIME strings for mediaKind=$mediaKind", ({ mediaKind, contentType }) => {
    const markup = renderToStaticMarkup(
      <ArtifactCard artifact={makeArtifact({ mediaKind, contentType, previewText: null, contentPath: null })} />,
    );
    // Strip every attribute value (href/src/download/etc. carry internal ids
    // and query params, which are exempt) before checking the visible text.
    const withoutAttributes = markup.replace(/\s[a-zA-Z-]+="[^"]*"/g, "");
    for (const banned of BANNED_SUBSTRINGS) {
      expect(withoutAttributes.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    expect(withoutAttributes).not.toMatch(BANNED_MIME_PATTERN);
  });
});
