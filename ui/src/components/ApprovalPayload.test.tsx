// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalPayloadRenderer,
  approvalDeployBranchInfo,
  approvalDeployChangeSummaryText,
  approvalDeployTargetCommitText,
  approvalDuplicateKey,
  approvalIsPersonaRequest,
  approvalIsRollbackDeploy,
  approvalLabel,
  approvalTargetBadge,
  approvalTechnicalReference,
  approvalUnsupportedDeployKindWarning,
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

describe("approvalUnsupportedDeployKindWarning (DUR-3923)", () => {
  it("warns on a deploy-looking kind nothing acts on, naming the kind and the fix", () => {
    const warning = approvalUnsupportedDeployKindWarning("request_board_approval", { kind: "deploy_pr", prNumber: 42 });
    expect(warning).toContain('kind "deploy_pr"');
    expect(warning).toContain('kind "deploy"');
    expect(approvalUnsupportedDeployKindWarning("request_board_approval", { kind: "rollout" })).not.toBeNull();
  });

  it("stays silent for a real deploy card and for non-deploy kinds", () => {
    expect(approvalUnsupportedDeployKindWarning("request_board_approval", { kind: "deploy", commit: "abc123" })).toBeNull();
    expect(approvalUnsupportedDeployKindWarning("request_board_approval", { kind: "merge_pr", prNumber: 1 })).toBeNull();
    expect(approvalUnsupportedDeployKindWarning("hire_agent", { kind: "deploy_pr" })).toBeNull();
    expect(approvalUnsupportedDeployKindWarning("request_board_approval", null)).toBeNull();
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

describe("approvalDeployTargetCommitText (DUR-3964)", () => {
  it("names the commit a pinned card would deploy", () => {
    expect(
      approvalDeployTargetCommitText({
        kind: "deploy",
        commit: "8623c28bd1234567890abcdef1234567890abcde",
        resolvedCommit: "8623c28bd1234567890abcdef1234567890abcde",
        resolvedCommitSource: "pinned",
      }),
    ).toBe("Will deploy commit 8623c28bd123.");
  });

  it("says a card with no commit ships the top of the branch, and which commit that was", () => {
    expect(
      approvalDeployTargetCommitText({
        kind: "deploy",
        deployBranch: "custom",
        resolvedCommit: "f00dcafe0123456789abcdef0123456789abcdef",
        resolvedCommitSource: "branch_tip",
      }),
    ).toBe("Will deploy the top of custom \u2014 that was commit f00dcafe0123 when this card was filed.");
  });

  it("stays silent on a card the server could not check", () => {
    expect(approvalDeployTargetCommitText({ kind: "deploy", commit: "abc1234" })).toBeNull();
    expect(approvalDeployTargetCommitText({ kind: "merge_pr", resolvedCommit: "abc1234" })).toBeNull();
    expect(approvalDeployTargetCommitText(null)).toBeNull();
  });
});

describe("approvalDeployChangeSummaryText (pointless-deploy-card guard)", () => {
  it("says how much changes since the version running now", () => {
    expect(
      approvalDeployChangeSummaryText({
        kind: "deploy",
        commit: "bbbbbbbbbbbb",
        changesSinceLive: {
          liveCommit: "aaaaaaaaaaaa",
          changedFileCount: 4,
          changedFiles: ["server/src/app.ts"],
          documentationOnly: false,
        },
      }),
    ).toBe("Changes 4 files since the version running now (aaaaaaaaaaaa).");
  });

  it("says when the only difference is written notes", () => {
    expect(
      approvalDeployChangeSummaryText({
        kind: "deploy",
        changesSinceLive: {
          liveCommit: "aaaaaaaaaaaa",
          changedFileCount: 1,
          changedFiles: ["README.md"],
          documentationOnly: true,
        },
      }),
    ).toBe("Changes 1 file since the version running now (aaaaaaaaaaaa) \u2014 written notes only.");
  });

  it("stays silent on a card the server could not check", () => {
    expect(approvalDeployChangeSummaryText({ kind: "deploy", commit: "abc1234" })).toBeNull();
    expect(approvalDeployChangeSummaryText({ kind: "merge_pr", changesSinceLive: { liveCommit: "a" } })).toBeNull();
    expect(approvalDeployChangeSummaryText(null)).toBeNull();
  });
});

describe("approvalIsRollbackDeploy (DUR-3952)", () => {
  it("is true only for a deploy filed with allowBackwardDeploy", () => {
    expect(approvalIsRollbackDeploy({ kind: "deploy", commit: "abc1234", allowBackwardDeploy: true })).toBe(true);
    expect(approvalIsRollbackDeploy({ kind: "deploy", commit: "abc1234" })).toBe(false);
    expect(approvalIsRollbackDeploy({ kind: "deploy", commit: "abc1234", allowBackwardDeploy: false })).toBe(false);
    expect(approvalIsRollbackDeploy({ kind: "merge_pr", allowBackwardDeploy: true })).toBe(false);
    expect(approvalIsRollbackDeploy(null)).toBe(false);
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

  it("renders a model_boost card in plain language: the ask, why, where the boss stands, and what approve/deny do", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "model_boost",
            issueId: "11111111-1111-4111-8111-111111111111",
            agentId: "22222222-2222-4222-8222-222222222222",
            agentName: "Backend Engineer",
            requestedModel: "opus",
            requestedEffort: "high",
            reason: "This refactor spans 40 files and I keep losing track.",
            estimatedExtraCostCents: 500,
            maxSpendCents: 2000,
            durationMinutes: 240,
            title: "Paperclip — Backend Engineer asks to use Opus at high effort for this task, up to $20, for the next 4 hours",
            summary: "Why: This refactor spans 40 files and I keep losing track.",
            bossReview: {
              bossAgentId: "33333333-3333-4333-8333-333333333333",
              bossName: "Engineering Lead",
              status: "forwarded",
              requestedAt: "2026-09-07T10:00:00.000Z",
              deadlineAt: "2026-09-07T10:30:00.000Z",
              decidedAt: "2026-09-07T10:05:00.000Z",
              note: "Worth it, the task is genuinely stuck.",
            },
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Backend Engineer asks to use Opus at high effort for this task, up to $20, for the next 4 hours");
    expect(text).toContain("This refactor spans 40 files and I keep losing track.");
    expect(text).toContain("Model: Opus · Effort: high · Money cap: $20 · Time window: 4 hours");
    expect(text).toContain("Engineering Lead passed this on to you: Worth it, the task is genuinely stuck.");
    expect(text).toContain("If you deny, it keeps working on its normal setting.");
    expect(text).not.toContain("estimatedExtraCostCents");
    expect(text).not.toContain("maxSpendCents");

    act(() => {
      root.unmount();
    });
  });

  it("tells the operator a model_boost card is still with the boss, and that they may decide anyway", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "model_boost",
            agentName: "Writer",
            requestedEffort: "xhigh",
            reason: "Long piece.",
            maxSpendCents: 500,
            title: "Writer asks to work at very high effort for this task, up to $5, for the next 4 hours",
            bossReview: {
              bossAgentId: "33333333-3333-4333-8333-333333333333",
              bossName: "Editor",
              status: "awaiting_boss",
              requestedAt: "2026-09-07T10:00:00.000Z",
              deadlineAt: "2026-09-07T10:30:00.000Z",
            },
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Waiting for Editor to weigh in first.");
    expect(text).toContain("You can still decide now if you do not want to wait.");
    expect(text).toContain("Effort: very high");

    act(() => {
      root.unmount();
    });
  });

  it("renders a persona_publish card as plain language: the post text, disclosure, why, and what approve does (DUR-134)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "persona_publish",
            personaId: "6f1c7f0e-3a1b-4c2d-9e8f-0a1b2c3d4e5f",
            personaAccountId: "6f1c7f0e-3a1b-4c2d-9e8f-0a1b2c3d4e60",
            personaPostId: "6f1c7f0e-3a1b-4c2d-9e8f-0a1b2c3d4e61",
            platform: "fanvue",
            reason: "warmup",
            caption: "Golden hour on the pier tonight.",
            disclosureText: "This content was created with AI assistance.",
            title: "Post to Maja — Fanvue",
            summary: "This account is new, so her first 5 posts need your OK before they go out.",
            isPersonaRequest: true,
            personaDisplayName: "Maja",
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Post to Maja — Fanvue");
    expect(text).toContain("What Maja wants to post");
    expect(text).toContain("Golden hour on the pier tonight.");
    expect(text).toContain("This content was created with AI assistance.");
    expect(text).toContain("New account: her first posts need your OK");
    expect(text).toContain("her first 5 posts need your OK");
    expect(text).toContain("If you approve");
    expect(text).toContain("If you reject, it is never posted.");
    // No plumbing on the card: no UUIDs, no raw JSON keys.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toContain("personaPostId");

    act(() => {
      root.unmount();
    });
  });

  it("says plainly when no AI disclosure is added to a persona post", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "persona_publish",
            reason: "requires_approval_channel",
            caption: "Hi",
            disclosureText: null,
            title: "Post to Maja — X",
            summary: "Posts to Maja — X always need your OK before they go out.",
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("This account always needs your OK");
    expect(text).toContain("Not added -- disclosure is switched off for this account.");

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

  it("shows the quality check's findings on a done_gate_exhausted card (plainSummary, no summary)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "done_gate_exhausted",
            issueId: "8e6f9a2e-9e2a-4f7a-9c8b-1a2b3c4d5e6f",
            title: "Paperclip — decide whether \"Add a language switcher\" is really finished",
            plainSummary:
              "The agent has said \"Add a language switcher\" (PAP-12) is finished 3 times, and an independent quality check disagreed 2 times.\n\nThe last time, the check found:\n1. No test was added for the switcher.",
            recommendedAction:
              "Look at the task and the findings. If the work is actually fine, mark the task done yourself.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("disagreed 2 times");
    expect(container.textContent).toContain("1. No test was added for the switcher.");
    expect(container.textContent).toContain("mark the task done yourself");
    expect(container.textContent).not.toContain("\"plainSummary\"");

    act(() => {
      root.unmount();
    });
  });

  it("prefers summary over plainSummary when a card carries both", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "done_gate_exhausted",
            title: "decide whether the task is really finished",
            summary: "Summary text the card should show.",
            plainSummary: "Duplicate text that must not be shown twice.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Summary text the card should show.");
    expect(container.textContent).not.toContain("Duplicate text that must not be shown twice.");

    act(() => {
      root.unmount();
    });
  });

  it("renders feature_launch payload fields as a plain-language card, not raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            kind: "feature_launch",
            issueId: "8e6f9a2e-9e2a-4f7a-9c8b-1a2b3c4d5e6f",
            title: "Operator changelog page",
            whatIsNew: "A read-only changelog page that lists finished, user-facing changes.",
            whereToFindIt: "New \"Changelog\" link in the sidebar, next to Approvals.",
            whatToTest: "Open the Changelog page and confirm recent launches show up in order.",
            whatIfItFails: "Hide the sidebar link; the underlying data is unaffected.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Operator changelog page");
    expect(container.textContent).toContain(
      "A read-only changelog page that lists finished, user-facing changes.",
    );
    expect(container.textContent).toContain(
      "New \"Changelog\" link in the sidebar, next to Approvals.",
    );
    expect(container.textContent).toContain(
      "Open the Changelog page and confirm recent launches show up in order.",
    );
    expect(container.textContent).toContain("Hide the sidebar link; the underlying data is unaffected.");
    expect(container.textContent).not.toContain("\"whatIsNew\"");

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

  // DUR-3971: the hire card has to say which kind of person is being employed.
  it("says the hire answers straight away in chat when that is what was chosen", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{ name: "Front desk", role: "general", laneAEnabled: true }}
        />,
      );
    });

    expect(container.textContent).toContain("Front desk");
    expect(container.textContent).toContain("Also answers straight away in chat");
    expect(container.textContent).not.toContain("laneAEnabled");

    act(() => {
      root.unmount();
    });
  });

  it("says the hire goes away and works on tasks when the card carries no choice", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{ name: "Analyst", role: "general" }}
        />,
      );
    });

    expect(container.textContent).toContain("Goes away and works on tasks");

    act(() => {
      root.unmount();
    });
  });
});
