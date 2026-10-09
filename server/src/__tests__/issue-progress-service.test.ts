import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { collectProgressLines } from "../services/morning-report.ts";
import { formatProgressReportLine, progressMapForParents } from "../services/issue-progress.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("issue progress/ETA (DUR-4467)", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const now = new Date("2026-03-10T12:00:00.000Z");
  const started = new Date("2026-03-08T12:00:00.000Z"); // 2 days ago

  beforeAll(async () => {
    const s = await startEmbeddedPostgresTestDatabase("issue-progress");
    stop = s.cleanup;
    db = createDb(s.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "P Co", issuePrefix: `P${id.slice(0, 5).toUpperCase()}` });
    return id;
  }
  async function parent(companyId: string, title: string, status: string, n: number) {
    const [row] = await db
      .insert(issues)
      .values({ companyId, title, status, startedAt: started, identifier: `T-${n}`, issueNumber: n })
      .returning();
    return row!;
  }
  async function child(companyId: string, parentId: string, status: string, sizeLabel: "S" | "M" | "L" | null, n: number) {
    await db.insert(issues).values({ companyId, parentId, title: `c${n}`, status, sizeLabel, identifier: `T-${n}`, issueNumber: n });
  }

  it("computes weighted percent and ETA on getById, batched, company-scoped", async () => {
    const c = await company();
    const p = await parent(c, "big", "in_progress", 1);
    await child(c, p.id, "done", "S", 2);
    await child(c, p.id, "done", "M", 3);
    await child(c, p.id, "todo", "L", 4);
    await child(c, p.id, "cancelled", "L", 5);
    const got = await issueService(db).getById(p.id);
    expect(got?.progress).toMatchObject({ completedCount: 2, totalCount: 3, completedWeight: 3, totalWeight: 6, percent: 50 });
    expect(got?.progress?.etaAt).toBeInstanceOf(Date);

    const other = await company();
    const map = await progressMapForParents(db, [{ id: p.id, companyId: other, startedAt: started }], now);
    expect(map.size).toBe(0); // children of another company's parent id are never read cross-company
  });

  it("has no progress without children and no ETA with fewer than 2 done", async () => {
    const c = await company();
    const lone = await parent(c, "lone", "in_progress", 10);
    expect((await issueService(db).getById(lone.id))?.progress).toBeNull();
    const p = await parent(c, "one-done", "in_progress", 11);
    await child(c, p.id, "done", "S", 12);
    await child(c, p.id, "todo", "S", 13);
    const got = await issueService(db).getById(p.id);
    expect(got?.progress?.percent).toBe(50);
    expect(got?.progress?.etaAt).toBeNull();
  });

  it("morning report lines: only in-progress parents with an ETA", async () => {
    const c = await company();
    const p = await parent(c, "big", "in_progress", 20);
    await child(c, p.id, "done", "S", 21);
    await child(c, p.id, "done", "S", 22);
    await child(c, p.id, "todo", "S", 23);
    const one = await parent(c, "few", "in_progress", 24);
    await child(c, one.id, "done", "S", 25);
    await child(c, one.id, "todo", "S", 26);
    const todoParent = await parent(c, "notstarted", "todo", 27);
    await child(c, todoParent.id, "done", "S", 28);
    await child(c, todoParent.id, "done", "S", 29);
    await child(c, todoParent.id, "todo", "S", 30);
    const lines = await collectProgressLines(db, c, new Date(Date.now() + 1000));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^T-20 is 67% done, about .+ left$/);
    expect(lines[0]).not.toContain("≈");
  });

  it("formats the line without the clock part", () => {
    const line = formatProgressReportLine("DUR-1", {
      percent: 60,
      etaLabel: "about 1 d left (≈ 14:30)",
    } as never);
    expect(line).toBe("DUR-1 is 60% done, about 1 d left");
    expect(formatProgressReportLine("DUR-1", { percent: 10, etaLabel: null } as never)).toBeNull();
  });
});
