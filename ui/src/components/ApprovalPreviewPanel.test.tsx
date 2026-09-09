// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewEnvironment } from "@paperclipai/shared";
import { ApprovalPreviewPanel } from "./ApprovalPreviewPanel";
import { approvalsApi, type ApprovalPreviewView } from "../api/approvals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function preview(overrides: Partial<PreviewEnvironment> = {}): PreviewEnvironment {
  return {
    approvalId: "approval-1",
    companyId: "company-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    status: "ready",
    previewUrl: "/_preview/workspace-1/",
    ref: { kind: "branch", value: "build/thing", label: "the latest code on build/thing" },
    message: "A copy of the latest code on build/thing is running.",
    failureReason: null,
    startedAt: null,
    lastUsedAt: null,
    idleTimeoutMinutes: 60,
    ...overrides,
  };
}

async function renderPanel(
  view: ApprovalPreviewView,
  props: Partial<React.ComponentProps<typeof ApprovalPreviewPanel>> = {},
) {
  vi.spyOn(approvalsApi, "getPreview").mockResolvedValue(view);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <ApprovalPreviewPanel
          approvalId="approval-1"
          approvalType="request_board_approval"
          payload={{ kind: "merge_pr", branch: "build/thing", repo: "x/y", prNumber: 4 }}
          approvalStatus="pending"
          {...props}
        />
      </QueryClientProvider>,
    );
  });
  // Let the query resolve and React flush the result.
  for (let attempt = 0; attempt < 20 && container.textContent === ""; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe("ApprovalPreviewPanel", () => {
  it("offers to start a preview when the project is set up for one", async () => {
    await renderPanel({
      preview: null,
      availability: {
        canStart: true,
        blockedReason: null,
        ref: { kind: "branch", value: "build/thing", label: "the latest code on build/thing" },
      },
    });
    expect(container.textContent).toContain("Preview this before approving");
    expect(container.textContent).toContain("the latest code on build/thing");
  });

  it("shows the link once a preview is running", async () => {
    await renderPanel({
      preview: preview(),
      availability: { canStart: true, blockedReason: null, ref: null },
    });
    const link = container.querySelector('a[href="/_preview/workspace-1/"]');
    expect(link).not.toBeNull();
    expect(container.textContent).toContain("Open the preview");
    expect(container.textContent).toContain("Close it");
  });

  it("says in plain words why a preview cannot be started", async () => {
    await renderPanel({
      preview: null,
      availability: {
        canStart: false,
        blockedReason: 'This project has no "how to start a preview" command yet.',
        ref: null,
      },
    });
    expect(container.textContent).toContain('This project has no "how to start a preview" command yet.');
    const button = container.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("stays out of the way on a card that has no code to look at", async () => {
    const spy = vi.spyOn(approvalsApi, "getPreview");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalPreviewPanel
            approvalId="approval-1"
            approvalType="hire_agent"
            payload={{ name: "Designer" }}
            approvalStatus="pending"
          />
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });

  it("stays out of the way once the card has been decided", async () => {
    const spy = vi.spyOn(approvalsApi, "getPreview");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalPreviewPanel
            approvalId="approval-1"
            approvalType="request_board_approval"
            payload={{ kind: "deploy", commit: "abc1234" }}
            approvalStatus="approved"
          />
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });
});
