import { describe, expect, it } from "vitest";
import { approvalCardRevision } from "./approval-card-revision";

describe("approvalCardRevision", () => {
  it("reads the revision the person was shown", () => {
    expect(approvalCardRevision({ payload: { kind: "deploy", cardRevision: 4 } })).toBe(4);
  });

  it("is undefined for cards without a usable revision", () => {
    expect(approvalCardRevision({ payload: { kind: "deploy" } })).toBeUndefined();
    expect(approvalCardRevision({ payload: { cardRevision: 0 } })).toBeUndefined();
    expect(approvalCardRevision({ payload: { cardRevision: "2" } })).toBeUndefined();
    expect(approvalCardRevision({ payload: null })).toBeUndefined();
  });
});
