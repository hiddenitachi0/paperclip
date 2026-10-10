/**
 * One-click host actions (kind "operator_action"): filing, approving and the
 * runner's secret read.
 *
 * - An agent may ask, but only for a target and action on the catalogue the
 *   on-box runner published for ITS OWN company, and only linked to a task.
 * - Every word on the card and the exact command come from that catalogue,
 *   never from the filer.
 * - Only a person who is the company's owner/admin (or an instance admin)
 *   may approve.
 * - The secret value for set_env_var is only readable by an instance admin,
 *   only for an approved card, only for the secret named on it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TIMEOUT = 20_000;

vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
    withCompanyScope: async (rawDb: any, _companyId: string, fn: (tx: unknown) => unknown) => rawDb.transaction(fn),
  };
});

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  findOpenHireApprovalForRole: vi.fn(),
  findOpenMergePrApproval: vi.fn(),
  findOpenDeployApproval: vi.fn(),
  listApprovedDeployApprovalsForCommit: vi.fn(async () => []),
  findOpenFeatureLaunchApproval: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
  getById: vi.fn(),
  resolveSecretValueForOperatorAction: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => ({ readFile: vi.fn(), writeFile: vi.fn() }),
    agentService: () => ({ getById: vi.fn() }),
    approvalService: () => mockApprovalService,
    personaService: () => ({ getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map<string, string>()) }),
    escalationGrantService: () => ({}),
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => mockIssueApprovalService,
    issueThreadInteractionService: () => ({ resolveInteractionsLinkedToApproval: vi.fn(async () => []) }),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const BRIDGE_RESTART = "systemctl restart paperclip-telegram-bridge.service";
const ENV_PATH = "/root/nordstrand-dashboard/.env";

const CATALOG = {
  version: 1,
  companies: {
    [COMPANY_A]: {
      services: {
        "telegram-bridge": { label: "the Telegram bridge", actions: { restart_service: BRIDGE_RESTART } },
      },
      envFiles: {
        dashboard: { label: "the dashboard settings file", path: ENV_PATH, keys: ["FEATURE_FLAG"] },
      },
    },
  },
};

const agentActor = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_A, source: "agent_jwt" };
const ownerActor = {
  type: "board",
  userId: "user-owner",
  companyIds: [COMPANY_A, COMPANY_B],
  source: "session",
  isInstanceAdmin: false,
  memberships: [{ companyId: COMPANY_A, membershipRole: "owner", status: "active" }],
};
const memberActor = {
  ...ownerActor,
  userId: "user-member",
  memberships: [{ companyId: COMPANY_A, membershipRole: "member", status: "active" }],
};
const instanceAdminActor = { ...memberActor, userId: "user-admin", isInstanceAdmin: true, memberships: [] };

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          limit: vi.fn(() => ({ then: async (resolve: (rows: unknown[]) => unknown) => resolve([]) })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function restartBody(payload: Record<string, unknown> = {}, issueIds: string[] = [ISSUE_ID]) {
  return {
    type: "request_board_approval",
    issueIds,
    payload: {
      kind: "operator_action",
      action: "restart_service",
      target: "telegram-bridge",
      reason: "The bridge still runs the old code after the deploy.",
      ...payload,
    },
  };
}

function setEnvBody(payload: Record<string, unknown> = {}) {
  return restartBody({
    action: "set_env_var",
    target: "dashboard",
    envKey: "FEATURE_FLAG",
    secretId: SECRET_ID,
    reason: "Turn the new checkout on.",
    ...payload,
  });
}

let tmpDir: string;
let catalogPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "operator-actions-"));
  catalogPath = path.join(tmpDir, "catalog.json");
  process.env.PAPERCLIP_OPERATOR_ACTIONS_CATALOG_PATH = catalogPath;
});

afterAll(() => {
  delete process.env.PAPERCLIP_OPERATOR_ACTIONS_CATALOG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("operator_action approvals", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    writeFileSync(catalogPath, JSON.stringify(CATALOG));

    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "company_scope:read", reason: "allow_test", explanation: "ok" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(async (_c: unknown, p: unknown) => p);
    mockSecretService.getById.mockResolvedValue({ id: SECRET_ID, companyId: COMPANY_A, name: "checkout-flag", status: "active" });
    mockSecretService.resolveSecretValueForOperatorAction.mockResolvedValue("on");
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.findOpenFeatureLaunchApproval.mockResolvedValue(null);
    mockApprovalService.create.mockImplementation(async (companyId: string, input: Record<string, unknown>) => ({
      id: APPROVAL_ID,
      companyId,
      ...input,
    }));
    mockApprovalService.listComments.mockResolvedValue([]);
  });

  describe("filing", () => {
    it("lets an agent ask for an allow-listed restart and stamps the card from the catalogue", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody({ title: "do whatever", willRun: "rm -rf /" }));
      // Filer-supplied stamped fields are dropped, not trusted.
      expect(res.status).toBe(201);
      const payload = mockApprovalService.create.mock.calls[0]![1].payload;
      expect(payload.title).toMatch(/Restart the Telegram bridge$/);
      expect(payload.willRun).toBe(BRIDGE_RESTART);
      expect(payload.summary).toBe("Why: The bridge still runs the old code after the deploy.");
      expect(payload.nextActionOnApproval).toContain("the server restarts the Telegram bridge");
    }, TEST_TIMEOUT);

    it("requires an agent's request to be linked to a task", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody({}, []));
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("linked to the task");
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses a target that is not on the company's list", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody({ target: "sshd" }));
      expect(res.status).toBe(422);
      expect(res.body.error).toContain('"sshd" is not a service');
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses an action the target does not allow", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody({ action: "recreate_container" }));
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("cannot be asked to recreate_container");
    }, TEST_TIMEOUT);

    it("refuses free-form fields such as a command", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody({ command: "reboot" }));
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("not valid");
    }, TEST_TIMEOUT);

    it("refuses a shell-looking target name", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody({ target: "telegram-bridge; reboot" }));
      expect(res.status).toBe(422);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("is company-scoped: company B cannot ask for company A's services", async () => {
      const res = await request(await createApp({ ...agentActor, companyId: COMPANY_B }))
        .post(`/api/companies/${COMPANY_B}/approvals`)
        .send(restartBody());
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("No host actions are set up for this company");
    }, TEST_TIMEOUT);

    it("offers nothing when the runner has published no catalogue", async () => {
      rmSync(catalogPath);
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(restartBody());
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("No host actions are set up");
    }, TEST_TIMEOUT);

    it("stamps a set_env_var card with the secret's name and the exact write, never a value", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(setEnvBody());
      expect(res.status).toBe(201);
      const payload = mockApprovalService.create.mock.calls[0]![1].payload;
      expect(payload.title).toMatch(/Change the setting FEATURE_FLAG in the dashboard settings file$/);
      expect(payload.secretName).toBe("checkout-flag");
      expect(payload.willRun).toBe(`write FEATURE_FLAG=<secret value> into ${ENV_PATH}`);
    }, TEST_TIMEOUT);

    it("refuses a set_env_var key that is not allow-listed", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(setEnvBody({ envKey: "DATABASE_URL" }));
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("DATABASE_URL is not one of the settings");
    }, TEST_TIMEOUT);

    it("refuses a secret that the box's per-key secrets list does not allow", async () => {
      const withSecrets = structuredClone(CATALOG) as any;
      withSecrets.companies[COMPANY_A].envFiles.dashboard.secrets = { FEATURE_FLAG: ["other-secret"] };
      writeFileSync(catalogPath, JSON.stringify(withSecrets));
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(setEnvBody());
      expect(res.status).toBe(422);
      expect(res.body.error).toContain('"checkout-flag" may not be written into FEATURE_FLAG');
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses a secret from another company", async () => {
      mockSecretService.getById.mockResolvedValue({ id: SECRET_ID, companyId: COMPANY_B, name: "theirs", status: "active" });
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(setEnvBody());
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("secret named on the card does not exist");
    }, TEST_TIMEOUT);

    it("refuses a plain-text value instead of a secret reference", async () => {
      const res = await request(await createApp(agentActor))
        .post(`/api/companies/${COMPANY_A}/approvals`)
        .send(setEnvBody({ secretId: undefined, value: "on" }));
      expect(res.status).toBe(422);
    }, TEST_TIMEOUT);

    it("re-stamps on resubmit, so a resubmitted card cannot carry its own command", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: APPROVAL_ID,
        companyId: COMPANY_A,
        type: "request_board_approval",
        status: "revision_requested",
        requestedByAgentId: AGENT_ID,
        payload: { kind: "operator_action" },
      });
      mockApprovalService.resubmit.mockImplementation(async (_id: string, payload: unknown) => ({
        id: APPROVAL_ID,
        companyId: COMPANY_A,
        payload,
      }));
      const res = await request(await createApp(agentActor))
        .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
        .send({ payload: restartBody({ willRun: "reboot" }).payload });
      expect(res.status).toBe(200);
      expect(mockApprovalService.resubmit.mock.calls[0]![1].willRun).toBe(BRIDGE_RESTART);
    }, TEST_TIMEOUT);
  });

  describe("catalogue read", () => {
    it("shows a company only its own host actions", async () => {
      const res = await request(await createApp(agentActor)).get(`/api/companies/${COMPANY_A}/operator-actions`);
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.services[0]).toMatchObject({ name: "telegram-bridge", actions: ["restart_service"] });
      expect(res.body.envFiles[0]).toMatchObject({ name: "dashboard", keys: ["FEATURE_FLAG"] });

      const other = await request(await createApp({ ...agentActor, companyId: COMPANY_B })).get(
        `/api/companies/${COMPANY_B}/operator-actions`,
      );
      expect(other.body).toEqual({ configured: false, services: [], envFiles: [] });
    }, TEST_TIMEOUT);
  });

  describe("approving", () => {
    const stored = {
      id: APPROVAL_ID,
      companyId: COMPANY_A,
      type: "request_board_approval",
      status: "pending",
      payload: {
        kind: "operator_action",
        action: "restart_service",
        target: "telegram-bridge",
        reason: "old code",
        title: "Restart the Telegram bridge",
        summary: "Why: old code",
        targetLabel: "the Telegram bridge",
        willRun: BRIDGE_RESTART,
        nextActionOnApproval: "When you approve, the server restarts the Telegram bridge.",
      },
    };

    beforeEach(() => {
      mockApprovalService.getById.mockResolvedValue(stored);
      mockApprovalService.approve.mockResolvedValue({ approval: { ...stored, status: "approved" }, applied: true });
    });

    it("does not let an agent approve", async () => {
      const res = await request(await createApp(agentActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(403);
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("does not let a plain company member approve", async () => {
      const res = await request(await createApp(memberActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("owner or an admin");
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("lets the company owner approve", async () => {
      const res = await request(await createApp(ownerActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(mockApprovalService.approve).toHaveBeenCalled();
      expect(res.status).toBeLessThan(400);
    }, TEST_TIMEOUT);

    it("lets an instance admin approve", async () => {
      await request(await createApp(instanceAdminActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(mockApprovalService.approve).toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses to approve a card that is no longer in the stamped shape", async () => {
      mockApprovalService.getById.mockResolvedValue({ ...stored, payload: { ...stored.payload, command: "reboot" } });
      const res = await request(await createApp(ownerActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(422);
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);
  });

  describe("runner secret read", () => {
    const setEnvCard = {
      id: APPROVAL_ID,
      companyId: COMPANY_A,
      type: "request_board_approval",
      status: "approved",
      decidedAt: new Date().toISOString(),
      payload: {
        kind: "operator_action",
        action: "set_env_var",
        target: "dashboard",
        envKey: "FEATURE_FLAG",
        secretId: SECRET_ID,
        secretName: "checkout-flag",
        reason: "on",
        title: "Change the setting FEATURE_FLAG in the dashboard settings file",
        summary: "Why: on",
        targetLabel: "the dashboard settings file",
        willRun: `write FEATURE_FLAG=<secret value> into ${ENV_PATH}`,
        nextActionOnApproval: "When you approve ...",
      },
    };

    it("is instance-admin only", async () => {
      mockApprovalService.getById.mockResolvedValue(setEnvCard);
      const res = await request(await createApp(ownerActor)).get(`/api/approvals/${APPROVAL_ID}/operator-action-secret`);
      expect(res.status).toBe(403);
      expect(mockSecretService.resolveSecretValueForOperatorAction).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("returns the value for an approved set_env_var card, for that card's own company and secret", async () => {
      mockApprovalService.getById.mockResolvedValue(setEnvCard);
      const res = await request(await createApp(instanceAdminActor)).get(`/api/approvals/${APPROVAL_ID}/operator-action-secret`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ value: "on", name: "checkout-flag" });
      expect(mockSecretService.resolveSecretValueForOperatorAction).toHaveBeenCalledWith(COMPANY_A, SECRET_ID, {
        approvalId: APPROVAL_ID,
        actorId: "user-admin",
      });
    }, TEST_TIMEOUT);

    it("refuses a card approved more than a day ago", async () => {
      mockApprovalService.getById.mockResolvedValue({
        ...setEnvCard,
        decidedAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      });
      const res = await request(await createApp(instanceAdminActor)).get(`/api/approvals/${APPROVAL_ID}/operator-action-secret`);
      expect(res.status).toBe(422);
      expect(mockSecretService.resolveSecretValueForOperatorAction).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses a card that is not approved yet", async () => {
      mockApprovalService.getById.mockResolvedValue({ ...setEnvCard, status: "pending" });
      const res = await request(await createApp(instanceAdminActor)).get(`/api/approvals/${APPROVAL_ID}/operator-action-secret`);
      expect(res.status).toBe(422);
      expect(mockSecretService.resolveSecretValueForOperatorAction).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);
  });
});
