// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalPayloadRenderer,
  approvalDuplicateKey,
  approvalLabel,
  approvalTargetBadge,
  approvalTechnicalReference,
} from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("approvalTechnicalReference", () => {
  it("surfaces payload.technicalReference for the detail view's secondary line", () => {
    expect(
      approvalTechnicalReference({
        title: "Paperclip — sub-tasks inherit the model and effort you set on a task",
        technicalReference: "Technical reference: fork repo, pull request #12",
      }),
    ).toBe("Technical reference: fork repo, pull request #12");
  });

  it("returns null when the payload carries no technical reference", () => {
    expect(approvalTechnicalReference({ title: "Approve hosting spend" })).toBeNull();
  });
});

describe("approvalTargetBadge", () => {
  it("shows the PR number for a merge_pr board approval", () => {
    expect(approvalTargetBadge({ kind: "merge_pr", repo: "fork", prNumber: 103 })).toBe("PR #103");
  });

  it("shows a short commit for a deploy board approval", () => {
    expect(approvalTargetBadge({ kind: "deploy", commit: "ac5efb821234567" })).toBe("commit ac5efb8");
  });

  it("returns null for kinds with nothing to badge", () => {
    expect(approvalTargetBadge({ kind: "instructions_change" })).toBeNull();
    expect(approvalTargetBadge(null)).toBeNull();
  });
});

describe("approvalDuplicateKey", () => {
  it("keys merge_pr approvals by repo + PR number", () => {
    expect(approvalDuplicateKey({ kind: "merge_pr", repo: "fork", prNumber: 100 })).toBe(
      "merge_pr:fork:100",
    );
  });

  it("treats the same PR number in different repos as distinct", () => {
    const a = approvalDuplicateKey({ kind: "merge_pr", repo: "fork", prNumber: 100 });
    const b = approvalDuplicateKey({ kind: "merge_pr", repo: "dashboard", prNumber: 100 });
    expect(a).not.toBe(b);
  });

  it("keys deploy approvals by commit", () => {
    expect(approvalDuplicateKey({ kind: "deploy", commit: "abc123" })).toBe("deploy:abc123");
  });

  it("returns null when there's nothing to key on", () => {
    expect(approvalDuplicateKey({ kind: "merge_pr" })).toBeNull();
    expect(approvalDuplicateKey({ kind: "deploy" })).toBeNull();
    expect(approvalDuplicateKey({ kind: "hire_agent" })).toBeNull();
    expect(approvalDuplicateKey(null)).toBeNull();
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});
