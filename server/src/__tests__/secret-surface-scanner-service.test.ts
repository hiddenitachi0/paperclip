import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  SECRET_SCAN_ORIGIN_KIND,
  fileSecretFinding,
  scanFilesystemForLeakedSecrets,
  scanHeartbeatRunsForLeakedSecrets,
} from "../services/secret-surface-scanner.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secret-surface-scanner tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secret-surface-scanner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secret-scan-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret Scan Co",
      issuePrefix: `SS${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Some Agent",
      role: overrides.role ?? "engineer",
      title: overrides.title ?? null,
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
    });
    return id;
  }

  async function countIssuesByFingerprint(companyId: string, fingerprint: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originFingerprint, fingerprint)));
  }

  it("files exactly one critical issue per unique finding, and mentions/assigns the Security Reviewer", async () => {
    const companyId = await seedCompany();
    const securityReviewerId = await seedAgent(companyId, { title: "Security Reviewer" });

    const first = await fileSecretFinding(db, {
      companyId,
      surface: "dotenv",
      location: "projects/acme/.env",
      pattern: "generic_sk_key",
      maskedValue: "sk-abc***wxyz",
      detail: "test finding",
    });
    expect(first.filed).toBe(true);
    expect(first.reason).toBe("created");
    const issueId = first.issueId!;

    const created = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(created.priority).toBe("critical");
    expect(created.originKind).toBe(SECRET_SCAN_ORIGIN_KIND);
    expect(created.assigneeAgentId).toBe(securityReviewerId);
    expect(created.description).toContain("sk-abc***wxyz");
    // The real secret value never appears anywhere in the filed issue.
    expect(created.description ?? "").not.toContain("abcwxyz");
    expect(created.description).toContain(`agent://${securityReviewerId}`);

    // A second sweep hitting the exact same location/pattern must not file a duplicate.
    const second = await fileSecretFinding(db, {
      companyId,
      surface: "dotenv",
      location: "projects/acme/.env",
      pattern: "generic_sk_key",
      maskedValue: "sk-abc***wxyz",
      detail: "test finding",
    });
    expect(second.filed).toBe(false);
    expect(second.reason).toBe("already_open");

    const matching = await countIssuesByFingerprint(companyId, created.originFingerprint);
    expect(matching).toHaveLength(1);
  });

  it("files unassigned when no security-titled agent exists for the company, instead of dropping the finding", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { title: "Backend Engineer" });

    const result = await fileSecretFinding(db, {
      companyId,
      surface: "git_config",
      location: ".git/config",
      pattern: "github_pat",
      maskedValue: "github***7890",
      detail: "test finding",
    });
    expect(result.filed).toBe(true);
    const created = await db.select().from(issues).where(eq(issues.id, result.issueId!)).then((rows) => rows[0]!);
    expect(created.assigneeAgentId).toBeNull();
    expect(created.description).toContain("No agent with a security-titled role was found");
  });

  it("scans heartbeat_runs error/stdout/stderr columns and dedupes across sweeps via the cursor", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { title: "Security Reviewer" });
    const runnerAgentId = await seedAgent(companyId);

    const leakyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: leakyRunId,
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      error: "fatal: remote https://x-access-token:ghp_realTokenLooksLikeThis123456789012@github.com/acme/repo.git",
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      stdoutExcerpt: "nothing sensitive here",
    });

    const firstSweep = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: null });
    expect(firstSweep.rowsScanned).toBe(2);
    expect(firstSweep.matchesFound).toBe(1);
    expect(firstSweep.issuesFiled).toBe(1);
    expect(firstSweep.cursor).not.toBeNull();

    const filedIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, SECRET_SCAN_ORIGIN_KIND)))
      .then((rows) => rows[0]!);
    expect(filedIssue.description ?? "").not.toContain("realTokenLooksLikeThis123456789012");
    expect(filedIssue.description).toContain(leakyRunId);

    // Resuming from the returned cursor must not refile the already-filed
    // finding, and must not re-select anything either: the cursor carries the
    // boundary row's created_at at Postgres's own microsecond precision
    // (DUR-3931), so the resume query lands exactly after it. Before that fix
    // the cursor was a millisecond JS Date and this assertion had to allow one
    // re-selected row -- which still flaked on CI, because two rows inserted
    // in the same millisecond were BOTH re-selected ("expected 2 to be <= 1").
    const secondSweep = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: firstSweep.cursor });
    expect(secondSweep.rowsScanned).toBe(0);
    expect(secondSweep.matchesFound).toBe(0);
    expect(secondSweep.issuesFiled).toBe(0);

    const allFindingIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, SECRET_SCAN_ORIGIN_KIND)));
    expect(allFindingIssues).toHaveLength(1);
  });

  it("DUR-3931: the resume cursor is exact when rows share a millisecond but differ by microseconds", async () => {
    const companyId = await seedCompany();
    const runnerAgentId = await seedAgent(companyId);

    // Two rows 500 microseconds apart inside the same millisecond -- the shape a
    // fast CI runner produces for back-to-back inserts, and the exact input the
    // old millisecond-precision cursor got wrong (it truncated the boundary to
    // ...123000 and `created_at > cursor` then matched both rows again).
    const earlierId = "00000000-0000-4000-8000-000000000001";
    const laterId = "00000000-0000-4000-8000-000000000002";
    await db.insert(heartbeatRuns).values({
      id: earlierId,
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      createdAt: sql`'2026-01-01 00:00:00.123400+00'::timestamptz`,
    });
    await db.insert(heartbeatRuns).values({
      id: laterId,
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      createdAt: sql`'2026-01-01 00:00:00.123900+00'::timestamptz`,
    });

    const firstSweep = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: null });
    expect(firstSweep.rowsScanned).toBe(2);
    expect(firstSweep.cursor).toEqual({ createdAt: expect.stringContaining(".1239"), id: laterId });

    const resumed = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: firstSweep.cursor });
    expect(resumed.rowsScanned).toBe(0);
    expect(resumed.cursor).toEqual(firstSweep.cursor);

    // A row that lands strictly after the boundary is still picked up.
    const newestId = "00000000-0000-4000-8000-000000000003";
    await db.insert(heartbeatRuns).values({
      id: newestId,
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      createdAt: sql`'2026-01-01 00:00:00.124000+00'::timestamptz`,
    });
    const third = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: resumed.cursor });
    expect(third.rowsScanned).toBe(1);
    expect(third.cursor?.id).toBe(newestId);

    // A legacy millisecond Date cursor is still accepted and resumes at the
    // old (coarser) precision without throwing.
    const legacy = await scanHeartbeatRunsForLeakedSecrets(db, {
      cursor: { createdAt: new Date("2026-01-01T00:00:00.123Z"), id: earlierId },
    });
    expect(legacy.rowsScanned).toBe(3);
  });

  it("DUR-360: does not hang on an adversarial multi-MB error column (unbounded-input DoS via the shared multi-line PEM pattern)", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { title: "Security Reviewer" });
    const runnerAgentId = await seedAgent(companyId);

    // Many BEGIN markers with no matching END make the shared pem_private_key
    // pattern's lazy [\s\S]*? scan quadratic if run against the whole,
    // untruncated column value -- this reproduces the finding from DUR-360's
    // review of PR #201 (benchmarked ~10s on a 1.6MB string of this shape).
    const adversarialError = "-----BEGIN RSA PRIVATE KEY----- ".repeat(60_000); // ~2MB
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      error: adversarialError,
    });

    const start = performance.now();
    const sweep = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: null });
    const elapsedMs = performance.now() - start;

    expect(sweep.rowsScanned).toBe(1);
    // Generous bound well under the ~10s an unbounded scan of this input
    // would take -- proves the per-field cap is actually being applied, not
    // just that the DB round-trip is fast.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("DUR-387: still catches a secret positioned past the old head-only 64KB cutoff, via the tail half", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { title: "Security Reviewer" });
    const runnerAgentId = await seedAgent(companyId);

    // 150KB of filler followed by a real-shaped secret near the very end.
    // Under the old head-only truncation (slice(0, 64KB)) this secret's
    // start position (~150,000) is well past the cutoff and would never be
    // scanned at all -- the sweep would report clean with no signal that
    // coverage was incomplete. It also lands within the last 32KB, so the
    // head+tail split must catch it via the tail half.
    const filler = "x".repeat(150_000);
    const secret = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const oversizedError = `${filler}\ntoken=${secret}`;
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      error: oversizedError,
    });

    const sweep = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: null });

    expect(sweep.rowsScanned).toBe(1);
    expect(sweep.oversizedFieldsScanned).toBe(1);
    expect(sweep.matchesFound).toBe(1);
    expect(sweep.issuesFiled).toBe(1);
  });

  it("DUR-387: a secret in the unscanned middle third of an oversized field is correctly not detected, but the sweep still flags the field as oversized", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { title: "Security Reviewer" });
    const runnerAgentId = await seedAgent(companyId);

    // 300KB field: the head+tail split only scans the first and last 32KB, so
    // a secret placed at the midpoint (~150,000) sits well outside both
    // windows -- pinning down that this is the documented residual gap
    // (DUR-387's review), not a regression that silently grows the scanned
    // window (e.g. an accidental head/tail overlap) or shrinks it to miss
    // even the covered halves.
    const secret = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const half = 150_000;
    const oversizedError = `${"x".repeat(half)}token=${secret}${"x".repeat(half)}`;
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: runnerAgentId,
      invocationSource: "on_demand",
      status: "succeeded",
      error: oversizedError,
    });

    const sweep = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: null });

    expect(sweep.rowsScanned).toBe(1);
    expect(sweep.oversizedFieldsScanned).toBe(1);
    expect(sweep.matchesFound).toBe(0);
    expect(sweep.issuesFiled).toBe(0);
  });

  it("walks .git/config, .env, and docker-compose files under a company path, skips excluded dirs, and attributes by path", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { title: "Security Reviewer" });

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "secret-scan-fs-"));
    try {
      const companyDir = path.join(root, "projects", companyId, "some-project", "repo");
      await fs.mkdir(path.join(companyDir, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(companyDir, ".git", "config"),
        '[remote "origin"]\n\turl = https://x-access-token:ghp_realTokenLooksLikeThis123456789012@github.com/acme/repo.git\n',
      );
      // Split from the vendor prefix -- see secret-surface-scanner.test.ts
      // for why (GitHub push-protection flags a contiguous match).
      await fs.writeFile(
        path.join(companyDir, ".env"),
        "SHOPIFY_ACCESS_TOKEN=" + "shpat_" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4\n",
      );
      await fs.writeFile(
        path.join(companyDir, "docker-compose.yml"),
        "services:\n  app:\n    environment:\n      AWS_ACCESS_KEY_ID: AKIAABCDEFGHIJKLMNOP\n",
      );

      // Excluded: vendored deps and a test fixture should never be walked/scanned.
      const excludedDir = path.join(companyDir, "node_modules", "some-pkg");
      await fs.mkdir(excludedDir, { recursive: true });
      await fs.writeFile(path.join(excludedDir, ".env"), "SHOULD_NOT_BE_FOUND=sk-ignoredIgnoredIgnored123456\n");
      const fixtureDir = path.join(companyDir, "__fixtures__");
      await fs.mkdir(fixtureDir, { recursive: true });
      await fs.writeFile(path.join(fixtureDir, ".env"), "SHOULD_NOT_BE_FOUND=sk-ignoredIgnoredIgnored123456\n");

      const summary = await scanFilesystemForLeakedSecrets(db, { root });
      expect(summary.matchesFound).toBe(3);
      expect(summary.issuesFiled).toBe(3);
      expect(summary.unattributedMatches).toBe(0);

      const filedIssues = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, SECRET_SCAN_ORIGIN_KIND)));
      expect(filedIssues).toHaveLength(3);
      const surfacesSeen = filedIssues.map((row) => row.description ?? "").join("\n");
      expect(surfacesSeen).toContain(".git/config remote URL");
      expect(surfacesSeen).toContain(".env file");
      expect(surfacesSeen).toContain("docker-compose file");
      for (const row of filedIssues) {
        expect(row.description ?? "").not.toContain("realTokenLooksLikeThis123456789012");
        expect(row.description ?? "").not.toContain("ignoredIgnoredIgnored123456");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
