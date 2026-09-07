import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const reportIssueId = "33333333-3333-4333-8333-333333333333";

const mockCheckupService = vi.hoisted(() => ({
  runCheckup: vi.fn(),
  findOpenCheckup: vi.fn(),
  summarizeOpenCheckup: vi.fn(),
}));

vi.mock("../services/organization-checkup.js", () => ({
  organizationCheckupService: () => mockCheckupService,
}));

function boardActor() {
  return {
    type: "board",
    userId: "user-1",
    companyIds: [companyId],
    source: "session",
    isInstanceAdmin: false,
  };
}

function agentActor() {
  return {
    type: "agent",
    agentId: "44444444-4444-4444-8444-444444444444",
    companyId,
    source: "agent_key",
    runId: "55555555-5555-4555-8555-555555555555",
  };
}

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  const [{ errorHandler }, { organizationCheckupRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/organization-checkup.js") as Promise<typeof import("../routes/organization-checkup.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", organizationCheckupRoutes(withFakeCompanyScopeReserve({}) as any));
  app.use(errorHandler);
  return app;
}

function createdResult(overrides: Record<string, unknown> = {}) {
  return {
    companyId,
    dryRun: false,
    outcome: "created",
    reportIssueId,
    reportIdentifier: "DUR-900",
    title: "Weekly check-up for Durkan, 2026-09-07: 2 things to look at",
    body: "## Costing you money\n...",
    findings: [
      { fingerprint: "agent_error:a", severity: "stuck", headline: "Builder has stopped with an error.", suggestion: "Restart it.", evidence: [], evidenceJson: {}, subjectAgentId: "a", suggestedTask: { title: "t", description: "d", priority: "high" } },
      { fingerprint: "stuck_issues", severity: "stuck", headline: "3 open tasks have not moved in more than 5 days.", suggestion: "Review them.", evidence: [], evidenceJson: {}, subjectAgentId: null, suggestedTask: { title: "t", description: "d", priority: "medium" } },
    ],
    suppressedFindings: [],
    writtenTables: ["activity_log", "issue_thread_interactions", "issues"],
    existingReportCreatedAt: null,
    ...overrides,
  };
}

describe("organization check-up routes", () => {
  beforeEach(() => {
    mockCheckupService.runCheckup.mockReset();
    mockCheckupService.findOpenCheckup.mockReset();
    mockCheckupService.findOpenCheckup.mockResolvedValue(null);
    mockCheckupService.summarizeOpenCheckup.mockReset();
    mockCheckupService.summarizeOpenCheckup.mockResolvedValue(null);
  });

  it("rejects agent keys from running a check-up", async () => {
    const res = await request(await createApp(agentActor())).post(`/api/companies/${companyId}/checkups/run`).send({});

    expect(res.status).toBe(403);
    expect(mockCheckupService.runCheckup).not.toHaveBeenCalled();
  });

  it("rejects board users without access to the company", async () => {
    const res = await request(await createApp(boardActor())).post(`/api/companies/${otherCompanyId}/checkups/run`).send({});

    expect(res.status).toBe(403);
    expect(mockCheckupService.runCheckup).not.toHaveBeenCalled();
  });

  it("runs a check-up for a board user and reports plainly what it found", async () => {
    mockCheckupService.runCheckup.mockResolvedValue(createdResult());

    const res = await request(await createApp(boardActor())).post(`/api/companies/${companyId}/checkups/run`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCheckupService.runCheckup).toHaveBeenCalledWith(expect.objectContaining({ companyId, dryRun: false }));
    expect(res.body).toMatchObject({
      outcome: "created",
      reportIssueId,
      reportIdentifier: "DUR-900",
      message: "Found 2 things to look at.",
      findingCount: 2,
    });
    expect(res.body.findings).toEqual([
      expect.objectContaining({ fingerprint: "agent_error:a", headline: "Builder has stopped with an error." }),
      expect.objectContaining({ fingerprint: "stuck_issues" }),
    ]);
  });

  it("passes dry-run through and says no report was written", async () => {
    mockCheckupService.runCheckup.mockResolvedValue(createdResult({ dryRun: true, outcome: "dry_run", reportIssueId: null, reportIdentifier: null, writtenTables: [] }));

    const res = await request(await createApp(boardActor())).post(`/api/companies/${companyId}/checkups/run`).send({ dryRun: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCheckupService.runCheckup).toHaveBeenCalledWith(expect.objectContaining({ companyId, dryRun: true }));
    expect(res.body.message).toBe("Found 2 things to look at. This was a preview; no report was written.");
    expect(res.body.reportIssueId).toBeNull();
  });

  it("hands back the open report instead of writing a second one", async () => {
    mockCheckupService.runCheckup.mockResolvedValue(createdResult({
      outcome: "existing",
      existingReportCreatedAt: new Date("2026-08-17T09:00:00.000Z"),
      writtenTables: [],
    }));

    const res = await request(await createApp(boardActor())).post(`/api/companies/${companyId}/checkups/run`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("existing");
    expect(res.body.message).toBe("This is the check-up from 2026-08-17; nothing new is written while it is still open. Close it to get a fresh one.");
  });

  it("rejects a malformed body", async () => {
    const res = await request(await createApp(boardActor())).post(`/api/companies/${companyId}/checkups/run`).send({ dryRun: "yes" });

    expect(res.status).toBe(400);
    expect(mockCheckupService.runCheckup).not.toHaveBeenCalled();
  });

  it("returns the latest open report with its suggestion counts for the dashboard, board-only", async () => {
    mockCheckupService.summarizeOpenCheckup.mockResolvedValue({
      report: {
        id: reportIssueId,
        identifier: "DUR-900",
        title: "Weekly check-up",
        status: "todo",
        createdAt: new Date("2026-09-07T12:00:00.000Z"),
      },
      suggestionCount: 3,
      pendingSuggestionCount: 3,
      suggestionsStatus: "pending",
    });

    const ok = await request(await createApp(boardActor())).get(`/api/companies/${companyId}/checkups/latest`);
    expect(ok.status).toBe(200);
    expect(ok.body.report).toMatchObject({ id: reportIssueId, identifier: "DUR-900", status: "todo" });
    expect(ok.body).toMatchObject({ suggestionCount: 3, pendingSuggestionCount: 3, suggestionsStatus: "pending" });

    const denied = await request(await createApp(agentActor())).get(`/api/companies/${companyId}/checkups/latest`);
    expect(denied.status).toBe(403);

    mockCheckupService.summarizeOpenCheckup.mockResolvedValue(null);
    const none = await request(await createApp(boardActor())).get(`/api/companies/${companyId}/checkups/latest`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ report: null, suggestionCount: 0, pendingSuggestionCount: 0, suggestionsStatus: "none" });
  });
});
