import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issueComments,
  issueOverlaps,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  computeOverlaps,
  issueOverlapDetectorService,
  nextFreeMigrationNumber,
  suggestOrder,
  type PrProgress,
  type WorkspaceSnapshot,
} from "./issue-overlap-detector.js";

const JOURNAL = "packages/db/src/migrations/meta/_journal.json";

function snap(
  issueId: string,
  files: Record<string, string>,
  extra: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    issueId,
    workspaceId: `ws-${issueId}`,
    files: new Map(Object.entries(files)),
    staleFiles: new Map(),
    baseMigrationNumbers: [216],
    ...extra,
  };
}

describe("computeOverlaps", () => {
  it("reports one file row per shared file, with a canonical issue pair", () => {
    const rows = computeOverlaps([
      snap("b", { "server/a.ts": "M", "server/only-b.ts": "M" }),
      snap("a", { "server/a.ts": "M", "server/only-a.ts": "M" }),
    ]);
    expect(rows).toEqual([
      { issueAId: "a", issueBId: "b", kind: "file", detailKey: "server/a.ts", detail: { file: "server/a.ts" } },
    ]);
  });

  it("flags two issues that add the same migration number, but not different numbers", () => {
    const same = computeOverlaps([
      snap("a", { "packages/db/src/migrations/0218_x.sql": "A" }),
      snap("b", { "packages/db/src/migrations/0218_y.sql": "A" }),
    ]);
    expect(same.map((r) => [r.kind, r.detailKey])).toEqual([["migration_number", "0218"]]);
    const different = computeOverlaps([
      snap("a", { "packages/db/src/migrations/0218_x.sql": "A" }),
      snap("b", { "packages/db/src/migrations/0219_y.sql": "A" }),
    ]);
    expect(different).toEqual([]);
  });

  it("flags a shared _journal.json as journal_json, not as a plain file overlap", () => {
    const rows = computeOverlaps([snap("a", { [JOURNAL]: "M" }), snap("b", { [JOURNAL]: "M" })]);
    expect(rows.map((r) => r.kind)).toEqual(["journal_json"]);
  });

  it("flags stale-behind only for files the branch also touches", () => {
    const rows = computeOverlaps([
      snap("a", { "server/x.ts": "M" }, { staleFiles: new Map([["server/x.ts", "abc1234 Fix x"], ["server/y.ts", "def Fix y"]]) }),
    ]);
    expect(rows).toEqual([
      {
        issueAId: "a",
        issueBId: "a",
        kind: "stale_behind",
        detailKey: "server/x.ts",
        detail: { file: "server/x.ts", mergedCommit: "abc1234 Fix x" },
      },
    ]);
  });

  it("ignores two issues that share one workspace", () => {
    const a = snap("a", { "server/a.ts": "M" });
    const b = { ...snap("b", { "server/a.ts": "M" }), workspaceId: a.workspaceId };
    expect(computeOverlaps([a, b])).toEqual([]);
  });
});

describe("suggestOrder / nextFreeMigrationNumber", () => {
  const ready: PrProgress = { ci: "met", review: "approved", merged: false };
  const early: PrProgress = { ci: "not_met", review: "none", merged: false };

  it("recommends the PR that is further along first, and never picks on a tie", () => {
    expect(suggestOrder(ready, early)).toBe("a_first");
    expect(suggestOrder(early, ready)).toBe("b_first");
    expect(suggestOrder(null, null)).toBe("none");
    expect(suggestOrder(ready, ready)).toBe("none");
    expect(suggestOrder({ ci: "met", review: "changes_requested", merged: false }, null)).toBe("b_first");
  });

  it("suggests max+1 across the base and every open branch", () => {
    expect(
      nextFreeMigrationNumber([
        snap("a", { "packages/db/src/migrations/0218_x.sql": "A" }),
        snap("b", { "packages/db/src/migrations/0219_y.sql": "A" }),
      ]),
    ).toBe("0220");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueOverlapDetectorService (DB-backed)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-overlap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueOverlaps);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const prefix = `O${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Overlap Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "active" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "active",
      adapterType: "opencode_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    async function issueWithWorkspace(n: number, status = "in_progress") {
      const workspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: workspaceId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: `ws${n}`, status: "active", cwd: `/tmp/ws${n}`, branchName: `b${n}`, baseRef: "origin/custom",
      });
      const id = randomUUID();
      await db.insert(issues).values({
        id, companyId, projectId, title: `Task ${n}`, status, priority: "medium",
        assigneeAgentId: agentId, issueNumber: n, identifier: `${prefix}-${n}`, executionWorkspaceId: workspaceId,
      });
      return { id, workspaceId };
    }
    return { companyId, issueWithWorkspace };
  }

  function makeService(
    state: Map<string, any>,
    pr: Record<string, PrProgress> = {},
    now: { value: Date } = { value: new Date() },
  ) {
    return issueOverlapDetectorService(db, {
      snapshotWorkspace: async (ws) => state.get(ws.cwd) ?? null,
      getPrProgress: async (_c, issueId) => pr[issueId] ?? null,
      now: () => now.value,
    });
  }

  const shape = (files: Record<string, string>) => ({
    files: new Map(Object.entries(files)),
    staleFiles: new Map<string, string | null>(),
    baseMigrationNumbers: [217],
  });

  async function commentsOn(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  it("detects a file overlap, comments once on both issues with a suggested order, and never re-comments", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    const a = await issueWithWorkspace(1);
    const b = await issueWithWorkspace(2);
    const state = new Map<string, any>([
      ["/tmp/ws1", shape({ "server/shared.ts": "M" })],
      ["/tmp/ws2", shape({ "server/shared.ts": "M" })],
    ]);
    const svc = makeService(state, {
      [a.id]: { ci: "met", review: "approved", merged: false },
      [b.id]: { ci: "unknown", review: "none", merged: false },
    });

    const first = await svc.runOverlapDetection(companyId);
    expect(first).toMatchObject({ opened: 1, commentsPosted: 2 });
    const [ca, cb] = [await commentsOn(a.id), await commentsOn(b.id)];
    expect(ca).toHaveLength(1);
    expect(cb).toHaveLength(1);
    expect(ca[0]!.authorType).toBe("system");
    expect(ca[0]!.body).toContain("server/shared.ts");
    expect(ca[0]!.body).toContain("this task goes first");
    expect(cb[0]!.body).toContain("goes first (its PR is further along); wait and rebase");

    for (let i = 0; i < 3; i++) await svc.runOverlapDetection(companyId);
    expect(await commentsOn(a.id)).toHaveLength(1);
    expect(await commentsOn(b.id)).toHaveLength(1);
    expect(await svc.listOpenOverlaps(companyId)).toHaveLength(1);
  });

  it("batches several shared files of one pair into a single comment per issue", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    const a = await issueWithWorkspace(1);
    await issueWithWorkspace(2);
    const both = shape({ "server/one.ts": "M", "server/two.ts": "M", "server/three.ts": "M" });
    const svc = makeService(new Map<string, any>([["/tmp/ws1", both], ["/tmp/ws2", both]]));
    await svc.runOverlapDetection(companyId);
    const comments = await commentsOn(a.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toMatch(/one\.ts[\s\S]*two\.ts[\s\S]*three\.ts/);
  });

  it("warns about a migration-number collision and names the next free number", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    const a = await issueWithWorkspace(1);
    await issueWithWorkspace(2);
    const state = new Map<string, any>([
      ["/tmp/ws1", shape({ "packages/db/src/migrations/0218_a.sql": "A" })],
      ["/tmp/ws2", shape({ "packages/db/src/migrations/0218_b.sql": "A" })],
    ]);
    await makeService(state).runOverlapDetection(companyId);
    const rows = await db.select().from(issueOverlaps);
    expect(rows.map((r) => [r.kind, r.detailKey])).toEqual([["migration_number", "0218"]]);
    expect((await commentsOn(a.id))[0]!.body).toContain("next free number: `0219`");
  });

  it("flags a _journal.json collision and a stale-behind branch", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    const a = await issueWithWorkspace(1);
    await issueWithWorkspace(2);
    const stale = { ...shape({ [JOURNAL]: "M", "server/x.ts": "M" }), staleFiles: new Map([["server/x.ts", "abc Fix x"]]) };
    const state = new Map<string, any>([["/tmp/ws1", stale], ["/tmp/ws2", shape({ [JOURNAL]: "M" })]]);
    await makeService(state).runOverlapDetection(companyId);
    const kinds = (await db.select().from(issueOverlaps)).map((r) => r.kind).sort();
    expect(kinds).toEqual(["journal_json", "stale_behind"]);
    const bodies = (await commentsOn(a.id)).map((c) => c.body).join("\n");
    expect(bodies).toContain("behind the base branch");
    expect(bodies).toContain("_journal.json");
  });

  it("resolves an overlap that is no longer detected, and warns again only if it re-opens", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    const a = await issueWithWorkspace(1);
    await issueWithWorkspace(2);
    const state = new Map<string, any>([
      ["/tmp/ws1", shape({ "server/shared.ts": "M" })],
      ["/tmp/ws2", shape({ "server/shared.ts": "M" })],
    ]);
    const svc = makeService(state);
    await svc.runOverlapDetection(companyId);

    state.set("/tmp/ws2", shape({ "server/other.ts": "M" }));
    expect(await svc.runOverlapDetection(companyId)).toMatchObject({ resolved: 1 });
    expect(await svc.listOpenOverlaps(companyId)).toHaveLength(0);
    expect((await db.select().from(issueOverlaps))[0]).toMatchObject({ status: "resolved" });

    state.set("/tmp/ws2", shape({ "server/shared.ts": "M" }));
    await svc.runOverlapDetection(companyId);
    expect(await commentsOn(a.id)).toHaveLength(2);
  });

  it("does not resolve overlaps when a workspace could not be read", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    await issueWithWorkspace(1);
    await issueWithWorkspace(2);
    const state = new Map<string, any>([
      ["/tmp/ws1", shape({ "server/shared.ts": "M" })],
      ["/tmp/ws2", shape({ "server/shared.ts": "M" })],
    ]);
    const svc = makeService(state);
    await svc.runOverlapDetection(companyId);
    state.delete("/tmp/ws2");
    expect(await svc.runOverlapDetection(companyId)).toMatchObject({ resolved: 0 });
    expect(await svc.listOpenOverlaps(companyId)).toHaveLength(1);
  });

  it("ignores done issues", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    await issueWithWorkspace(1);
    await issueWithWorkspace(2, "done");
    const both = shape({ "server/shared.ts": "M" });
    const svc = makeService(new Map<string, any>([["/tmp/ws1", both], ["/tmp/ws2", both]]));
    expect(await svc.runOverlapDetection(companyId)).toMatchObject({ opened: 0, workspacesScanned: 1 });
  });

  it("surfaces activeOverlapWarnings only for overlaps re-confirmed in the last 30 minutes", async () => {
    const { companyId, issueWithWorkspace } = await seed();
    const a = await issueWithWorkspace(1);
    const b = await issueWithWorkspace(2);
    const both = shape({ "server/shared.ts": "M" });
    const now = { value: new Date("2026-10-03T12:00:00Z") };
    const svc = makeService(new Map<string, any>([["/tmp/ws1", both], ["/tmp/ws2", both]]), {}, now);
    await svc.runOverlapDetection(companyId);

    const within = await svc.listActiveWarningsForIssue(companyId, a.id, new Date("2026-10-03T12:29:00Z"));
    expect(within).toHaveLength(1);
    expect(within[0]!.otherIssue.id).toBe(b.id);
    expect(within[0]!.instruction).toContain("check");
    expect(await svc.listActiveWarningsForIssue(companyId, a.id, new Date("2026-10-03T12:31:00Z"))).toHaveLength(0);
  });

  it("scopes overlaps to the company", async () => {
    const one = await seed();
    const other = await seed();
    await one.issueWithWorkspace(1);
    await one.issueWithWorkspace(2);
    const both = shape({ "server/shared.ts": "M" });
    const svc = makeService(new Map<string, any>([["/tmp/ws1", both], ["/tmp/ws2", both]]));
    await svc.runOverlapDetection(one.companyId);
    expect(await svc.listOpenOverlaps(other.companyId)).toHaveLength(0);
    expect(await svc.listOpenOverlaps(one.companyId)).toHaveLength(1);
  });
});
