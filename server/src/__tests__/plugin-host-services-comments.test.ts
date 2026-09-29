import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { openLaneAPluginRun } from "../services/lane-a-plugin-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin host services comment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

// DUR-4096: issues.createComment previously had no runId/checkout
// enforcement at all -- any plugin holding issue.comments.create could post
// an attributed comment on any issue in the company just by naming an
// issueId, regardless of whether the calling agent had any relationship to
// it. These tests cover the fix: an attributed comment (authorAgentId set)
// now needs the same checkout/Lane-A access createAttachment already
// enforces, plus the documented "still assigned at delivery time" exception
// for background-job delivery whose triggering run has already ended.
// Unattributed comments (no authorAgentId) keep the pre-fix, company-scope-
// only behavior -- they carry no impersonation risk.
describeEmbeddedPostgres("plugin-host-services issues.createComment", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-host-services-comments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const otherCompanyIssueId = randomUUID();
    const secondAssignedIssueId = randomUUID();
    const runId = randomUUID();
    const staleRunId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Media Agent", role: "engineer" },
      { id: otherAgentId, companyId, name: "Other Agent", role: "engineer" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "T-1", title: "Generate a video", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
      { id: unrelatedIssueId, companyId, identifier: "T-2", title: "Someone else's task", status: "in_progress", priority: "medium", assigneeAgentId: otherAgentId },
      { id: otherCompanyIssueId, companyId: otherCompanyId, identifier: "O-1", title: "Other", status: "in_progress", priority: "medium" },
      { id: secondAssignedIssueId, companyId, identifier: "T-3", title: "Also assigned to the media agent", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running" },
      { id: staleRunId, companyId, agentId, status: "completed" },
    ]);
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));

    return {
      companyId,
      otherCompanyId,
      agentId,
      otherAgentId,
      issueId,
      unrelatedIssueId,
      otherCompanyIssueId,
      secondAssignedIssueId,
      runId,
      staleRunId,
    };
  }

  function services() {
    return buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {});
  }

  it("allows an unattributed (no authorAgentId) comment on any issue in the company, unchanged from before DUR-4096", async () => {
    const { companyId, unrelatedIssueId } = await seed();
    const comment = await services().issues.createComment({
      issueId: unrelatedIssueId,
      companyId,
      body: "System note",
    });
    expect(comment.body).toBe("System note");
  });

  it("rejects an attributed comment when runId is omitted", async () => {
    const { companyId, agentId, unrelatedIssueId } = await seed();
    await expect(
      services().issues.createComment({
        issueId: unrelatedIssueId,
        companyId,
        body: "Your video is ready",
        authorAgentId: agentId,
      }),
    ).rejects.toThrow("runId is required when authorAgentId is set");
  });

  it("rejects an attributed comment whose runId does not resolve to authorAgentId (impersonation guard)", async () => {
    const { companyId, agentId, otherAgentId, issueId, runId } = await seed();
    await expect(
      services().issues.createComment({
        issueId,
        companyId,
        body: "Posing as someone else",
        authorAgentId: otherAgentId,
        runId,
      }),
    ).rejects.toThrow("authorAgentId must match the invoking run's own agent");
    void agentId;
  });

  it("rejects the exact DUR-4096 exploit: an unrelated issue, attributed, with a live run that has no checkout or assignment there", async () => {
    const { companyId, agentId, unrelatedIssueId, runId } = await seed();
    await expect(
      services().issues.createComment({
        issueId: unrelatedIssueId,
        companyId,
        body: "Your video is ready (planted)",
        authorAgentId: agentId,
        runId,
      }),
    ).rejects.toThrow("not currently checked out by the invoking run, and is not assigned to the calling agent");
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, unrelatedIssueId));
    expect(rows).toHaveLength(0);
  });

  it("allows an attributed comment when the run holds the issue's checkout", async () => {
    const { companyId, agentId, issueId, runId } = await seed();
    const comment = await services().issues.createComment({
      issueId,
      companyId,
      body: "Your video is ready",
      authorAgentId: agentId,
      runId,
    });
    expect(comment.body).toBe("Your video is ready");
  });

  it("allows an attributed comment from a non-checkout run when the issue is still assigned to that run's agent (background-job delivery exception)", async () => {
    const { companyId, agentId, issueId, staleRunId } = await seed();
    // staleRunId never held checkout, but resolves to `agentId`, who is
    // still the issue's assignee -- the documented exception for a
    // background job poller whose triggering tool-call run (and checkout)
    // already ended by the time the result is ready.
    const comment = await services().issues.createComment({
      issueId,
      companyId,
      body: "Your video is ready (delivered by the job poller)",
      authorAgentId: agentId,
      runId: staleRunId,
    });
    expect(comment.body).toContain("delivered by the job poller");
  });

  it("rejects a still-live run reaching a different issue merely because that issue is also assigned to the same agent (security-review follow-up)", async () => {
    // Security review of this same fix found the gap this test locks down:
    // `runId` here is genuinely live (status "running") and legitimately
    // holds checkout on `issueId`, but has no relationship whatsoever to
    // `secondAssignedIssueId` -- it never ran against it, never held its
    // checkout. The delivery exception must require the *run* to have
    // ended, not just "the target issue happens to be assigned to this
    // run's agent", or any of an agent's live runs could plant an
    // attributed comment on any other issue that agent is simultaneously
    // assigned to.
    const { companyId, agentId, secondAssignedIssueId, runId } = await seed();
    await expect(
      services().issues.createComment({
        issueId: secondAssignedIssueId,
        companyId,
        body: "operator approved, proceeding (planted from an unrelated live run)",
        authorAgentId: agentId,
        runId,
      }),
    ).rejects.toThrow("not currently checked out by the invoking run, and is not assigned to the calling agent");
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, secondAssignedIssueId));
    expect(rows).toHaveLength(0);
  });

  it("allows a run that has since ended to reach a different issue when it is that issue's current assignee (background-job delivery exception is issue-agnostic once the run is over)", async () => {
    const { companyId, agentId, secondAssignedIssueId, staleRunId } = await seed();
    // staleRunId is "completed" and never held checkout anywhere -- it's the
    // stand-in for a background job poller's run, which by design has no
    // checkout history on the issue it delivers to.
    const comment = await services().issues.createComment({
      issueId: secondAssignedIssueId,
      companyId,
      body: "Your video is ready (delivered by the job poller)",
      authorAgentId: agentId,
      runId: staleRunId,
    });
    expect(comment.body).toContain("delivered by the job poller");
  });

  it("rejects a non-checkout run when the issue is no longer assigned to that run's agent", async () => {
    const { companyId, agentId, issueId, staleRunId } = await seed();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    await expect(
      services().issues.createComment({
        issueId,
        companyId,
        body: "Your video is ready",
        authorAgentId: agentId,
        runId: staleRunId,
      }),
    ).rejects.toThrow("not currently checked out by the invoking run, and is not assigned to the calling agent");
  });

  it("rejects an issue that belongs to a different company even for an unattributed comment", async () => {
    const { otherCompanyId, issueId } = await seed();
    await expect(
      services().issues.createComment({
        issueId,
        companyId: otherCompanyId,
        body: "Cross-company",
      }),
    ).rejects.toThrow("Issue not found");
  });

  // ─── Quick agents (Lane A): no checkout, so a narrower rule ─────────────

  function quickAgentRun(input: { agentId: string; companyId: string; message: string }) {
    return openLaneAPluginRun({
      agentId: input.agentId,
      companyId: input.companyId,
      conversationId: randomUUID(),
      requestedByUserId: "user-1",
      requestedByAgentId: null,
      requesterMessage: input.message,
    });
  }

  it("lets a quick agent's run comment on a task the person named in their own message", async () => {
    const { companyId, agentId, unrelatedIssueId } = await seed();
    // Seeded identifier is "T-2"; the person names it.
    const { run, close } = quickAgentRun({ agentId, companyId, message: "post the update on t-2 please" });
    try {
      const comment = await services().issues.createComment({
        issueId: unrelatedIssueId,
        companyId,
        body: "Quick agent update",
        authorAgentId: agentId,
        runId: run.runId,
      });
      expect(comment.body).toBe("Quick agent update");
    } finally {
      close();
    }
  });

  it("refuses a quick agent's run when the task was not named in the message and is not assigned to it", async () => {
    const { companyId, agentId, unrelatedIssueId } = await seed();
    const { run, close } = quickAgentRun({ agentId, companyId, message: "post an update somewhere" });
    try {
      await expect(
        services().issues.createComment({
          issueId: unrelatedIssueId,
          companyId,
          body: "Quick agent update",
          authorAgentId: agentId,
          runId: run.runId,
        }),
      ).rejects.toThrow("The task T-2 was not named in the message, so the quick agent cannot comment on it.");
    } finally {
      close();
    }
  });
});
