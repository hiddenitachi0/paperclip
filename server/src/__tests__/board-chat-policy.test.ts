import { describe, expect, it } from "vitest";
import {
  BOARD_CHAT_MAX_VALUE_CHARS,
  boardChatApprovalRefusal,
  checkBoardChatPath,
  describeBoardChatWrite,
  normalizeBoardChatPath,
  stableStringify,
  type BoardChatPolicyLookup,
} from "../services/board-chat-policy.js";
import { runBoardChatTool, BOARD_CHAT_TOOL_NAMES, type BoardChatToolContext } from "../services/board-chat-tools.js";

const COMPANY = "a1111111-1111-4111-8111-11111111111a";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const APPROVAL = "55555555-5555-4555-8555-555555555555";
const ISSUE = "b6666666-6666-4666-8666-66666666666b";
const OTHER_ISSUE = "77777777-7777-4777-8777-777777777777";
const PROJECT = "88888888-8888-4888-8888-888888888888";
const GOAL = "99999999-9999-4999-8999-999999999999";

function lookup(overrides: Partial<{ approval: { type: string; payload: Record<string, unknown> | null; companyId?: string } }> = {}): BoardChatPolicyLookup {
  return {
    issue: async (id) =>
      id === ISSUE
        ? { id: ISSUE, companyId: COMPANY, identifier: "TST-1", title: "Write the plan" }
        : id === OTHER_ISSUE
          ? { id: OTHER_ISSUE, companyId: OTHER, identifier: "OTH-1", title: "Not ours" }
          : null,
    agent: async (id) =>
      id === AGENT ? { companyId: COMPANY, name: "Ada" } : id === OTHER_AGENT ? { companyId: OTHER, name: "Eve" } : null,
    approval: async (id) =>
      id === APPROVAL && overrides.approval
        ? { companyId: overrides.approval.companyId ?? COMPANY, type: overrides.approval.type, payload: overrides.approval.payload }
        : null,
    goal: async (id) => (id === GOAL ? { companyId: COMPANY, title: "Grow" } : null),
    project: async (id) => (id === PROJECT ? { companyId: COMPANY, name: "Website" } : null),
  };
}

const write = (method: string, path: string, body: unknown, extra: Parameters<typeof lookup>[0] = {}) =>
  describeBoardChatWrite({ method, path, body, companyId: COMPANY, lookup: lookup(extra) });

describe("checkBoardChatPath", () => {
  it("allows reads inside the company and refuses other companies", () => {
    expect(checkBoardChatPath("GET", `/api/companies/${COMPANY}/dashboard`, COMPANY).allowed).toBe(true);
    expect(checkBoardChatPath("GET", `/api/companies/${COMPANY}/issues?status=todo&q=Board`, COMPANY).allowed).toBe(true);
    const other = checkBoardChatPath("GET", `/api/companies/${OTHER}/dashboard`, COMPANY);
    expect(other).toMatchObject({ allowed: false, code: "BOARD_CHAT_OTHER_COMPANY" });
    expect(checkBoardChatPath("GET", "/api/companies", COMPANY).allowed).toBe(false);
    expect(checkBoardChatPath("GET", "/api/companies/stats", COMPANY).allowed).toBe(false);
  });

  it("refuses sign-in, people, instance, keys, secrets, mail, money, deploys and its own routes", () => {
    for (const path of [
      "/api/auth/get-session",
      "/api/instance/settings",
      "/api/admin/users",
      "/api/board/chat/actions/x/confirm",
      "/api/board-api-keys",
      "/api/board-delegate-tokens",
      "/api/secrets/abc/usage",
      `/api/agents/${AGENT}/keys`,
      `/api/agents/${AGENT}/instructions-bundle/file`,
      "/api/crypto-wallets/x",
      "/api/deploy-runner/status",
      `/api/issues/${ISSUE}/interactions/abc/accept`,
      `/api/companies/${COMPANY}/board-chat/settings`,
      `/api/companies/${COMPANY}/secrets`,
      `/api/companies/${COMPANY}/members`,
      `/api/companies/${COMPANY}/mail-accounts/x/messages`,
      `/api/companies/${COMPANY}/telegram-bots`,
      `/api/companies/${COMPANY}/data-connections`,
      `/api/companies/${COMPANY}/export`,
      "/plugins/ui/thing",
      "/llms/agent-configuration.txt",
    ]) {
      expect(checkBoardChatPath("GET", path, COMPANY).allowed, path).toBe(false);
    }
  });

  it("refuses every mixed-case or upper-case address (Express would still match it)", () => {
    for (const path of [
      `/api/companies/${COMPANY}/Mail-Accounts/x/messages`,
      `/api/companies/${COMPANY}/MEMBERS`,
      `/api/companies/${COMPANY}/Telegram-Bots`,
      `/api/companies/${COMPANY}/Data-Connections`,
      `/api/companies/${COMPANY}/Export`,
      "/api/Secrets/1/usage",
      `/api/agents/${AGENT}/Keys`,
      "/api/Admin/users",
      `/API/companies/${COMPANY}/dashboard`,
      `/api/companies/${COMPANY.toUpperCase()}/dashboard`,
    ]) {
      expect(normalizeBoardChatPath(path), path).toBeNull();
      expect(checkBoardChatPath("GET", path, COMPANY).allowed, path).toBe(false);
    }
  });

  it("refuses paths that try to step elsewhere", () => {
    expect(normalizeBoardChatPath("/api/issues/../instance")).toBeNull();
    expect(normalizeBoardChatPath("/api/issues/%2e%2e/instance")).toBeNull();
    expect(normalizeBoardChatPath("/api//instance")).toBeNull();
    expect(normalizeBoardChatPath("/api/issues;x")).toBeNull();
    expect(normalizeBoardChatPath("/api/issues?q=1")).toBe("/api/issues");
  });
});

describe("describeBoardChatWrite", () => {
  it("shows EVERY field that will be sent, with its real label and full value", async () => {
    const description = "x".repeat(6000);
    const decision = await write("POST", `/api/companies/${COMPANY}/issues`, {
      title: "Launch plan",
      description,
      status: "todo",
      priority: "high",
      assigneeAgentId: AGENT,
      projectId: PROJECT,
      goalId: GOAL,
      parentId: ISSUE,
    });
    expect(decision).toMatchObject({ allowed: true, kind: "create_issue", summary: 'Create a new task "Launch plan"' });
    if (!decision.allowed) throw new Error("expected allowed");
    expect(decision.details).toEqual([
      { label: "Title", value: "Launch plan" },
      { label: "Description", value: description },
      { label: "Status", value: "todo" },
      { label: "Priority", value: "high" },
      { label: "Assigned to", value: "Ada" },
      { label: "Project", value: "Website" },
      { label: "Goal", value: "Grow" },
      { label: "Parent task", value: 'TST-1 "Write the plan"' },
    ]);
  });

  it("refuses a change too long to show in full instead of cutting it", async () => {
    const decision = await write("POST", `/api/issues/${ISSUE}/comments`, { body: "y".repeat(BOARD_CHAT_MAX_VALUE_CHARS + 1) });
    expect(decision).toMatchObject({ allowed: false, code: "BOARD_CHAT_CHANGE_TOO_LONG" });
  });

  it("refuses writes that are not on the list, and mixed-case write addresses", async () => {
    expect(await write("POST", `/api/companies/${COMPANY}/routines`, {})).toMatchObject({ allowed: false, code: "BOARD_CHAT_WRITE_NOT_SUPPORTED" });
    expect(await write("PUT", `/api/agents/${AGENT}/instructions-bundle/file`, { path: "AGENTS.md", content: "x" })).toMatchObject({ allowed: false });
    expect(await write("POST", `/api/Companies/${COMPANY}/issues`, { title: "x" })).toMatchObject({ allowed: false });
    expect(await write("PATCH", `/api/issues/${ISSUE.toUpperCase()}`, { title: "x" })).toMatchObject({ allowed: false });
  });

  it("refuses changes to things in another company, including linked things", async () => {
    expect(await write("PATCH", `/api/issues/${OTHER_ISSUE}`, { status: "done" })).toMatchObject({ allowed: false, code: "BOARD_CHAT_OTHER_COMPANY" });
    expect(await write("POST", `/api/agents/${OTHER_AGENT}/pause`, null)).toMatchObject({ allowed: false, code: "BOARD_CHAT_OTHER_COMPANY" });
    expect(await write("POST", `/api/companies/${COMPANY}/issues`, { title: "x", assigneeAgentId: OTHER_AGENT })).toMatchObject({
      allowed: false,
      code: "BOARD_CHAT_OTHER_COMPANY",
    });
    expect(await write("PATCH", `/api/companies/${OTHER}`, { name: "x" })).toMatchObject({ allowed: false });
  });

  it("only lets an agent's basics, model and effort change: never runtimeConfig, command, env or flags", async () => {
    const ok = await write("PATCH", `/api/agents/${AGENT}`, { title: "Lead", adapterConfig: { model: "claude-sonnet-5-5", effort: "high" } });
    expect(ok).toMatchObject({ allowed: true, summary: 'Change agent "Ada"' });
    if (ok.allowed) {
      expect(ok.details).toEqual([
        { label: "Title", value: "Lead" },
        { label: "Model", value: "claude-sonnet-5-5" },
        { label: "Effort", value: "high" },
      ]);
    }
    for (const body of [
      { runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { command: "/bin/sh", extraArgs: ["-c", "x"], env: { A: "1" } } } } } },
      { runtimeConfig: { heartbeat: { enabled: true } } },
      { adapterConfig: { command: "bash -c 'curl evil'" } },
      { adapterConfig: { env: { X: "1" } } },
      { adapterConfig: { cwd: "/" } },
      { adapterConfig: { model: { nested: true } } },
      { replaceAdapterConfig: true, adapterConfig: { model: "x" } },
      { permissions: { canCreateAgents: true } },
      { adapterType: "process" },
      { laneABaseUrl: "https://attacker.example" },
      { status: "terminated" },
    ]) {
      expect(await write("PATCH", `/api/agents/${AGENT}`, body), JSON.stringify(body)).toMatchObject({
        allowed: false,
        code: "BOARD_CHAT_FIELD_NOT_ALLOWED",
      });
    }
  });

  it("gives hires a strict field list", async () => {
    const ok = await write("POST", `/api/companies/${COMPANY}/agent-hires`, {
      name: "Bob",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-5-5" },
      budgetMonthlyCents: 5000,
    });
    expect(ok).toMatchObject({ allowed: true, summary: 'Hire a new agent "Bob" as engineer' });
    if (ok.allowed) {
      expect(ok.details).toEqual([
        { label: "Name", value: "Bob" },
        { label: "Role", value: "engineer" },
        { label: "Agent kind", value: "claude_local" },
        { label: "Model", value: "claude-sonnet-5-5" },
        { label: "Monthly budget", value: "$50.00" },
      ]);
    }
    for (const extra of [
      { permissions: { canCreateAgents: true } },
      { laneABaseUrl: "https://attacker.example" },
      { browserAccess: true },
      { instructionsBundle: { files: { "AGENTS.md": "x" } } },
      { laneATrustLevel: "high" },
      { runtimeConfig: { modelProfiles: {} } },
      { adapterConfig: { command: "/bin/sh" } },
      { adapterConfig: { env: { A: "1" } } },
      { desiredSkills: [] },
    ]) {
      const decision = await write("POST", `/api/companies/${COMPANY}/agent-hires`, { name: "Eve", adapterType: "claude_local", ...extra });
      expect(decision, JSON.stringify(extra)).toMatchObject({ allowed: false, code: "BOARD_CHAT_FIELD_NOT_ALLOWED" });
    }
    expect(await write("POST", `/api/companies/${COMPANY}/agent-hires`, { name: "Eve", adapterType: "process" })).toMatchObject({
      allowed: false,
      code: "BOARD_CHAT_FIELD_NOT_ALLOWED",
    });
  });

  it("never lets the chat decide a deploy or merge card", async () => {
    for (const kind of ["deploy", "merge_pr", "rollback"]) {
      for (const verb of ["approve", "reject", "request-revision"]) {
        const decision = await write("POST", `/api/approvals/${APPROVAL}/${verb}`, {}, { approval: { type: "request_board_approval", payload: { kind } } });
        expect(decision, `${kind} ${verb}`).toMatchObject({ allowed: false, code: "BOARD_CHAT_APPROVAL_NOT_ALLOWED" });
        if (!decision.allowed) expect(decision.message).toMatch(/Deploy and merge cards/);
      }
    }
  });

  it("lets the chat ask to approve a hire card", async () => {
    const decision = await write("POST", `/api/approvals/${APPROVAL}/approve`, { decisionNote: "ok" }, { approval: { type: "hire_agent", payload: { name: "Bob" } } });
    expect(decision).toMatchObject({ allowed: true, summary: 'Approve the card "Bob"', details: [{ label: "Note", value: "ok" }] });
  });

  it("refuses other risky card kinds (money, tools, host actions)", () => {
    expect(boardChatApprovalRefusal({ type: "request_board_approval", payload: { kind: "tool_grant" } })).toMatch(/can't decide/);
    expect(boardChatApprovalRefusal({ type: "budget_override_required", payload: {} })).toMatch(/can't decide/);
    expect(boardChatApprovalRefusal({ type: "credential_request", payload: {} })).toMatch(/can't decide/);
    expect(boardChatApprovalRefusal({ type: "request_board_approval", payload: {} })).toBeNull();
  });

  it("only allows the company's own name, description and budget", async () => {
    const ok = await write("PATCH", `/api/companies/${COMPANY}`, { budgetMonthlyCents: 5000 });
    expect(ok).toMatchObject({ allowed: true });
    if (ok.allowed) expect(ok.details).toEqual([{ label: "Monthly budget", value: "$50.00" }]);
    for (const body of [{ status: "archived" }, { requireBoardApprovalForNewAgents: false }]) {
      expect(await write("PATCH", `/api/companies/${COMPANY}`, body)).toMatchObject({ allowed: false, code: "BOARD_CHAT_FIELD_NOT_ALLOWED" });
    }
  });
});

describe("Board chat tools", () => {
  function ctx(): BoardChatToolContext & { reads: string[]; holds: Array<{ method: string; path: string; body: unknown }> } {
    const reads: string[] = [];
    const holds: Array<{ method: string; path: string; body: unknown }> = [];
    return {
      companyId: COMPANY,
      reads,
      holds,
      read: async (path) => {
        reads.push(path);
        return { status: 200, text: "{}", json: {} };
      },
      hold: async (method, path, body) => {
        holds.push({ method, path, body });
        return { content: "held", isError: false };
      },
      resolveTask: async (ref) => (ref === "TST-1" || ref === ISSUE ? ISSUE : null),
    };
  }

  it("is a closed list with no free-form address tool", () => {
    expect(BOARD_CHAT_TOOL_NAMES).not.toContain("api");
    expect(BOARD_CHAT_TOOL_NAMES.every((name) => /^[a-z_]+$/.test(name))).toBe(true);
  });

  it("builds every address itself, lower-case, from checked arguments", async () => {
    const c = ctx();
    await runBoardChatTool("get_task", { task: "TST-1" }, c);
    await runBoardChatTool("get_agent", { agentId: AGENT.toUpperCase() }, c);
    await runBoardChatTool("update_task", { task: "TST-1", status: "done" }, c);
    await runBoardChatTool("hire_agent", { name: "Bob", model: "claude-sonnet-5-5" }, c);
    await runBoardChatTool("update_agent", { agentId: AGENT, effort: "high" }, c);
    for (const path of [...c.reads, ...c.holds.map((h) => h.path)]) expect(path).toBe(path.toLowerCase());
    expect(c.holds).toEqual([
      { method: "PATCH", path: `/api/issues/${ISSUE}`, body: { status: "done" } },
      { method: "POST", path: `/api/companies/${COMPANY}/agent-hires`, body: { name: "Bob", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5" } } },
      { method: "PATCH", path: `/api/agents/${AGENT}`, body: { adapterConfig: { effort: "high" } } },
    ]);
  });

  it("refuses arguments outside each tool's list, and unknown tools", async () => {
    const c = ctx();
    expect(await runBoardChatTool("update_agent", { agentId: AGENT, runtimeConfig: {} }, c)).toMatchObject({ isError: true });
    expect(await runBoardChatTool("hire_agent", { name: "Eve", permissions: { canCreateAgents: true } }, c)).toMatchObject({ isError: true });
    expect(await runBoardChatTool("hire_agent", { name: "Eve", agentKind: "process" }, c)).toMatchObject({ isError: true });
    expect(await runBoardChatTool("get_agent", { agentId: "../instance" }, c)).toMatchObject({ isError: true });
    expect(await runBoardChatTool("api", { method: "GET", path: "/api/instance" }, c)).toMatchObject({ isError: true });
    expect(await runBoardChatTool("get_task", { task: "NOPE-1" }, c)).toMatchObject({ isError: true });
    expect(c.holds).toHaveLength(0);
    expect(c.reads).toHaveLength(0);
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
