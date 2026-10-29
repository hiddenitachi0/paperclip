// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedWorkspaceResource, WorkspaceFileContent } from "@paperclipai/shared";
import { FileViewerSheet } from "./FileViewerSheet";

const useQueryMock = vi.fn();
const viewerMock = {
  state: null,
  browse: false,
  query: null,
  folderPath: null,
  browseProjectId: null,
  browseWorkspaceId: null,
  open: vi.fn(),
  updateBrowseState: vi.fn(),
  close: vi.fn(),
  backToFiles: vi.fn(),
};

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: unknown) => useQueryMock(options),
  };
});

vi.mock("@/context/FileViewerContext", () => ({
  useRequiredFileViewer: () => viewerMock,
}));

vi.mock("@/components/WorkspaceFileBrowser", () => ({
  WorkspaceFileBrowser: () => null,
}));

vi.mock("@/components/WorkspaceFileMarkdownBody", () => ({
  WorkspaceFileMarkdownBody: ({ children }: { children: string }) => (
    <div data-testid="mock-rendered-markdown">Rendered Markdown: {children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok<T>(data: T) {
  return { data, isFetching: false, isError: false, error: null, refetch: vi.fn(async () => ({ data })) };
}

const resolvedResource: ResolvedWorkspaceResource = {
  kind: "file",
  provider: "git_worktree",
  title: "tweet.md",
  displayPath: "videos/90-days-paperclip/tweet.md",
  workspaceLabel: "Isolated workspace",
  workspaceKind: "execution_workspace",
  workspaceId: "ws-1",
  contentType: "text/markdown; charset=utf-8",
  byteSize: 42,
  previewKind: "text",
  capabilities: { preview: true, download: true, listChildren: false },
};

const content: WorkspaceFileContent = {
  resource: resolvedResource,
  content: {
    encoding: "utf8",
    data: "hello from the file",
  },
};

describe("FileViewerSheet copy actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const key = JSON.stringify(options.queryKey ?? []);
      if (key.includes('"content"')) return ok(content);
      return ok(resolvedResource);
    });
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    window.history.pushState({}, "", "/PAP/issues/PAP-10629?file=videos%2F90-days-paperclip%2Ftweet.md");
  });

  afterEach(async () => {
    flushSync(() => root.unmount());
    // Radix FocusScope (inside the Dialog) defers its unmount cleanup to a
    // setTimeout(0) that builds a `new CustomEvent(...)` and dispatches it on
    // the dialog container. Let that timer fire now, while jsdom is still the
    // active environment. Left pending, it can run after Vitest has torn the
    // environment down and restored Node's CustomEvent, and jsdom then throws
    // "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not
    // of type 'Event'" as an unhandled error that fails the whole run. Timers
    // with the same delay fire in scheduling order, so this one runs after it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function renderSheet() {
    flushSync(() => {
      root.render(
        <FileViewerSheet
          issueId="issue-1"
          state={{
            path: "videos/90-days-paperclip/tweet.md",
            workspace: "auto",
            line: null,
            column: null,
            projectId: null,
            workspaceId: null,
          }}
          open
        />,
      );
    });
  }

  async function click(label: string) {
    const button = document.body.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    // The copy handlers update state after awaiting the clipboard promise, and
    // outside act() React would commit that update from a setImmediate task.
    // A fixed setTimeout(0) wait could fire first when the event loop is busy,
    // and the assertion then saw the DOM before "Copied ..." was rendered.
    // act() keeps flushing React work until the queue is empty, so the
    // assertions always see the committed result.
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("copies file contents and shows confirmation", async () => {
    renderSheet();

    await click("Copy file contents");

    expect(writeText).toHaveBeenCalledWith("hello from the file");
    expect(document.body.textContent).toContain("Copied contents");
  });

  it("copies the current file view link and shows confirmation", async () => {
    renderSheet();

    await click("Copy link to this file view");

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(document.body.textContent).toContain("Copied link");
  });

  it("renders a keyboard-addressable file tree resize separator", () => {
    renderSheet();
    const separator = document.body.querySelector('[role="separator"][aria-label="Resize file tree"]');
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute("aria-valuenow")).toBe("288");
  });

  it("keeps split panes unframed so file selection does not shift the browser", () => {
    renderSheet();
    const separator = document.body.querySelector('[role="separator"][aria-label="Resize file tree"]');
    const browserPane = separator?.previousElementSibling;
    const previewPane = separator?.nextElementSibling;

    expect(browserPane?.className).not.toContain("border");
    expect(browserPane?.className).not.toContain("rounded");
    expect(previewPane?.className).not.toContain("border");
    expect(previewPane?.className).not.toContain("rounded");
  });

  it("defaults Markdown files to rendered mode and switches back to raw source", async () => {
    useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const key = JSON.stringify(options.queryKey ?? []);
      if (key.includes('"content"')) {
        return ok({
          ...content,
          resource: {
            ...resolvedResource,
            title: "launch.md",
            displayPath: "docs/launch.md",
            contentType: "text/markdown; charset=utf-8",
          },
          content: { encoding: "utf8", data: "# Launch note\n\nRendered body" },
        });
      }
      return ok({
        ...resolvedResource,
        title: "launch.md",
        displayPath: "docs/launch.md",
        contentType: "text/markdown; charset=utf-8",
      });
    });
    renderSheet();

    expect(document.body.querySelector('[aria-label="launch.md rendered Markdown"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="launch.md source"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="Show rendered Markdown"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Show raw Markdown"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Rendered Markdown: # Launch note");

    await click("Show raw Markdown");

    expect(document.body.querySelector('[aria-label="launch.md source"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="launch.md rendered Markdown"]')).toBeNull();
  });
});
