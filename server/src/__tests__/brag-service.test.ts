import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bragJobs, bragScenes, companies, createDb, projects } from "@paperclipai/db";
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

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const ACTOR = { userId: "user-1" };

d("bragService gate (DUR-4520)", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId: string;
  let projectId: string;
  const makeCalls = { clips: 0, saved: [] as string[] };
  let svc!: ReturnType<typeof bragService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("brag-service");
    stop = started.cleanup;
    db = createDb(started.connectionString);
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C", issuePrefix: "BR" + Math.floor(Math.random() * 1e6) } as never);
    await db.insert(projects).values({ id: projectId, companyId, name: "Proj" } as never);
    svc = bragService(db, {
      capturer: {
        captureStill: async ({ text }) => Buffer.from(`still:${text}`),
        makeClip: async () => { makeCalls.clips += 1; return Buffer.from("clip"); },
      },
      loadSource: async () => ({ kind: "website", title: "Acme", snippets: ["One great thing", "Another great thing"], skipped: [] }),
      stitch: async (clips) => ({ buffer: Buffer.concat(clips), contentType: "video/mp4" }),
      saveFile: async ({ filename }) => { makeCalls.saved.push(filename); return { id: randomUUID() }; },
    });
  }, 120_000);

  afterAll(async () => { await stop?.(); });

  it("refuses a render until every kept scene is approved, then renders and saves video + poster", async () => {
    const job = await svc.createJob(companyId, ACTOR, { projectId, format: "landscape", lengthSeconds: 12, music: false, sourceUrl: "https://acme.example.com" } as never);
    const planned = await svc.planJob(companyId, job.id, ACTOR);
    expect(planned.job.status).toBe("awaiting_approval");
    expect(planned.scenes.length).toBe(3);
    const [a, b, ...rest] = planned.scenes;

    await expect(svc.render(companyId, job.id, ACTOR)).rejects.toThrow(/not been approved/);
    expect(makeCalls.clips).toBe(0);

    await svc.updateScene(companyId, job.id, a!.id, { action: "approve" });
    await svc.updateScene(companyId, job.id, b!.id, { action: "leave_out" });
    for (const s of rest) await svc.updateScene(companyId, job.id, s.id, { action: "approve" });

    // an edit sends the scene back to pending and blocks the render again
    if (rest[0]) {
      const scenes = await svc.updateScene(companyId, job.id, rest[0].id, { action: "edit", description: "New copy API_KEY=supersecretvalue9" });
      const edited = scenes.find((s) => s.id === rest[0]!.id)!;
      expect(edited.approvalStatus).toBe("pending");
      expect(edited.description).not.toContain("supersecretvalue9");
      await expect(svc.render(companyId, job.id, ACTOR)).rejects.toThrow(/not been approved/);
      await svc.updateScene(companyId, job.id, rest[0].id, { action: "approve" });
    }

    const done = await svc.render(companyId, job.id, ACTOR);
    expect(done.job.status).toBe("completed");
    expect(makeCalls.saved).toEqual(["brag.mp4", "brag-poster.png"]);
    expect(makeCalls.clips).toBe(done.scenes.filter((s) => s.approvalStatus === "approved").length);
    await expect(svc.render(companyId, job.id, ACTOR)).rejects.toThrow(/completed/);
  });

  it("is company scoped: another company cannot read a job", async () => {
    const job = await svc.createJob(companyId, ACTOR, { projectId, format: "square", lengthSeconds: 8, music: false } as never);
    await expect(svc.getJob(randomUUID(), job.id)).rejects.toThrow(/not found/i);
    await db.delete(bragScenes).where(eq(bragScenes.jobId, job.id));
    await db.delete(bragJobs).where(eq(bragJobs.id, job.id));
  });

  it("refuses to create a job for a project in another company", async () => {
    await expect(svc.createJob(companyId, ACTOR, { projectId: randomUUID(), format: "square", lengthSeconds: 8, music: false } as never)).rejects.toThrow(/not found/i);
  });
});
