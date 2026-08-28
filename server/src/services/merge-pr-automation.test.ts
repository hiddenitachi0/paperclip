import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_DECIDED_BY_PREFIX,
  assertMergePrOnly,
  checkFundamentalPaths,
  evaluateMergePrApproval,
  mergePrAutomationService,
  parsePullRequestReference,
} from "./merge-pr-automation.js";

describe("parsePullRequestReference", () => {
  it("parses a well-formed owner/repo + prNumber payload", () => {
    expect(parsePullRequestReference({ repo: "acme/widgets", prNumber: 42 })).toEqual({
      owner: "acme",
      name: "widgets",
      prNumber: 42,
    });
  });

  it("accepts a string prNumber", () => {
    expect(parsePullRequestReference({ repo: "acme/widgets", prNumber: "42" })?.prNumber).toBe(42);
  });

  it("returns null for a malformed repo", () => {
    expect(parsePullRequestReference({ repo: "not-a-repo", prNumber: 1 })).toBeNull();
  });

  it("returns null for a missing/invalid prNumber", () => {
    expect(parsePullRequestReference({ repo: "acme/widgets", prNumber: 0 })).toBeNull();
    expect(parsePullRequestReference({ repo: "acme/widgets" })).toBeNull();
  });
});

describe("checkFundamentalPaths", () => {
  it("is clean for an ordinary change", () => {
    const result = checkFundamentalPaths(["ui/src/components/WidgetCard.tsx", "README.md"]);
    expect(result.clean).toBe(true);
    expect(result.matchedCategories).toEqual([]);
  });

  it("flags the approval mechanism itself, including this automation's own file", () => {
    expect(checkFundamentalPaths(["server/src/services/merge-pr-automation.ts"]).clean).toBe(false);
    expect(checkFundamentalPaths(["server/src/services/approvals.ts"]).clean).toBe(false);
    expect(checkFundamentalPaths(["server/src/services/agent-roles.ts"]).clean).toBe(false);
  });

  it("flags auth, secrets, company isolation, budget, deletion, money, customer data, and outbound comms", () => {
    const paths = [
      "server/src/middleware/auth.ts",
      "server/src/services/secrets.ts",
      "server/src/services/company-scope.ts",
      "server/src/services/budgets.ts",
      "server/src/services/company-deletion.ts",
      "server/src/services/billing.ts",
      "server/src/services/customer-records.ts",
      "server/src/services/notification-webhook.ts",
    ];
    const result = checkFundamentalPaths(paths);
    expect(result.clean).toBe(false);
    expect(result.matchedCategories).toEqual(
      expect.arrayContaining([
        "auth_or_authorization",
        "secrets_or_credentials",
        "company_isolation_or_rls",
        "budget_or_cost_caps",
        "data_deletion",
        "money",
        "customer_data",
        "outbound_communication",
      ]),
    );
  });

  it("flags database migrations", () => {
    expect(checkFundamentalPaths(["packages/db/src/migrations/0200_add_widget.sql"]).clean).toBe(false);
  });

  it("dedupes categories across multiple matching files", () => {
    const result = checkFundamentalPaths(["server/src/services/secrets.ts", "server/src/services/agent-secret-bindings.ts"]);
    expect(result.matchedCategories).toEqual(["secrets_or_credentials"]);
  });

  it("flags underscore-named permission-grant schema and the service/constants files around it (DUR-383 gap)", () => {
    const paths = [
      "packages/db/src/schema/principal_permission_grants.ts",
      "packages/db/src/schema/company_agent_roles.ts",
      "packages/shared/src/constants.ts",
      "server/src/services/agent-permissions.ts",
      "server/src/services/company-member-roles.ts",
      "server/src/services/principal-access-compatibility.ts",
      "server/src/services/companies.ts",
    ];
    for (const path of paths) {
      expect(checkFundamentalPaths([path]).clean).toBe(false);
    }
  });
});

describe("assertMergePrOnly", () => {
  it("passes for a pending request_board_approval/merge_pr approval", () => {
    expect(() =>
      assertMergePrOnly({ type: "request_board_approval", status: "pending", payload: { kind: "merge_pr" } }),
    ).not.toThrow();
  });

  it("throws hard for a deploy-kind approval -- never silently skipped by the decision path itself", () => {
    expect(() =>
      assertMergePrOnly({ type: "request_board_approval", status: "pending", payload: { kind: "deploy" } }),
    ).toThrow(/deploy/i);
  });

  it("throws hard for any other approval kind", () => {
    expect(() =>
      assertMergePrOnly({ type: "request_board_approval", status: "pending", payload: { kind: "hire_agent" } }),
    ).toThrow();
    expect(() => assertMergePrOnly({ type: "hire_agent", status: "pending", payload: {} })).toThrow();
  });

  it("throws for an already-decided approval", () => {
    expect(() =>
      assertMergePrOnly({ type: "request_board_approval", status: "approved", payload: { kind: "merge_pr" } }),
    ).toThrow();
  });
});

function githubFetchStub(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    for (const [matcher, body] of Object.entries(routes)) {
      // Exact trailing-segment match so "/pulls/42" never shadows "/pulls/42/files" etc.
      if (path === matcher || path.endsWith(matcher)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  });
}

const OPEN_PR = { state: "open", user: { login: "author-agent" }, head: { sha: "deadbeef" } };
const GREEN_STATUS = { total_count: 1, state: "success" };
const NO_CHECK_RUNS = { check_runs: [] };
const CLEAN_FILES = [{ filename: "ui/src/components/WidgetCard.tsx" }];
const INDEPENDENT_APPROVAL = [
  { state: "APPROVED", commit_id: "deadbeef", user: { login: "reviewer-agent" } },
];

describe("evaluateMergePrApproval", () => {
  it("is eligible when CI is green, no fundamental path is touched, and an independent review approved the head commit", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": GREEN_STATUS,
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result).toMatchObject({ eligible: true, ci: "met", paths: "met", independentReview: "met" });
  });

  it("fails closed (ineligible) when no PR reference is present", async () => {
    const result = await evaluateMergePrApproval({}, { fetchImpl: vi.fn(), token: null });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("missing_pr_reference");
  });

  it("fails closed when GitHub is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("github_pr_unreachable");
  });

  it("is not eligible when CI is red", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": { total_count: 1, state: "failure" },
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result).toMatchObject({ eligible: false, ci: "not_met" });
  });

  it("never treats absence of any CI as green", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": { total_count: 0 },
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result).toMatchObject({ eligible: false, ci: "unknown" });
  });

  it("is not eligible when the diff touches a fundamental-surface path", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": GREEN_STATUS,
      "/check-runs": NO_CHECK_RUNS,
      "/files": [{ filename: "server/src/services/agent-roles.ts" }],
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result).toMatchObject({ eligible: false, paths: "not_met" });
    expect(result.matchedPathCategories).toContain("approval_mechanism");
  });

  it("does not count a self-approval (reviewer login === author login) as independent", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": GREEN_STATUS,
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": [{ state: "APPROVED", commit_id: "deadbeef", user: { login: "author-agent" } }],
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result).toMatchObject({ eligible: false, independentReview: "not_met" });
  });

  it("does not count a review of a stale (non-head) commit", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": GREEN_STATUS,
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": [{ state: "APPROVED", commit_id: "stale-sha", user: { login: "reviewer-agent" } }],
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result).toMatchObject({ eligible: false, independentReview: "not_met" });
  });

  it("is not eligible for a closed/non-open PR", async () => {
    const fetchImpl = githubFetchStub({
      "/pulls/42": { ...OPEN_PR, state: "closed" },
    });
    const result = await evaluateMergePrApproval({ repo: "acme/widgets", prNumber: 42 }, { fetchImpl, token: null });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("pr_state_closed");
  });
});

function approvalRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    payload: { kind: "merge_pr", repo: "acme/widgets", prNumber: 42 },
    ...overrides,
  };
}

function dbStub(rows: ReturnType<typeof approvalRow>[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as any;
}

describe("mergePrAutomationService.tick", () => {
  it("does nothing when the live kill switch is off", async () => {
    const db = dbStub([approvalRow()]);
    const approve = vi.fn();
    const svc = mergePrAutomationService(db, {
      instanceSettings: { getGeneral: vi.fn(async () => ({ mergePrAutomationEnabled: false })) } as any,
      approvalsSvc: { approve } as any,
    });
    const result = await svc.tick(new Date());
    expect(result).toEqual({ evaluated: 0, approved: 0, killSwitchOff: true });
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves an eligible merge_pr approval with an automation identity and logs it as actorType system", async () => {
    const row = approvalRow();
    const db = dbStub([row]);
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": GREEN_STATUS,
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const approve = vi.fn(async (_id: string, decidedByUserId: string) => ({
      approval: { ...row, status: "approved", decidedByUserId },
      applied: true,
    }));
    const logActivityImpl = vi.fn();
    const svc = mergePrAutomationService(db, {
      fetch: fetchImpl,
      instanceSettings: { getGeneral: vi.fn(async () => ({ mergePrAutomationEnabled: true })) } as any,
      approvalsSvc: { approve } as any,
      getGitHubToken: vi.fn(async () => null),
      logActivityImpl,
    });

    const result = await svc.tick(new Date());

    expect(result).toEqual({ evaluated: 1, approved: 1, killSwitchOff: false });
    expect(approve).toHaveBeenCalledWith("approval-1", AUTOMATION_DECIDED_BY_PREFIX, expect.any(String));
    expect(logActivityImpl).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        actorType: "system",
        actorId: AUTOMATION_DECIDED_BY_PREFIX,
        action: "approval.approved",
        entityType: "approval",
        details: expect.objectContaining({ automated: true, ruleId: "dur299-rule6" }),
      }),
    );
  });

  it("never approves and never calls approve for an ineligible merge_pr approval", async () => {
    const row = approvalRow();
    const db = dbStub([row]);
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": { total_count: 1, state: "failure" },
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const approve = vi.fn();
    const svc = mergePrAutomationService(db, {
      fetch: fetchImpl,
      instanceSettings: { getGeneral: vi.fn(async () => ({ mergePrAutomationEnabled: true })) } as any,
      approvalsSvc: { approve } as any,
      getGitHubToken: vi.fn(async () => null),
    });

    const result = await svc.tick(new Date());
    expect(result).toEqual({ evaluated: 1, approved: 0, killSwitchOff: false });
    expect(approve).not.toHaveBeenCalled();
  });

  it("skips a non-merge_pr approval (e.g. deploy) mixed into the pending set, and never calls approve for it", async () => {
    const deployRow = approvalRow({ id: "approval-deploy", payload: { kind: "deploy" } });
    const mergeRow = approvalRow();
    const db = dbStub([deployRow, mergeRow]);
    const fetchImpl = githubFetchStub({
      "/pulls/42": OPEN_PR,
      "/status": GREEN_STATUS,
      "/check-runs": NO_CHECK_RUNS,
      "/files": CLEAN_FILES,
      "/reviews": INDEPENDENT_APPROVAL,
    });
    const approve = vi.fn(async (id: string, decidedByUserId: string) => ({
      approval: { ...mergeRow, id, status: "approved", decidedByUserId },
      applied: true,
    }));
    const svc = mergePrAutomationService(db, {
      fetch: fetchImpl,
      instanceSettings: { getGeneral: vi.fn(async () => ({ mergePrAutomationEnabled: true })) } as any,
      approvalsSvc: { approve } as any,
      getGitHubToken: vi.fn(async () => null),
      logActivityImpl: vi.fn(),
    });

    const result = await svc.tick(new Date());
    expect(result.evaluated).toBe(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith("approval-1", expect.any(String), expect.any(String));
  });
});
