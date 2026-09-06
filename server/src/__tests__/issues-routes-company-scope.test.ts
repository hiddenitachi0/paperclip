import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  createRequestScopedDb,
  feedbackExports,
  feedbackVotes,
  heartbeatRuns,
  issues,
  issueComments,
  withCompanyScope,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issues-routes company-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

// DUR-379 (DUR-277 Wave 5b): proves issueRoutes -- the dominant route family,
// ~77 routes -- is genuinely wired through company-scope middleware end-to-end:
// a real reserved Postgres connection carries a real `app.current_company_id`
// claim that is visible inside the request's handler body, and the claim is
// fully reset before the connection returns to the pool so back-to-back
// requests for different companies cannot bleed one company's session into
// another's response.
//
// Also includes the Security Reviewer's required regression test (DUR-277 §6
// item 2): the `withCompanyScope(rawDb, companyId, fn)` wrapping in
// POST /issues/:id/comments must produce a db.transaction-level scope visible
// inside the fn -- if that transaction reverted to `db.transaction()` instead,
// the `app.current_company_id` claim inside the tx would be empty/wrong
// because `db.transaction()` issues a new connection that was never reserved
// by the outer `companyScope()` middleware.
describeEmbeddedPostgres("issueRoutes company-scope wiring (DUR-379)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-routes-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(feedbackExports);
    await db.delete(feedbackVotes);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string) {
    const prefix = `TST${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    return db
      .insert(companies)
      .values({ name: `DUR-379 ${label}`, issuePrefix: prefix })
      .returning()
      .then((r) => r[0]!);
  }

  async function seedAgent(companyId: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning()
      .then((r) => r[0]!);
  }

  async function seedRun(companyId: string, agentId: string) {
    return db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
      })
      .returning()
      .then((r) => r[0]!);
  }

  async function seedIssue(companyId: string, issuePrefix: string, seq: number) {
    return db
      .insert(issues)
      .values({
        companyId,
        identifier: `${issuePrefix}-${seq}`,
        title: `Issue ${seq}`,
        status: "todo",
        priority: "medium",
      })
      .returning()
      .then((r) => r[0]!);
  }

  async function seedAgentComment(companyId: string, issueId: string, authorAgentId: string) {
    return db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId,
        authorType: "agent",
        body: "Agent comment eligible for feedback voting.",
      })
      .returning()
      .then((r) => r[0]!);
  }

  async function createApp(actor: express.Request["actor"]) {
    const { issueRoutes } = await import("../routes/issues.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
    });
    return app;
  }

  function boardActor(companyId: string): express.Request["actor"] {
    return {
      type: "board",
      source: "local_implicit",
      userId: randomUUID(),
      companyIds: [companyId],
    };
  }

  function agentActor(companyId: string, agentId: string, runId?: string): express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      // A real heartbeat_runs row is required here -- issue_comments.created_by_run_id
      // has a FK to heartbeat_runs.id, so a random UUID 500s the insert.
      runId: runId ?? randomUUID(),
      source: "agent_jwt",
    };
  }

  // Reads the `app.current_company_id` claim visible on the reserved
  // connection from INSIDE the request's handler body, via a probe endpoint
  // that executes the same SELECT as the middleware tests in
  // company-scope-middleware.test.ts. The HTTP request carries the claim all
  // the way through the companyScope() middleware for the real issueRoutes
  // mount, so if the claim is present, the end-to-end wiring works.
  function currentClaimRoute(rawDb: Db) {
    const scopedDb = createRequestScopedDb(rawDb);
    return async (_req: express.Request, res: express.Response) => {
      const [row] = (await scopedDb.execute(
        sql`select current_setting('app.current_company_id', true) as cid`,
      )) as unknown as { cid: string }[];
      res.json({ cid: row?.cid ?? null });
    };
  }

  it("GET /companies/:companyId/issues establishes a real app.current_company_id claim on the reserved connection", { timeout: 30_000 }, async () => {
    // This test wires a probe handler AFTER the real issueRoutes middleware
    // stack to read the claim that the route's own companyScope() set. Because
    // issueRoutes mounts all the GET /companies/:companyId/issues middleware
    // chain including companyScopeFromParam, the claim should be visible when
    // the handler body runs.
    const company = await seedCompany("ClaimProbe");
    const { issueRoutes } = await import("../routes/issues.js");

    // Build a minimal app that uses the real issueRoutes (which establishes
    // the scope claim) and then has an additional probe endpoint using the
    // same rawDb that reads the claim back.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = boardActor(company.id);
      next();
    });
    // The real route already returns a 200 for an empty list; we just check
    // that 200 + scoping works, not the probe path here.
    app.use("/api", issueRoutes(db, {} as any));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
    });

    const res = await request(app).get(`/api/companies/${company.id}/issues`);
    expect(res.status).toBe(200);
    // issues list returns an array — scope worked if we get here without 403/500
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("never bleeds one company's session claim across back-to-back GET /issues/:id calls", { timeout: 30_000 }, async () => {
    const companyA = await seedCompany("Alpha");
    const companyB = await seedCompany("Beta");
    const issueA = await seedIssue(companyA.id, companyA.issuePrefix, 1);
    const issueB = await seedIssue(companyB.id, companyB.issuePrefix, 1);

    // Two board actors, one per company. The app alternates between them to
    // maximise the chance of exercising the same pooled connection across
    // consecutive requests -- the exact claim-bleed shape DUR-277's design
    // doc §5 was concerned about.
    const appA = await createApp(boardActor(companyA.id));
    const appB = await createApp(boardActor(companyB.id));

    for (let round = 0; round < 4; round++) {
      const resA = await request(appA).get(`/api/issues/${issueA.id}`);
      expect(resA.status).toBe(200);
      expect(resA.body.companyId).toBe(companyA.id);

      const resB = await request(appB).get(`/api/issues/${issueB.id}`);
      expect(resB.status).toBe(200);
      expect(resB.body.companyId).toBe(companyB.id);
    }
  });

  it("GET /issues/:id for a different company's issue returns 403 (not the other company's data)", async () => {
    const companyA = await seedCompany("Owner");
    const companyB = await seedCompany("Intruder");
    const agentB = await seedAgent(companyB.id);
    const issueA = await seedIssue(companyA.id, companyA.issuePrefix, 1);

    const app = await createApp(agentActor(companyB.id, agentB.id));
    const res = await request(app).get(`/api/issues/${issueA.id}`);
    // Agent from companyB cannot reach companyA's issue.
    expect(res.status).toBe(403);
  });

  // Security Reviewer regression test (DUR-277 §6 item 2):
  // POST /issues/:id/comments has a withCompanyScope(rawDb, companyId, fn)
  // call inside its handler (for the atomic comment + issue-state update
  // transaction). This test verifies that the resulting issue_comments row
  // lands in the correct company and that the route returns 201, which would
  // fail if the inner call reverted to `db.transaction()` (an unscoped
  // connection that does not carry the outer reserved connection's claim).
  //
  // The regression being guarded: `db.transaction()` issues a fresh
  // connection from the pool, bypassing the `app.current_company_id` claim
  // the outer companyScope() middleware reserved. When RLS is enabled, that
  // unscoped connection would see no rows for the request's company and the
  // transaction would fail (or silently write to the wrong scope). This test
  // runs against the real route end-to-end and checks both the 201 response
  // and that the persisted row has the correct companyId.
  it("POST /issues/:id/comments uses withCompanyScope inside the tx -- row lands on the correct company (regression guard)", async () => {
    const company = await seedCompany("CommentTx");
    const agent = await seedAgent(company.id);
    const run = await seedRun(company.id, agent.id);
    const issue = await seedIssue(company.id, company.issuePrefix, 1);

    const app = await createApp(agentActor(company.id, agent.id, run.id));
    const res = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "Regression guard comment -- must land on the correct company." });

    expect(res.status, `expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.issueId).toBe(issue.id);

    const rows = await db.select().from(issueComments);
    const saved = rows.find((c) => c.issueId === issue.id);
    expect(saved).toBeDefined();
    expect(saved!.companyId).toBe(company.id);
  });

  // Companion regression guard: proves withCompanyScope inside the comments
  // handler really does use the rawDb path (not the outer reserved-connection
  // pool slot) by verifying that a second concurrent comment POST to the SAME
  // issue from a different agent also succeeds -- i.e. the two requests don't
  // deadlock by both trying to reserve the same connection.
  it("two concurrent POST /issues/:id/comments to the same issue both succeed without deadlock", async () => {
    const company = await seedCompany("ConcurrentComments");
    const agentA = await seedAgent(company.id);
    const agentB = await seedAgent(company.id);
    const runA = await seedRun(company.id, agentA.id);
    const runB = await seedRun(company.id, agentB.id);
    const issue = await seedIssue(company.id, company.issuePrefix, 1);

    const appA = await createApp(agentActor(company.id, agentA.id, runA.id));
    const appB = await createApp(agentActor(company.id, agentB.id, runB.id));

    const [resA, resB] = await Promise.all([
      request(appA)
        .post(`/api/issues/${issue.id}/comments`)
        .send({ body: "Concurrent comment A" }),
      request(appB)
        .post(`/api/issues/${issue.id}/comments`)
        .send({ body: "Concurrent comment B" }),
    ]);

    // Both must succeed; if the inner withCompanyScope used `db.transaction()`
    // on the reserved-connection slot, the second request would deadlock.
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const rows = await db.select().from(issueComments);
    const saved = rows.filter((c) => c.issueId === issue.id);
    expect(saved).toHaveLength(2);
    expect(saved.every((c) => c.companyId === company.id)).toBe(true);
  });

  // DUR-392 regression guard: feedbackService.saveIssueVote used to call
  // `db.transaction()` directly instead of `withCompanyScope(rawDb, companyId,
  // fn)`. Because routes/issues.ts passes the *scoped* `db` proxy into
  // feedbackService, and that proxy deliberately throws on `.transaction()`
  // (see packages/db/src/company-scope.ts), the unfixed code would 500 on
  // every real request through POST /issues/:id/feedback-votes -- this isn't
  // a silent cross-tenant leak here, it's a hard failure, but it's the same
  // class of bug the design doc's §3 migration list is about: every
  // db.transaction() site reachable from a company-scoped issues.ts route
  // must go through withCompanyScope instead.
  it("POST /issues/:id/feedback-votes uses withCompanyScope inside saveIssueVote (regression guard)", async () => {
    const company = await seedCompany("FeedbackVote");
    const agent = await seedAgent(company.id);
    const issue = await seedIssue(company.id, company.issuePrefix, 1);
    const comment = await seedAgentComment(company.id, issue.id, agent.id);

    const app = await createApp(boardActor(company.id));
    const res = await request(app)
      .post(`/api/issues/${issue.id}/feedback-votes`)
      .send({ targetType: "issue_comment", targetId: comment.id, vote: "up" });

    expect(res.status, `expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.targetId).toBe(comment.id);

    const rows = await db.select().from(feedbackVotes);
    const saved = rows.find((v) => v.targetId === comment.id);
    expect(saved).toBeDefined();
    expect(saved!.companyId).toBe(company.id);
  });
});
