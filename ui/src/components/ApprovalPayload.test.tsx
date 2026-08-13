// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalIcon, approvalLabel, typeIcon } from "./ApprovalPayload";

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

  it("labels deploy requests distinctly from generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        kind: "deploy",
        title: "Ship checkout fix to prod",
      }),
    ).toBe("Deploy: Ship checkout fix to prod");
  });
});

describe("approvalIcon", () => {
  it("uses a distinct icon for deploy requests", () => {
    expect(approvalIcon("request_board_approval", { kind: "deploy" })).not.toBe(
      typeIcon.request_board_approval,
    );
  });

  it("falls back to the type icon for non-deploy board approvals", () => {
    expect(approvalIcon("request_board_approval", { title: "Reply with an ASCII frog" })).toBe(
      typeIcon.request_board_approval,
    );
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

  it("renders deploy request payloads with project/commit/note fields", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "deploy",
            projectId: "9f2c1b34-4e3a-4f0e-9a5f-2b9a4c9d7e01",
            workspaceId: "3a1e9c22-7b4d-4a1e-9c22-7b4d4a1e9c22",
            commit: "a1b2c3d4",
            title: "Ship checkout fix to prod",
            note: "Rolling out the payment retry fix before the weekend.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Ship checkout fix to prod");
    expect(container.textContent).toContain("Target project");
    expect(container.textContent).toContain("9f2c1b34-4e3a-4f0e-9a5f-2b9a4c9d7e01");
    expect(container.textContent).toContain("Commit");
    expect(container.textContent).toContain("a1b2c3d4");
    expect(container.textContent).toContain("Rolling out the payment retry fix before the weekend.");
    expect(container.textContent).not.toContain("\"kind\"");

    act(() => {
      root.unmount();
    });
  });
});
