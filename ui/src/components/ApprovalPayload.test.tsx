// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalPayloadRenderer,
  approvalDeployBranchInfo,
  approvalDuplicateKey,
  approvalIsPersonaRequest,
  approvalLabel,
  approvalTargetBadge,
  approvalTechnicalReference,
  credentialRequestFields,
  credentialRequestFriendlyName,
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

describe("approvalDeployBranchInfo", () => {
  it("flags a mismatch when the commit's branch differs from the deploy branch (DUR-221/DUR-226)", () => {
    expect(
      approvalDeployBranchInfo({ kind: "deploy", commit: "d55e5704", sourceBranch: "master", deployBranch: "custom" }),
    ).toEqual({ sourceBranch: "master", deployBranch: "custom", mismatch: true });
  });

  it("reports no mismatch when the commit's branch matches the deploy branch", () => {
    expect(
      approvalDeployBranchInfo({ kind: "deploy", commit: "abc123", sourceBranch: "custom", deployBranch: "custom" }),
    ).toEqual({ sourceBranch: "custom", deployBranch: "custom", mismatch: false });
  });

  it("returns null when the backend hasn't resolved a source branch yet", () => {
    expect(approvalDeployBranchInfo({ kind: "deploy", commit: "abc123" })).toBeNull();
  });

  it("returns null for non-deploy approvals", () => {
    expect(approvalDeployBranchInfo({ kind: "merge_pr", sourceBranch: "master" })).toBeNull();
    expect(approvalDeployBranchInfo(null)).toBeNull();
  });
});

describe("approvalIsPersonaRequest", () => {
  it("is true only when the server tagged the payload as persona-related", () => {
    expect(approvalIsPersonaRequest({ isPersonaRequest: true, personaDisplayName: "Maja" })).toBe(true);
    expect(approvalIsPersonaRequest({ envKey: "META_IG_TOKEN" })).toBe(false);
    expect(approvalIsPersonaRequest(null)).toBe(false);
  });
});

describe("credentialRequestFields / credentialRequestFriendlyName (DUR-177 item 16)", () => {
  it("never surfaces the raw envKey for a persona-tagged request", () => {
    const payload = {
      envKey: "META_IG_TOKEN",
      name: "Instagram access token, from the Meta app you set up",
      isPersonaRequest: true,
      personaDisplayName: "Maja",
    };
    const fields = credentialRequestFields(payload);
    expect(fields.isPersonaRequest).toBe(true);
    expect(fields.personaDisplayName).toBe("Maja");
    expect(credentialRequestFriendlyName(payload)).toBe(
      "Maja's Instagram access token, from the Meta app you set up",
    );
  });

  it("keeps the existing envKey-based label for a non-persona request", () => {
    const payload = { envKey: "GITHUB_TOKEN" };
    expect(credentialRequestFields(payload).isPersonaRequest).toBe(false);
    expect(credentialRequestFriendlyName(payload)).toBe("Value for GITHUB_TOKEN");
  });

  it("falls back to a generic label when there is no envKey and no persona tag", () => {
    expect(credentialRequestFriendlyName({})).toBe("Credential value");
  });

  it("does not treat isPersonaRequest as sufficient without a persona display name", () => {
    // Defensive: the server always pairs these two fields, but the client
    // helper should not invent persona phrasing from a half-populated payload.
    const payload = { envKey: "META_IG_TOKEN", isPersonaRequest: true };
    expect(credentialRequestFields(payload).isPersonaRequest).toBe(false);
    expect(credentialRequestFriendlyName(payload)).toBe("Value for META_IG_TOKEN");
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

  it("hides the raw environment variable name for a persona-tagged credential_request (DUR-177 item 16)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="credential_request"
          payload={{
            envKey: "META_IG_TOKEN",
            name: "Instagram access token, from the Meta app you set up",
            isPersonaRequest: true,
            personaDisplayName: "Maja",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Maja's Instagram access token, from the Meta app you set up");
    expect(container.textContent).not.toContain("META_IG_TOKEN");
    expect(container.textContent).not.toContain("Environment variable");

    act(() => {
      root.unmount();
    });
  });

  it("still shows the environment variable name for a non-persona credential_request", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="credential_request"
          payload={{ envKey: "GITHUB_TOKEN", name: "GitHub token" }}
        />,
      );
    });

    expect(container.textContent).toContain("GITHUB_TOKEN");
    expect(container.textContent).toContain("Environment variable");

    act(() => {
      root.unmount();
    });
  });
});
