import { describe, expect, it } from "vitest";
import {
  DEPLOY_CHANGED_FILES_STAMP_LIMIT,
  DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH,
  addApprovalCommentSchema,
  addDeployItemsSchema,
  deployCardItemSchema,
  deployRequestPayloadSchema,
  featureLaunchRequestPayloadSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  toolGrantRequestPayloadSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });

  it("validates the deploy request approval payload convention", () => {
    const payload = {
      kind: "deploy" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      commit: "abc1234",
      title: "Deploy dashboard main",
      note: "Routine deploy after merge.",
    };
    expect(deployRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(deployRequestPayloadSchema.parse({ ...payload, commit: undefined }).commit).toBeUndefined();
    expect(() => deployRequestPayloadSchema.parse({ ...payload, kind: "other" })).toThrow();
    expect(() => deployRequestPayloadSchema.parse({ ...payload, extra: "nope" })).toThrow();
    const { title: _title, ...missingTitle } = payload;
    expect(() => deployRequestPayloadSchema.parse(missingTitle)).toThrow();
    // DUR-3952: the runner's rollback opt-in is a real field now, not an
    // "unrecognized key" the strict parse throws on.
    expect(deployRequestPayloadSchema.parse({ ...payload, allowBackwardDeploy: true }).allowBackwardDeploy).toBe(true);
    expect(() => deployRequestPayloadSchema.parse({ ...payload, allowBackwardDeploy: "yes" })).toThrow();
  });

  it("accepts the server-stamped 'what will really deploy' commit on the deploy payload (DUR-3964)", () => {
    const payload = {
      kind: "deploy" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      title: "Deploy dashboard main",
      note: "Routine deploy after merge.",
      resolvedCommit: "8623c28bd1234567890abcdef1234567890abcde",
      resolvedCommitSource: "branch_tip" as const,
    };
    expect(deployRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(deployRequestPayloadSchema.parse({ ...payload, resolvedCommitSource: "pinned" }).resolvedCommitSource)
      .toBe("pinned");
    expect(deployRequestPayloadSchema.parse({ ...payload, resolvedCommit: undefined }).resolvedCommit)
      .toBeUndefined();
    expect(() => deployRequestPayloadSchema.parse({ ...payload, resolvedCommitSource: "guessed" })).toThrow();
    expect(() => deployRequestPayloadSchema.parse({ ...payload, resolvedCommit: "" })).toThrow();
  });

  it("accepts the server-stamped change summary on the deploy payload (pointless-deploy-card guard)", () => {
    const payload = {
      kind: "deploy" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      commit: "bbbbbbbbbbbb",
      title: "Deploy dashboard main",
      note: "Routine deploy after merge.",
      changesSinceLive: {
        liveCommit: "aaaaaaaaaaaa",
        changedFileCount: 2,
        changedFiles: ["server/src/app.ts", "docs/notes.md"],
        documentationOnly: false,
      },
    };
    expect(deployRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(deployRequestPayloadSchema.parse({ ...payload, changesSinceLive: undefined }).changesSinceLive)
      .toBeUndefined();
    expect(() =>
      deployRequestPayloadSchema.parse({
        ...payload,
        changesSinceLive: { ...payload.changesSinceLive, extra: "nope" },
      }),
    ).toThrow();
    expect(() =>
      deployRequestPayloadSchema.parse({
        ...payload,
        changesSinceLive: { ...payload.changesSinceLive, changedFileCount: -1 },
      }),
    ).toThrow();
  });

  it("caps the change summary so a big deploy cannot bloat the stored card", () => {
    const payload = {
      kind: "deploy" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      commit: "bbbbbbbbbbbb",
      title: "Deploy dashboard main",
      note: "Routine deploy after merge.",
      changesSinceLive: {
        liveCommit: "aaaaaaaaaaaa",
        // A deploy really can change hundreds of files; the count stays true,
        // only the listed paths are capped.
        changedFileCount: 812,
        changedFiles: Array.from({ length: DEPLOY_CHANGED_FILES_STAMP_LIMIT }, (_, i) => `server/src/file${i}.ts`),
        documentationOnly: false,
      },
    };
    expect(deployRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(() =>
      deployRequestPayloadSchema.parse({
        ...payload,
        changesSinceLive: {
          ...payload.changesSinceLive,
          changedFiles: [...payload.changesSinceLive.changedFiles, "server/src/one-too-many.ts"],
        },
      }),
    ).toThrow();
    expect(() =>
      deployRequestPayloadSchema.parse({
        ...payload,
        changesSinceLive: {
          ...payload.changesSinceLive,
          changedFiles: ["x".repeat(DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH + 1)],
        },
      }),
    ).toThrow();
  });

  it("accepts acknowledgedDuplicateOfApprovalId on the deploy payload (DUR-138)", () => {
    const payload = {
      kind: "deploy" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      title: "Deploy dashboard main",
      note: "Corrected re-deploy after a stale approval was left open.",
      acknowledgedDuplicateOfApprovalId: "33333333-3333-4333-8333-333333333333",
    };
    expect(deployRequestPayloadSchema.parse(payload).acknowledgedDuplicateOfApprovalId).toBe(
      payload.acknowledgedDuplicateOfApprovalId,
    );
  });

  it("validates the tool-grant request approval payload convention", () => {
    const payload = {
      kind: "tool_grant" as const,
      agentId: "11111111-1111-4111-8111-111111111111",
      server: { name: "search", url: "https://search.example.com/mcp", transport: "http" as const },
      reason: "Needs to look up current docs while writing the integration.",
      title: "Grant Builder access to the search tool",
    };
    expect(toolGrantRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => toolGrantRequestPayloadSchema.parse({ ...payload, kind: "other" })).toThrow();
    expect(() => toolGrantRequestPayloadSchema.parse({ ...payload, extra: "nope" })).toThrow();
    const { reason: _reason, ...missingReason } = payload;
    expect(() => toolGrantRequestPayloadSchema.parse(missingReason)).toThrow();
    expect(() =>
      toolGrantRequestPayloadSchema.parse({
        ...payload,
        server: { name: "search", command: "echo", url: "https://x" },
      }),
    ).toThrow();
  });

  it("validates the feature-launch request approval payload convention (DUR-313)", () => {
    const payload = {
      kind: "feature_launch" as const,
      issueId: "11111111-1111-4111-8111-111111111111",
      whatIsNew: "Operators can now filter the changelog by company.",
      whereToFindIt: "Changelog page, top-right company dropdown.",
      whatToTest: "Pick a company and confirm only its entries show.",
      whatIfItFails: "Filter silently shows all companies -- tell the team, filter is non-blocking.",
      title: "Changelog company filter is ready to go live",
    };
    expect(featureLaunchRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => featureLaunchRequestPayloadSchema.parse({ ...payload, kind: "other" })).toThrow();
    expect(() => featureLaunchRequestPayloadSchema.parse({ ...payload, extra: "nope" })).toThrow();
    for (const field of ["whatIsNew", "whereToFindIt", "whatToTest", "whatIfItFails"] as const) {
      const { [field]: _omitted, ...missing } = payload;
      expect(() => featureLaunchRequestPayloadSchema.parse(missing)).toThrow();
      expect(() => featureLaunchRequestPayloadSchema.parse({ ...payload, [field]: "  " })).toThrow();
    }
  });
});

describe("deploy card items (one deploy card per day)", () => {
  const basePayload = {
    kind: "deploy" as const,
    projectId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    title: "Deploy",
    note: "Ship it",
  };

  it("accepts a deploy card that lists items, and one that lists none", () => {
    const items = [
      { summary: "Fixes the sign-in error", issueId: "NOR-1", branch: "fix/login", commit: "abc1234" },
      { summary: "Adds the weekly report email" },
    ];
    expect(deployRequestPayloadSchema.parse({ ...basePayload, items }).items).toEqual(items);
    expect(deployRequestPayloadSchema.parse(basePayload).items).toBeUndefined();
  });

  it("allows at most 50 items on a card", () => {
    const make = (count: number) => Array.from({ length: count }, (_, i) => ({ summary: `Item ${i}` }));
    expect(deployRequestPayloadSchema.parse({ ...basePayload, items: make(50) }).items).toHaveLength(50);
    expect(() => deployRequestPayloadSchema.parse({ ...basePayload, items: make(51) })).toThrow();
  });

  it("needs a summary of 1 to 300 characters and refuses unknown item fields", () => {
    expect(() => deployCardItemSchema.parse({ summary: "" })).toThrow();
    expect(() => deployCardItemSchema.parse({ summary: "   " })).toThrow();
    expect(() => deployCardItemSchema.parse({})).toThrow();
    expect(deployCardItemSchema.parse({ summary: "x".repeat(300) }).summary).toHaveLength(300);
    expect(() => deployCardItemSchema.parse({ summary: "x".repeat(301) })).toThrow();
    expect(() => deployCardItemSchema.parse({ summary: "ok", extra: true })).toThrow();
  });

  it("validates the body for adding items to an open card", () => {
    const parsed = addDeployItemsSchema.parse({ commit: "a".repeat(40), items: [{ summary: "Fixes it" }] });
    expect(parsed.issueIds).toEqual([]);
    expect(() => addDeployItemsSchema.parse({ commit: "a".repeat(40), items: [] })).toThrow();
    expect(() => addDeployItemsSchema.parse({ items: [{ summary: "Fixes it" }] })).toThrow();
    expect(() =>
      addDeployItemsSchema.parse({ commit: "a".repeat(40), items: [{ summary: "x" }], issueIds: ["NOR-1"] }),
    ).toThrow();
  });

  it("takes a card revision on the payload and on approve, and only a whole number from 1", () => {
    expect(deployRequestPayloadSchema.parse({ ...basePayload, cardRevision: 2 }).cardRevision).toBe(2);
    expect(() => deployRequestPayloadSchema.parse({ ...basePayload, cardRevision: 0 })).toThrow();
    expect(resolveApprovalSchema.parse({ expectedCardRevision: 3 }).expectedCardRevision).toBe(3);
    expect(resolveApprovalSchema.parse({}).expectedCardRevision).toBeUndefined();
    expect(() => resolveApprovalSchema.parse({ expectedCardRevision: 1.5 })).toThrow();
    expect(() => resolveApprovalSchema.parse({ expectedCardRevision: 0 })).toThrow();
  });
});
