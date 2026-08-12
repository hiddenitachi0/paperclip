import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  deployRequestPayloadSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
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
});
