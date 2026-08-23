import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { assertBoard, assertBoardOrDelegate, assertCompanyAccess } from "../routes/authz.js";

function req(actor: Express.Request["actor"], overrides: Partial<Request> = {}): Request {
  return { actor, method: "POST", originalUrl: "/test", ...overrides } as unknown as Request;
}

describe("DUR-128 assertBoardOrDelegate", () => {
  it("allows a board actor regardless of scope", () => {
    expect(() => assertBoardOrDelegate(req({ type: "board", userId: "op-1", source: "session" }), "agent.clear_error"))
      .not.toThrow();
  });

  it("allows a delegate token scoped for the required action", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      delegateTokenId: "tok-1",
      delegateName: "Telegram bot",
      delegateScopes: ["agent.clear_error" as const, "agent.resume" as const],
      source: "board_delegate_key" as const,
    };
    expect(() => assertBoardOrDelegate(req(actor), "agent.clear_error")).not.toThrow();
    expect(() => assertBoardOrDelegate(req(actor), "agent.resume")).not.toThrow();
  });

  it("rejects a delegate token that isn't scoped for the required action", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      delegateTokenId: "tok-1",
      delegateName: "Telegram bot",
      delegateScopes: ["agent.resume" as const],
      source: "board_delegate_key" as const,
    };
    expect(() => assertBoardOrDelegate(req(actor), "agent.clear_error")).toThrow(/not scoped/);
  });

  it("rejects a delegate token with no scopes at all", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      delegateTokenId: "tok-1",
      delegateName: "Telegram bot",
      source: "board_delegate_key" as const,
    };
    expect(() => assertBoardOrDelegate(req(actor), "issue.scheduled_retry_retry_now")).toThrow(/not scoped/);
  });

  it("rejects agent and unauthenticated actors outright", () => {
    expect(() => assertBoardOrDelegate(req({ type: "agent", agentId: "a-1", companyId: "c-1" }), "agent.resume"))
      .toThrow(/Board or delegate access required/);
    expect(() => assertBoardOrDelegate(req({ type: "none", source: "none" }), "agent.resume"))
      .toThrow(/Board or delegate access required/);
  });
});

describe("DUR-128 assertBoard never accepts a delegate token", () => {
  // This is the entire enforcement behind "the same token cannot approve a
  // merge or a deploy": every merge/deploy approval route calls assertBoard
  // directly and was never changed to call assertBoardOrDelegate, so a
  // board_delegate actor -- no matter what scopes its token holds -- always
  // fails this check.
  it("rejects a board_delegate actor with every scope granted", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      delegateTokenId: "tok-1",
      delegateName: "Telegram bot",
      delegateScopes: ["agent.clear_error" as const, "agent.resume" as const, "issue.scheduled_retry_retry_now" as const],
      source: "board_delegate_key" as const,
    };
    expect(() => assertBoard(req(actor))).toThrow(/Board access required/);
  });
});

describe("DUR-128 assertCompanyAccess treats board_delegate like the granting operator's board session", () => {
  it("allows a delegate whose resolved companyIds include the target company", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
      delegateTokenId: "tok-1",
      delegateScopes: ["agent.resume" as const],
      source: "board_delegate_key" as const,
    };
    expect(() => assertCompanyAccess(req(actor), "company-1")).not.toThrow();
  });

  it("rejects a delegate outside the granting operator's companies", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
      delegateTokenId: "tok-1",
      delegateScopes: ["agent.resume" as const],
      source: "board_delegate_key" as const,
    };
    expect(() => assertCompanyAccess(req(actor), "company-2")).toThrow(/does not have access/);
  });

  it("rejects a delegate whose operator only has viewer membership for a mutating request", () => {
    const actor = {
      type: "board_delegate" as const,
      userId: "op-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
      isInstanceAdmin: false,
      delegateTokenId: "tok-1",
      delegateScopes: ["agent.resume" as const],
      source: "board_delegate_key" as const,
    };
    expect(() => assertCompanyAccess(req(actor), "company-1")).toThrow(/[Vv]iewer/);
  });
});
