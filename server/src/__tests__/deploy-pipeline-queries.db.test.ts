/**
 * Real-Postgres coverage for the SQL this bundle added to the deploy pipeline's scheduled
 * ticks and filing-time guards. The unit suites next to each service drive the branching
 * logic against a fake db; this one exists because a typo in a jsonb cast or a regex
 * operator here would not surface anywhere else until the scheduler tick started failing
 * every few seconds in production:
 * - merge-deploy-visibility.ts: the `deployVisibilityNextCheckAt` timestamptz filter on the
 *   due query (DUR-3928) and the legacy "noted but no sha" re-check query (DUR-3944),
 * - deploy-approval-feedback.ts: the deploy-like `~*` kind filter + decidedAt window (DUR-3923),
 * - approvals.ts: listApprovedDeployApprovalsForCommit (DUR-3923 de-dup).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approvalComments, approvals, companies, createDb, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mergeDeployVisibilityService } from "../services/merge-deploy-visibility.js";
import { deployApprovalFeedbackService } from "../services/deploy-approval-feedback.js";
import { approvalService } from "../services/approvals.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("deploy pipeline SQL against embedded Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const NOW = new Date("2026-09-07T12:00:00Z");
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deploy-pipeline-queries-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Deploy co ${companyId.slice(0, 8)}`,
      issuePrefix: `D${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedApproval(companyId: string, payload: Record<string, unknown>, decidedAt: Date | null, status = "approved") {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      status,
      payload,
      decidedAt,
      decidedByUserId: decidedAt ? "board" : null,
    });
    return id;
  }

  async function readPayload(id: string) {
    const row = await db.select({ payload: approvals.payload }).from(approvals).where(eq(approvals.id, id)).then((r) => r[0]);
    return row.payload as Record<string, unknown>;
  }

  it("merge-deploy-visibility: honours the re-check schedule and backfills legacy sha-less approvals", async () => {
    const companyId = await seedCompany();
    // Base-less payloads settle immediately (no issue/branch lookups) -- enough to prove
    // which rows the due query hands over.
    const dueNow = await seedApproval(companyId, { kind: "merge_pr" }, minutesAgo(60));
    const dueScheduledPast = await seedApproval(
      companyId,
      { kind: "merge_pr", deployVisibilityAttempts: 1, deployVisibilityNextCheckAt: minutesAgo(5).toISOString() },
      minutesAgo(120),
    );
    const notDueYet = await seedApproval(
      companyId,
      { kind: "merge_pr", deployVisibilityAttempts: 1, deployVisibilityNextCheckAt: new Date(NOW.getTime() + 60_000).toISOString() },
      minutesAgo(120),
    );
    const tooFresh = await seedApproval(companyId, { kind: "merge_pr" }, minutesAgo(5));
    const alreadyNoted = await seedApproval(companyId, { kind: "merge_pr", deployVisibilityNoted: true }, minutesAgo(60));
    // The DUR-3928 victims' shape: noted by the one-shot logic, PR reference present, no sha.
    const legacyStuck = await seedApproval(
      companyId,
      { kind: "merge_pr", base: "custom", prNumber: 248, repo: "acme/paperclip", deployVisibilityNoted: true },
      minutesAgo(3000),
    );
    const legacyNoPr = await seedApproval(companyId, { kind: "merge_pr", base: "custom", deployVisibilityNoted: true }, minutesAgo(3000));

    const sha = "655fdc1d655fdc1d655fdc1d655fdc1d655fdc1d";
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged", mergeCommitSha: sha });
    const result = await mergeDeployVisibilityService(db, { verifyMerge }).tick(NOW);

    expect(result).toEqual({ checked: 2, flagged: 0, retried: 0, gaveUp: 0, backfilled: 1 });
    expect((await readPayload(dueNow)).deployVisibilityNoted).toBe(true);
    expect((await readPayload(dueScheduledPast)).deployVisibilityNoted).toBe(true);
    expect((await readPayload(notDueYet)).deployVisibilityNoted).toBeUndefined();
    expect((await readPayload(tooFresh)).deployVisibilityNoted).toBeUndefined();
    expect((await readPayload(alreadyNoted)).mergeCommitShaRecheckedAt).toBeUndefined();
    // Only the legacy approval with a PR reference was re-checked, and only once.
    expect(verifyMerge).toHaveBeenCalledTimes(1);
    const backfilled = await readPayload(legacyStuck);
    expect(backfilled.mergeCommitSha).toBe(sha);
    expect(backfilled.deployVisibilityNoted).toBe(true);
    expect(typeof backfilled.mergeCommitShaRecheckedAt).toBe("string");
    expect((await readPayload(legacyNoPr)).mergeCommitShaRecheckedAt).toBeUndefined();

    // A second tick re-checks nothing: the backfilled row is settled.
    const again = await mergeDeployVisibilityService(db, { verifyMerge }).tick(NOW);
    expect(again.backfilled).toBe(0);
    expect(verifyMerge).toHaveBeenCalledTimes(1);
  });

  it("deploy-approval-feedback: picks up approved deploy-looking cards in the window and comments on them", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Widgets",
      status: "active",
      deployPolicy: { enabled: true, workspaceId, deployBranch: "custom" },
    });
    const deployPr = await seedApproval(companyId, { kind: "deploy_pr", prNumber: 42, repo: "acme/paperclip" }, minutesAgo(30));
    const realDeploy = await seedApproval(companyId, { kind: "deploy", projectId, workspaceId, commit: "abc123def4567" }, minutesAgo(30));
    const mergePr = await seedApproval(companyId, { kind: "merge_pr", prNumber: 43, repo: "acme/paperclip" }, minutesAgo(30));
    const tooFresh = await seedApproval(companyId, { kind: "deploy", projectId, workspaceId }, minutesAgo(2));
    const tooOld = await seedApproval(companyId, { kind: "deploy", projectId, workspaceId }, minutesAgo(3 * 24 * 60));
    const pendingDeploy = await seedApproval(companyId, { kind: "deploy", projectId, workspaceId }, null, "pending");

    const result = await deployApprovalFeedbackService(db, { readStatusLog: () => [] }).tick(NOW);

    expect(result).toEqual({ checked: 2, flagged: 2 });
    const commentsFor = async (approvalId: string) =>
      db.select({ body: approvalComments.body }).from(approvalComments).where(eq(approvalComments.approvalId, approvalId));
    expect((await commentsFor(deployPr)).map((c) => c.body).join("\n")).toContain('kind "deploy_pr"');
    expect((await commentsFor(realDeploy)).map((c) => c.body).join("\n")).toContain("has not picked it up");
    for (const untouched of [mergePr, tooFresh, tooOld, pendingDeploy]) {
      expect(await commentsFor(untouched)).toEqual([]);
      expect((await readPayload(untouched)).deployRunnerFeedbackNoted).toBeUndefined();
    }
    expect((await readPayload(deployPr)).deployRunnerFeedbackOutcome).toBe("unsupported_kind");
    expect((await readPayload(realDeploy)).deployRunnerFeedbackOutcome).toBe("unprocessed");

    // Once noted, a second tick says nothing more.
    const again = await deployApprovalFeedbackService(db, { readStatusLog: () => [] }).tick(NOW);
    expect(again).toEqual({ checked: 0, flagged: 0 });
    expect(await commentsFor(deployPr)).toHaveLength(1);
  });

  it("approvals.listApprovedDeployApprovalsForCommit: matches project + workspace + commit, oldest first, approved only", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const commit = "8623c28bd1234567890abcdef1234567890abcde";
    const older = await seedApproval(companyId, { kind: "deploy", projectId, workspaceId, commit }, minutesAgo(60));
    const newer = await seedApproval(companyId, { kind: "deploy", projectId, workspaceId, commit }, minutesAgo(30));
    await seedApproval(companyId, { kind: "deploy", projectId, workspaceId, commit: "other" }, minutesAgo(30));
    await seedApproval(companyId, { kind: "deploy", projectId, workspaceId: randomUUID(), commit }, minutesAgo(30));
    await seedApproval(companyId, { kind: "deploy", projectId, workspaceId, commit }, null, "pending");
    await seedApproval(companyId, { kind: "deploy", projectId, workspaceId, commit }, minutesAgo(30), "rejected");

    const rows = await approvalService(db).listApprovedDeployApprovalsForCommit(companyId, projectId, workspaceId, commit);

    expect(rows.map((row) => row.id)).toEqual([older, newer]);
  });
});
