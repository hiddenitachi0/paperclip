import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskContextFingerprint,
  buildPaperclipTaskMarkdown,
  mergeCoalescedContextSnapshot,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

// DUR-3943: a representative "spec-sized" issue -- a multi-section
// description like the tickets agents actually get, a parent chain, and a
// human follow-up comment. Sizes are what the prompt carries on every turn.
const representativeIssue = {
  id: "issue-3943",
  identifier: "DUR-3943",
  title: "Cut agent context cost: 80% of spend is re-read context, not generation",
  workMode: "standard",
  description: [
    "## Context",
    "",
    "Measured over a 24h window: cached input tokens 630,422,218; fresh input 58,907; output 4,450,898.",
    "The cached-input to output ratio is about 142:1, so roughly 80% of the bill is context handling.",
    "",
    "## Changes, ranked by leverage",
    "",
    ...Array.from({ length: 5 }, (_, index) =>
      `${index + 1}. ${"Change description sentence that explains what to do and why it matters. ".repeat(12).trim()}`),
    "",
    "## Acceptance",
    "",
    "- cost per run is visible in the UI and not $0.00",
    "- median cachedInputTokens per run drops materially (target 30%+)",
    "- session reuse rate rises well above the current 9%",
    "",
    "```ts",
    "// example snippet the agent is expected to read",
    "function normalizeBilledCostCents(costUsd: number | null | undefined): number {",
    "  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return 0;",
    "  return Math.max(0, Math.round(costUsd * 100));",
    "}",
    "```",
  ].join("\n"),
};

const representativeAncestors = [
  { id: "issue-epic", identifier: "DUR-3900", title: "Cost-efficient Paperclip fork", status: "in_progress", priority: "high" },
  { id: "issue-goal", identifier: "DUR-3000", title: "Platform stability and cost", status: "in_progress", priority: "medium" },
];

const representativeWakeComment = {
  id: "comment-42",
  body: [
    "Please start with item 1 and item 2 -- they carry most of the value.",
    "Do not change the model or the budgets; report before/after numbers from usage_json.",
    "When you are done, leave a plain-language summary I can read without knowing the code.",
  ].join("\n"),
};

describe("buildPaperclipTaskMarkdown (DUR-3943 context trimming)", () => {
  it("points at the wake comment instead of repeating it when the wake payload already inlines it", () => {
    const full = buildPaperclipTaskMarkdown({
      issue: representativeIssue,
      ancestors: representativeAncestors,
      wakeComment: representativeWakeComment,
    });
    const deduped = buildPaperclipTaskMarkdown({
      issue: representativeIssue,
      ancestors: representativeAncestors,
      wakeComment: representativeWakeComment,
      wakeCommentInlinedInWakePayload: true,
    });

    expect(full).toContain(representativeWakeComment.body);
    expect(deduped).not.toContain(representativeWakeComment.body);
    expect(deduped).toContain('Latest wake comment: "comment-42" (full text is in the wake payload of this prompt; not repeated here).');
    // Everything else is untouched: the description, the ancestor chain, the closing line.
    expect(deduped).toContain("Issue description:");
    expect(deduped).toContain("- Parent: DUR-3900 Cost-efficient Paperclip fork (in_progress) [high]");
    expect(deduped).toContain("Use this task context as the current assignment.");
    expect(deduped!.length).toBeLessThan(full!.length - representativeWakeComment.body.length + 120);
  });

  it("keeps the planning directive that depends on the wake comment when the body is deduplicated", () => {
    const deduped = buildPaperclipTaskMarkdown({
      issue: { ...representativeIssue, workMode: "planning" },
      wakeComment: representativeWakeComment,
      wakeCommentInlinedInWakePayload: true,
    });
    expect(deduped).toContain("Update the plan only. Do not write code or perform implementation work.");
  });

  it("renders the short resume form without the description or ancestor chain", () => {
    const resume = buildPaperclipTaskMarkdown({
      issue: representativeIssue,
      ancestors: representativeAncestors,
      wakeComment: representativeWakeComment,
      wakeCommentInlinedInWakePayload: true,
      unchangedTaskContextForResume: true,
    });

    expect(resume).toContain('- Issue: "DUR-3943"');
    expect(resume).toContain(`- Title: ${JSON.stringify(representativeIssue.title)}`);
    expect(resume).toContain("Issue description and parent / ancestor context: unchanged since your previous run in this session");
    expect(resume).not.toContain("Issue description:");
    expect(resume).not.toContain("Authoritative parent / ancestor context:");
    expect(resume).not.toContain("DUR-3900");
    expect(resume).not.toContain("## Context");
    expect(resume).toContain('Latest wake comment: "comment-42"');
    expect(resume).toContain("Use this task context as the current assignment.");
  });

  it("keeps work-mode directives in the short resume form", () => {
    const askResume = buildPaperclipTaskMarkdown({
      issue: { ...representativeIssue, workMode: "ask" },
      unchangedTaskContextForResume: true,
    });
    expect(askResume).toContain("Ask mode directive:");
    expect(askResume).not.toContain("Issue description:");
  });

  it("ignores the resume flag when there is no issue (a bare comment wake still renders in full)", () => {
    const bare = buildPaperclipTaskMarkdown({
      issue: null,
      wakeComment: representativeWakeComment,
      unchangedTaskContextForResume: true,
    });
    expect(bare).toContain(representativeWakeComment.body);
    expect(bare).not.toContain("unchanged since your previous run");
  });

  it("reports the assembled task-block size before/after for the representative fixture", () => {
    const before = buildPaperclipTaskMarkdown({
      issue: representativeIssue,
      ancestors: representativeAncestors,
      wakeComment: representativeWakeComment,
    })!;
    const afterFresh = buildPaperclipTaskMarkdown({
      issue: representativeIssue,
      ancestors: representativeAncestors,
      wakeComment: representativeWakeComment,
      wakeCommentInlinedInWakePayload: true,
    })!;
    const afterResume = buildPaperclipTaskMarkdown({
      issue: representativeIssue,
      ancestors: representativeAncestors,
      wakeComment: representativeWakeComment,
      wakeCommentInlinedInWakePayload: true,
      unchangedTaskContextForResume: true,
    })!;

    // Printed so the numbers land in the test output for the DUR-3943 report.
    console.info(
      `[DUR-3943] task block chars: before=${before.length} afterFresh=${afterFresh.length} afterResume=${afterResume.length}`,
    );
    expect(afterFresh.length).toBeLessThan(before.length);
    expect(afterResume.length).toBeLessThan(afterFresh.length);
    // The resume form drops the whole spec-sized description: at least 80% smaller here.
    expect(afterResume.length).toBeLessThan(before.length * 0.2);
  });
});

describe("buildPaperclipTaskContextFingerprint", () => {
  it("is stable for the same issue and ancestors regardless of the wake comment", () => {
    const a = buildPaperclipTaskContextFingerprint({ issue: representativeIssue, ancestors: representativeAncestors });
    const b = buildPaperclipTaskContextFingerprint({
      issue: { ...representativeIssue },
      ancestors: representativeAncestors.map((ancestor) => ({ ...ancestor })),
    });
    expect(a).toMatch(/^v1:sha256:[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes when the description, title, work mode, or an ancestor's status changes", () => {
    const base = buildPaperclipTaskContextFingerprint({ issue: representativeIssue, ancestors: representativeAncestors });
    expect(
      buildPaperclipTaskContextFingerprint({
        issue: { ...representativeIssue, description: `${representativeIssue.description}\n\nEdited.` },
        ancestors: representativeAncestors,
      }),
    ).not.toBe(base);
    expect(
      buildPaperclipTaskContextFingerprint({
        issue: { ...representativeIssue, title: "Renamed" },
        ancestors: representativeAncestors,
      }),
    ).not.toBe(base);
    expect(
      buildPaperclipTaskContextFingerprint({
        issue: { ...representativeIssue, workMode: "planning" },
        ancestors: representativeAncestors,
      }),
    ).not.toBe(base);
    expect(
      buildPaperclipTaskContextFingerprint({
        issue: representativeIssue,
        ancestors: [{ ...representativeAncestors[0], status: "done" }, representativeAncestors[1]],
      }),
    ).not.toBe(base);
  });

  it("ignores ancestors beyond the rendered limit and returns null without an issue", () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ id: `a-${index}`, title: `Ancestor ${index}` }));
    const seven = [...six, { id: "a-6", title: "Ancestor 6" }];
    const eight = [...seven, { id: "a-7", title: "Ancestor 7" }];
    // Only the first six render; the 7th and 8th only affect the "truncated" marker, which is the same for both.
    expect(buildPaperclipTaskContextFingerprint({ issue: representativeIssue, ancestors: seven })).toBe(
      buildPaperclipTaskContextFingerprint({ issue: representativeIssue, ancestors: eight }),
    );
    expect(buildPaperclipTaskContextFingerprint({ issue: representativeIssue, ancestors: six })).not.toBe(
      buildPaperclipTaskContextFingerprint({ issue: representativeIssue, ancestors: seven }),
    );
    expect(buildPaperclipTaskContextFingerprint({ issue: null })).toBeNull();
  });
});

describe("buildPaperclipTaskMarkdown", () => {
  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"planning\"");
    expect(assignment).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");

    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("Make the plan only.");
  });

  it("adds accepted-plan continuation guidance for standard-work issues when the wake is flagged as a plan continuation", () => {
    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-2",
        identifier: "PAP-415",
        title: "Implement the fix",
        workMode: "standard",
        description: null,
      },
      acceptedPlanContinuation: true,
    });

    expect(acceptedConfirmation).toContain("Accepted plan directive:");
    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("- Work mode: \"planning\"");
  });

  it("adds answer-only guidance for ask-mode issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-ask",
        identifier: "PAP-416",
        title: "Explain the tradeoff",
        workMode: "ask",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"ask\"");
    expect(assignment).toContain("Ask mode directive:");
    expect(assignment).toContain("Answer the question directly in the issue thread.");
    expect(assignment).toContain("Do not write implementation code");
    expect(assignment).toContain("do not produce an implementation plan");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.checkboxSelection).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves resolved interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
    expect(merged.checkboxSelection).toEqual({
      prompt: "Delete selected files?",
      selectedOptionIds: ["file-b"],
      selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
    });
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      paperclipWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        paperclipWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});
