import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bragJobs,
  companies,
  costEvents,
  createDb,
  issueComments,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import { BRAG_BILLING_CODE, BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS, estimateBragOnDoneCostCents } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const store = new Map<string, Buffer>();
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    putFile: async (i: { body: Buffer; originalFilename: string; contentType: string }) => {
      const objectKey = `k/${randomUUID()}`;
      store.set(objectKey, i.body);
      return { provider: "local_disk", objectKey, contentType: i.contentType, byteSize: i.body.length, sha256: "x", originalFilename: i.originalFilename };
    },
    getObject: async (_c: string, key: string) => ({ stream: Readable.from([store.get(key)!]) }),
  }),
}));

import { bragService } from "../services/brag.ts";
import { BRAG_ON_DONE_OVER_CAP_CARD_KEY, bragOnDoneService, summarySnippetsFromMarkdown } from "../services/brag-on-done.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const PERSON = "user-pre-approver";

d("brag video when a task is done", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof bragOnDoneService>;
  const saved: Array<{ filename: string; issueId: string | null | undefined; actorUserId: string | null; actorAgentId: string | null | undefined }> = [];

  async function makeCompany(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "C", issuePrefix: "BD" + Math.floor(Math.random() * 1e7), ...overrides } as never);
    return id;
  }

  async function makeIssue(companyId: string, overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Ship the export button", status: "in_progress", ...overrides } as never);
    return id;
  }

  async function setStatus(issueId: string, status: string) {
    await db.update(issues).set({ status }).where(eq(issues.id, issueId));
  }

  async function jobsFor(issueId: string) {
    const rows = await db.select().from(bragJobs);
    return rows.filter((r) => (r.options as { issueId?: string }).issueId === issueId);
  }

  async function issueRow(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("brag-on-done");
    stop = started.cleanup;
    db = createDb(started.connectionString);
    const brag = bragService(db, {
      capturer: {
        captureStill: async ({ text }) => Buffer.from(`still:${text}`),
        makeClip: async () => Buffer.from("clip"),
      },
      stitch: async (clips) => ({ buffer: Buffer.concat(clips), contentType: "video/mp4" }),
      saveFile: async ({ filename, issueId, actor }) => {
        saved.push({ filename, issueId, actorUserId: actor.userId, actorAgentId: actor.agentId });
        return { id: randomUUID() };
      },
    });
    svc = bragOnDoneService(db, { brag });
  }, 120_000);

  afterAll(async () => { await stop?.(); });

  it("records who pre-approved it, when, and the company's cost cap", async () => {
    const companyId = await makeCompany();
    const issueId = await makeIssue(companyId);
    const record = await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true });
    expect(record).toMatchObject({ approvedByUserId: PERSON, maxCostCents: BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS, lengthSeconds: 30 });
    expect(BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS).toBeGreaterThan(estimateBragOnDoneCostCents());
    expect((await issueRow(issueId)).bragPreapproval).toMatchObject({ approvedByUserId: PERSON });

    const capped = await makeCompany({ bragOnDoneMaxCostCents: 120 });
    const other = await makeIssue(capped);
    expect((await svc.setPreapproval({ companyId: capped, issueId: other, userId: PERSON, enabled: true }))?.maxCostCents).toBe(120);
  });

  it("can be unticked while the task is not done", async () => {
    const companyId = await makeCompany();
    const issueId = await makeIssue(companyId);
    await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true });
    await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: false });
    expect((await issueRow(issueId)).bragPreapproval).toBeNull();
    await setStatus(issueId, "done");
    expect(await svc.tick(50)).toMatchObject({ completed: 0 });
    expect(await jobsFor(issueId)).toHaveLength(0);
  });

  it("refuses to change the choice once the task is done", async () => {
    const companyId = await makeCompany();
    const issueId = await makeIssue(companyId, { status: "done" });
    await expect(svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true })).rejects.toMatchObject({ status: 409 });
  });

  it("done makes exactly one video, within the cap, under the pre-approver's authority, and comments the link", async () => {
    const companyId = await makeCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Proj" } as never);
    const issueId = await makeIssue(companyId, { projectId });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "agent",
      body: "## Result\n- Added a one-click CSV export to the reports page.\n- Large reports now download in the background.",
    } as never);
    await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true });

    // Not done yet: nothing happens.
    expect(await svc.processIssue(companyId, issueId)).toBeNull();

    await setStatus(issueId, "done");
    saved.length = 0;
    expect(await svc.processIssue(companyId, issueId)).toBe("completed");

    const jobs = await jobsFor(issueId);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.status).toBe("completed");
    expect(job.projectId).toBe(projectId);
    expect(job.createdByUserId).toBe(PERSON);
    expect(job.createdByAgentId).toBeNull();
    expect(job.actualCostCents).toBeLessThanOrEqual(BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS);
    expect((job.options as { taskMaterial?: { title: string; snippets: string[] } }).taskMaterial).toMatchObject({
      title: "Done: Ship the export button",
      snippets: expect.arrayContaining(["Added a one-click CSV export to the reports page."]),
    });
    expect(saved.map((s) => s.filename)).toEqual(["brag.mp4", "brag-poster.png"]);
    expect(saved.every((s) => s.issueId === issueId && s.actorUserId === PERSON && !s.actorAgentId)).toBe(true);

    const spend = await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.billingCode, BRAG_BILLING_CODE)));
    expect(spend).toHaveLength(1);
    expect(spend[0]!.createdByUserId).toBe(PERSON);
    expect(spend[0]!.agentId).toBeNull();
    expect(spend[0]!.costCents).toBeLessThanOrEqual(BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS);

    const comments = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toMatch(/\[Watch the brag video\]\(\/api\/attachments\/[0-9a-f-]+\/content\)/);

    const pre = (await issueRow(issueId)).bragPreapproval!;
    expect(pre).toMatchObject({ outcome: "completed", bragJobId: job.id });
    expect(pre.triggeredAt).toBeTruthy();

    // Running again (or a second sweep) does nothing.
    expect(await svc.processIssue(companyId, issueId)).toBeNull();
    await svc.tick(50);
    expect(await jobsFor(issueId)).toHaveLength(1);

    // And the choice is locked now.
    await setStatus(issueId, "todo");
    await expect(svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: false })).rejects.toMatchObject({ status: 409 });
  });

  it("reopening and closing again never makes a second video", async () => {
    const companyId = await makeCompany();
    const issueId = await makeIssue(companyId);
    await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true });
    await setStatus(issueId, "done");
    await svc.tick(50);
    expect(await jobsFor(issueId)).toHaveLength(1);
    await setStatus(issueId, "todo");
    await setStatus(issueId, "done");
    await svc.tick(50);
    expect(await svc.processIssue(companyId, issueId)).toBeNull();
    expect(await jobsFor(issueId)).toHaveLength(1);
  });

  it("works for a task without a project", async () => {
    const companyId = await makeCompany();
    const issueId = await makeIssue(companyId, { description: "Rewrote the onboarding emails so new customers know what to do first." });
    await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true });
    await setStatus(issueId, "done");
    expect(await svc.processIssue(companyId, issueId)).toBe("completed");
    const [job] = await jobsFor(issueId);
    expect(job!.projectId).toBeNull();
  });

  it("is refused when the company has the setting off, and a later switch-off makes no video", async () => {
    const off = await makeCompany({ bragOnDoneEnabled: false });
    const issueId = await makeIssue(off);
    await expect(svc.setPreapproval({ companyId: off, issueId, userId: PERSON, enabled: true })).rejects.toMatchObject({ status: 422 });
    await expect(svc.assertEnabled(off)).rejects.toMatchObject({ status: 422 });

    const companyId = await makeCompany();
    const ticked = await makeIssue(companyId);
    await svc.setPreapproval({ companyId, issueId: ticked, userId: PERSON, enabled: true });
    await db.update(companies).set({ bragOnDoneEnabled: false }).where(eq(companies.id, companyId));
    await setStatus(ticked, "done");
    expect(await svc.processIssue(companyId, ticked)).toBe("turned_off");
    expect(await jobsFor(ticked)).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ticked));
    expect(comments[0]!.body).toMatch(/turned off/);
  });

  it("is company scoped", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    const issueId = await makeIssue(companyA);
    await expect(svc.setPreapproval({ companyId: companyB, issueId, userId: PERSON, enabled: true })).rejects.toMatchObject({ status: 404 });
    await svc.setPreapproval({ companyId: companyA, issueId, userId: PERSON, enabled: true });
    await setStatus(issueId, "done");
    expect(await svc.processIssue(companyB, issueId)).toBeNull();
    expect(await jobsFor(issueId)).toHaveLength(0);
    expect(await svc.processIssue(companyA, issueId)).toBe("completed");
    const [job] = await jobsFor(issueId);
    expect(job!.companyId).toBe(companyA);
  });

  it("over the cap: makes nothing, asks with a question card, and only that card from a person continues it", async () => {
    const companyId = await makeCompany({ bragOnDoneMaxCostCents: 1 });
    const issueId = await makeIssue(companyId);
    await svc.setPreapproval({ companyId, issueId, userId: PERSON, enabled: true });
    await setStatus(issueId, "done");
    expect(await svc.processIssue(companyId, issueId)).toBe("over_cap");
    const [job] = await jobsFor(issueId);
    expect(job!.status).toBe("draft");
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(0);

    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.kind).toBe("request_confirmation");
    expect((card.payload as { target?: { key?: string; revisionId?: string } }).target).toMatchObject({ key: BRAG_ON_DONE_OVER_CAP_CARD_KEY, revisionId: job!.id });

    // A look-alike card written by an agent is ignored.
    const forged = { ...card, status: "accepted", createdByAgentId: randomUUID() };
    expect(await svc.acceptOverCap({ issue: { id: issueId, companyId }, interaction: forged, userId: "someone" })).toBe(false);
    // So is a card that was not accepted.
    expect(await svc.acceptOverCap({ issue: { id: issueId, companyId }, interaction: { ...card, status: "pending" }, userId: "someone" })).toBe(false);

    const accepted = { ...card, status: "accepted" };
    expect(await svc.acceptOverCap({ issue: { id: issueId, companyId }, interaction: accepted, userId: "person-who-accepted" })).toBe(true);
    // Answering twice records nothing new.
    expect(await svc.acceptOverCap({ issue: { id: issueId, companyId }, interaction: accepted, userId: "person-who-accepted" })).toBe(false);

    // The sweep makes it, as the person who accepted -- once, even if the task was reopened meanwhile.
    await setStatus(issueId, "todo");
    const swept = await svc.tick(50);
    expect(swept.completed).toBeGreaterThanOrEqual(1);
    const [after] = await jobsFor(issueId);
    expect(after!.status).toBe("completed");
    const spend = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(spend).toHaveLength(1);
    expect(spend[0]!.createdByUserId).toBe("person-who-accepted");
    expect((await issueRow(issueId)).bragPreapproval).toMatchObject({ outcome: "completed", acceptedByUserId: "person-who-accepted" });
    await svc.tick(50);
    expect(await jobsFor(issueId)).toHaveLength(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
  });

  it("turns a markdown result into short plain sentences", () => {
    expect(summarySnippetsFromMarkdown("# Done\n- [x] Fixed the **login** loop for [Safari](https://x.y).\n```\ncode\n```\nok", 5)).toEqual([
      "Fixed the login loop for Safari.",
    ]);
  });
});
