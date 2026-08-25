import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  deployRequestPayloadSchema,
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
});
