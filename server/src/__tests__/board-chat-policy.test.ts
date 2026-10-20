import { describe, expect, it } from "vitest";
import {
  boardChatApprovalRefusal,
  checkBoardChatPath,
  describeBoardChatWrite,
  normalizeBoardChatPath,
  stableStringify,
  type BoardChatPolicyLookup,
} from "../services/board-chat-policy.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const APPROVAL = "55555555-5555-4555-8555-555555555555";

function lookup(overrides: Partial<{ approval: { type: string; payload: Record<string, unknown> | null; companyId?: string } }> = {}): BoardChatPolicyLookup {
  return {
    issue: async (id) =>
      id === "TST-1" || id === "issue-1"
        ? { companyId: COMPANY, identifier: "TST-1", title: "Write the plan" }
        : id === "OTH-1"
          ? { companyId: OTHER, identifier: "OTH-1", title: "Not ours" }
          : null,
    agent: async (id) =>
      id === AGENT ? { companyId: COMPANY, name: "Ada" } : id === OTHER_AGENT ? { companyId: OTHER, name: "Eve" } : null,
    approval: async (id) =>
      id === APPROVAL && overrides.approval
        ? { companyId: overrides.approval.companyId ?? COMPANY, type: overrides.approval.type, payload: overrides.approval.payload }
        : null,
    goal: async () => null,
    project: async () => null,
  };
}

describe("checkBoardChatPath", () => {
  it("allows reads inside the company and refuses other companies", () => {
    expect(checkBoardChatPath("GET", `/api/companies/${COMPANY}/dashboard`, COMPANY).allowed).toBe(true);
    const other = checkBoardChatPath("GET", `/api/companies/${OTHER}/dashboard`, COMPANY);
    expect(other).toMatchObject({ allowed: false, code: "BOARD_CHAT_OTHER_COMPANY" });
    expect(checkBoardChatPath("GET", "/api/companies", COMPANY).allowed).toBe(true);
    expect(checkBoardChatPath("POST", "/api/companies", COMPANY).allowed).toBe(false);
  });

  it("refuses sign-in, instance, keys, secrets, money, deploys and its own routes", () => {
    for (const path of [
      "/api/auth/get-session",
      "/api/instance/settings",
      "/api/board/chat/actions/x/confirm",
      "/api/board-api-keys",
      "/api/board-delegate-tokens",
      "/api/secrets/abc",
      `/api/agents/${AGENT}/keys`,
      "/api/crypto-wallets/x",
      "/api/deploy-runner/status",
      "/api/issues/TST-1/interactions/abc/accept",
      `/api/companies/${COMPANY}/board-chat/settings`,
      `/api/companies/${COMPANY}/secrets`,
      `/api/companies/${COMPANY}/members`,
      "/plugins/ui/thing",
    ]) {
      expect(checkBoardChatPath("GET", path, COMPANY).allowed, path).toBe(false);
    }
  });

  it("refuses paths that try to step elsewhere", () => {
    expect(normalizeBoardChatPath("/api/issues/../instance")).toBeNull();
    expect(normalizeBoardChatPath("/api/issues/%2e%2e/instance")).toBeNull();
    expect(normalizeBoardChatPath("/api//instance")).toBeNull();
    expect(normalizeBoardChatPath("/api/issues?q=1")).toBe("/api/issues");
  });
});

describe("describeBoardChatWrite", () => {
  it("describes a new task in plain words with the exact values", async () => {
    const decision = await describeBoardChatWrite({
      method: "POST",
      path: `/api/companies/${COMPANY}/issues`,
      body: { title: "Launch plan", priority: "high", assigneeAgentId: AGENT },
      companyId: COMPANY,
      lookup: lookup(),
    });
    expect(decision).toMatchObject({ allowed: true, kind: "create_issue", summary: 'Create a new task "Launch plan"' });
    if (!decision.allowed) throw new Error("expected allowed");
    expect(decision.details).toContainEqual({ label: "Assigned to", value: "Ada" });
    expect(decision.details).toContainEqual({ label: "Priority", value: "high" });
  });

  it("refuses writes that are not on the list", async () => {
    const decision = await describeBoardChatWrite({
      method: "POST",
      path: `/api/companies/${COMPANY}/routines`,
      body: {},
      companyId: COMPANY,
      lookup: lookup(),
    });
    expect(decision).toMatchObject({ allowed: false, code: "BOARD_CHAT_WRITE_NOT_SUPPORTED" });
  });

  it("refuses changes to things in another company", async () => {
    const issue = await describeBoardChatWrite({ method: "PATCH", path: "/api/issues/OTH-1", body: { status: "done" }, companyId: COMPANY, lookup: lookup() });
    expect(issue).toMatchObject({ allowed: false, code: "BOARD_CHAT_OTHER_COMPANY" });
    const agent = await describeBoardChatWrite({ method: "POST", path: `/api/agents/${OTHER_AGENT}/pause`, body: null, companyId: COMPANY, lookup: lookup() });
    expect(agent).toMatchObject({ allowed: false, code: "BOARD_CHAT_OTHER_COMPANY" });
  });

  it("only lets an agent's model, effort and folder change, never its command or keys", async () => {
    const ok = await describeBoardChatWrite({
      method: "PATCH",
      path: `/api/agents/${AGENT}`,
      body: { adapterConfig: { model: "claude-sonnet-5-5" } },
      companyId: COMPANY,
      lookup: lookup(),
    });
    expect(ok).toMatchObject({ allowed: true, summary: 'Change agent "Ada"' });
    const command = await describeBoardChatWrite({
      method: "PATCH",
      path: `/api/agents/${AGENT}`,
      body: { adapterConfig: { command: "bash -c 'curl evil'" } },
      companyId: COMPANY,
      lookup: lookup(),
    });
    expect(command).toMatchObject({ allowed: false, code: "BOARD_CHAT_FIELD_NOT_ALLOWED" });
    const replace = await describeBoardChatWrite({
      method: "PATCH",
      path: `/api/agents/${AGENT}`,
      body: { replaceAdapterConfig: true, adapterConfig: { model: "x" } },
      companyId: COMPANY,
      lookup: lookup(),
    });
    expect(replace).toMatchObject({ allowed: false, code: "BOARD_CHAT_FIELD_NOT_ALLOWED" });
    const hire = await describeBoardChatWrite({
      method: "POST",
      path: `/api/companies/${COMPANY}/agent-hires`,
      body: { name: "Bob", role: "engineer", adapterConfig: { env: { X: "1" } } },
      companyId: COMPANY,
      lookup: lookup(),
    });
    expect(hire).toMatchObject({ allowed: false, code: "BOARD_CHAT_FIELD_NOT_ALLOWED" });
  });

  it("never lets the chat decide a deploy or merge card", async () => {
    for (const kind of ["deploy", "merge_pr", "rollback"]) {
      for (const verb of ["approve", "reject", "request-revision"]) {
        const decision = await describeBoardChatWrite({
          method: "POST",
          path: `/api/approvals/${APPROVAL}/${verb}`,
          body: {},
          companyId: COMPANY,
          lookup: lookup({ approval: { type: "request_board_approval", payload: { kind } } }),
        });
        expect(decision, `${kind} ${verb}`).toMatchObject({ allowed: false, code: "BOARD_CHAT_APPROVAL_NOT_ALLOWED" });
        if (!decision.allowed) expect(decision.message).toMatch(/Deploy and merge cards/);
      }
    }
  });

  it("lets the chat ask to approve a hire card", async () => {
    const decision = await describeBoardChatWrite({
      method: "POST",
      path: `/api/approvals/${APPROVAL}/approve`,
      body: { decisionNote: "ok" },
      companyId: COMPANY,
      lookup: lookup({ approval: { type: "hire_agent", payload: { name: "Bob" } } }),
    });
    expect(decision).toMatchObject({ allowed: true, summary: 'Approve the card "Bob"' });
  });

  it("refuses other risky card kinds (money, tools, host actions)", () => {
    expect(boardChatApprovalRefusal({ type: "request_board_approval", payload: { kind: "tool_grant" } })).toMatch(/can't decide/);
    expect(boardChatApprovalRefusal({ type: "budget_override_required", payload: {} })).toMatch(/can't decide/);
    expect(boardChatApprovalRefusal({ type: "credential_request", payload: {} })).toMatch(/can't decide/);
    expect(boardChatApprovalRefusal({ type: "request_board_approval", payload: {} })).toBeNull();
  });

  it("only allows the company's own name, description, budget and hire-approval switch", async () => {
    const ok = await describeBoardChatWrite({ method: "PATCH", path: `/api/companies/${COMPANY}`, body: { budgetMonthlyCents: 5000 }, companyId: COMPANY, lookup: lookup() });
    expect(ok).toMatchObject({ allowed: true });
    if (ok.allowed) expect(ok.details).toContainEqual({ label: "Monthly budget", value: "$50.00" });
    const bad = await describeBoardChatWrite({ method: "PATCH", path: `/api/companies/${COMPANY}`, body: { status: "archived" }, companyId: COMPANY, lookup: lookup() });
    expect(bad).toMatchObject({ allowed: false, code: "BOARD_CHAT_FIELD_NOT_ALLOWED" });
  });
});

describe("stableStringify", () => {
  it("ignores key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe(stableStringify({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe("authorization for Board chat credentials", () => {
  it("refuses anything outside the one company, even for a member of both, before touching the database", async () => {
    const { authorizationService } = await import("../services/authorization.js");
    const svc = authorizationService({} as never);
    for (const source of ["board_chat", "board_chat_confirmed"] as const) {
      const decision = await svc.decide({
        actor: {
          type: "board",
          userId: "user-1",
          companyIds: [COMPANY],
          memberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }],
          isInstanceAdmin: false,
          source,
        },
        action: "issue:read",
        resource: { type: "company", companyId: OTHER },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("deny_company_boundary");
    }
  });
});
