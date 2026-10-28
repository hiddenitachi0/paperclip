import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issues,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { MEDIA_STUDIO_PLUGIN_KEY } from "@paperclipai/shared";
import { tryTakeUploadSlot, UPLOADS_IN_FLIGHT_PER_COMPANY, uploadSlotsInUse } from "../services/company-upload-slots.js";
import { issueService } from "../services/issues.js";
import { companyStorageUsedBytes } from "../services/media-storage-quota.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { openLaneAPluginRun } from "../services/lane-a-plugin-runs.js";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * D18 security review F3: ffprobe stands in as a mock here (the real check has
 * its own tests in large-video-storage.test.ts). The first bytes are still
 * sniffed for real; then "ffprobe" answers what the test says.
 */
const probe = vi.hoisted(() => ({ isVideo: true, calls: 0 }));
vi.mock("../services/video-ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/video-ffmpeg.js")>();
  const { readFile } = await import("node:fs/promises");
  return {
    ...actual,
    verifyVideoFile: async (filePath: string) => {
      if (!actual.sniffVideoContainer((await readFile(filePath)).subarray(0, 16))) return false;
      probe.calls += 1;
      return probe.isVideo;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin host services company file tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

function createStorageServiceStub(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(async (input) => ({
      provider: "local_disk",
      // Keys start with the company id, as the real storage service makes them.
      objectKey: `${input.companyId}/${input.namespace}/${randomUUID()}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "stub-sha256",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(async () => {
      const { Readable } = await import("node:stream");
      return { stream: Readable.from([Buffer.from("stored-picture-bytes")]), contentType: "image/png", contentLength: 20 } as any;
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describeEmbeddedPostgres("plugin-host-services files (company files not tied to a task)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-host-services-company-files-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
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
    const runId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Maja", role: "general" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "general" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running" },
      { id: otherRunId, companyId: otherCompanyId, agentId: otherAgentId, status: "running" },
    ]);
    return { companyId, otherCompanyId, agentId, otherAgentId, runId, otherRunId };
  }

  const png = () => ({
    contentBase64: Buffer.from("fake-png-bytes").toString("base64"),
    contentType: "image/png",
    filename: "image-seed-42.png",
  });

  function services(storage: StorageService = createStorageServiceStub(), pluginKey = "media-studio-test") {
    return buildHostServices(db, randomUUID(), pluginKey, createEventBusStub(), undefined, { storage });
  }

  it("saves a quick agent's picture as a company file with no task, authored by that agent, with its run logged", async () => {
    const { companyId, agentId } = await seed();
    const storage = createStorageServiceStub();
    const { run, close } = openLaneAPluginRun({
      agentId,
      companyId,
      conversationId: randomUUID(),
      requestedByUserId: "user-1",
      requestedByAgentId: null,
      requesterMessage: "make a picture of a sofa",
    });
    try {
      const file = await services(storage).files.createCompanyFile({ companyId, ...png(), runId: run.runId });

      expect(file.companyId).toBe(companyId);
      expect(file.issueId).toBeNull();
      expect(file.createdByAgentId).toBe(agentId);
      expect(file.contentPath).toBe(`/api/attachments/${file.id}/content`);
      expect(storage.putFile).toHaveBeenCalledWith(
        expect.objectContaining({ companyId, namespace: "files", contentType: "image/png" }),
      );

      const [row] = await db.select().from(issueAttachments).where(eq(issueAttachments.id, file.id));
      expect(row?.companyId).toBe(companyId);
      expect(row?.issueId).toBeNull();
      const [asset] = await db.select().from(assets).where(eq(assets.id, row!.assetId));
      expect(asset?.companyId).toBe(companyId);
      expect(asset?.createdByAgentId).toBe(agentId);
      expect(asset?.originalFilename).toBe("image-seed-42.png");

      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "company.file.created"));
      expect(logged).toHaveLength(1);
      expect(logged[0]?.companyId).toBe(companyId);
      expect(logged[0]?.agentId).toBe(agentId);
      expect(logged[0]?.details).toMatchObject({ initiatingRunId: run.runId, initiatingQuickAgentId: agentId, attachmentId: file.id });
    } finally {
      close();
    }
  });

  it("records a full agent's heartbeat run on the activity row", async () => {
    const { companyId, agentId, runId } = await seed();
    const file = await services().files.createCompanyFile({ companyId, ...png(), runId });
    expect(file.createdByAgentId).toBe(agentId);
    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "company.file.created"));
    expect(logged[0]?.runId).toBe(runId);
  });

  it("shows the file in the Files page's No task group", async () => {
    const { companyId, runId } = await seed();
    const file = await services().files.createCompanyFile({ companyId, ...png(), runId });
    const { companyArtifactsService } = await import("../services/company-artifacts.js");
    const listed = await companyArtifactsService(db).list(companyId, { groupBy: "task", groupIssueId: "no-task" });
    expect(listed.artifacts.map((artifact) => artifact.id)).toContain(`attachment:${file.id}`);
    expect(listed.artifacts.find((artifact) => artifact.id === `attachment:${file.id}`)?.createdByAgent?.name).toBe("Maja");
  });

  it("refuses a run from another company, a missing run, and an unknown run", async () => {
    const { companyId, otherRunId } = await seed();
    await expect(services().files.createCompanyFile({ companyId, ...png(), runId: otherRunId })).rejects.toThrow(
      "Run not found in this company",
    );
    await expect(
      services().files.createCompanyFile({ companyId, ...png(), runId: undefined as unknown as string }),
    ).rejects.toThrow("runId is required");
    await expect(services().files.createCompanyFile({ companyId, ...png(), runId: randomUUID() })).rejects.toThrow(
      "Run not found in this company",
    );
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
  });

  describe("D18: large videos Media Studio saves to Files (security review F1-F3)", () => {
    const previousOptIn = process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64, 1)]);
    const mp4File = () => ({ contentBase64: mp4.toString("base64"), contentType: "video/mp4", filename: "video-fal-1234.mp4" });

    afterEach(() => {
      probe.isVideo = true;
      probe.calls = 0;
      if (previousOptIn === undefined) delete process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
      else process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = previousOptIn;
    });

    /** Media Studio installed on this server, and its settings row for the company. */
    async function installMediaStudio(companyId: string, opts: { status?: string; enabled?: boolean; settings?: Record<string, unknown> } = {}) {
      const [plugin] = await db
        .insert(plugins)
        .values({
          pluginKey: MEDIA_STUDIO_PLUGIN_KEY,
          packageName: "@paperclipai/plugin-media-studio",
          version: "1.0.0",
          manifestJson: {} as never,
          status: (opts.status ?? "ready") as never,
        })
        .returning();
      await db.insert(pluginCompanySettings).values({
        companyId,
        pluginId: plugin!.id,
        enabled: opts.enabled ?? true,
        settingsJson: opts.settings ?? {},
      });
    }

    async function smallLimit(companyId: string) {
      await db.update(companies).set({ attachmentMaxBytes: 16 }).where(eq(companies.id, companyId));
    }

    it("F1: keeps the company's ordinary limit unless the operator opted in, even for Media Studio's own videos", async () => {
      delete process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
      const { companyId, runId } = await seed();
      await smallLimit(companyId);
      await installMediaStudio(companyId);
      const storage = createStorageServiceStub();
      await expect(services(storage, MEDIA_STUDIO_PLUGIN_KEY).files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow(
        "The file is larger than this company allows (16 bytes)",
      );
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(probe.calls).toBe(0);
    });

    it("F1: keeps the ordinary limit for a company without Media Studio, even when the operator opted in", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, otherCompanyId, runId } = await seed();
      await smallLimit(companyId);
      // Media Studio is set up for another company only.
      await installMediaStudio(otherCompanyId);
      const storage = createStorageServiceStub();
      await expect(services(storage, MEDIA_STUDIO_PLUGIN_KEY).files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow(
        "The file is larger than this company allows (16 bytes)",
      );
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(await db.select().from(issueAttachments)).toHaveLength(0);
    });

    it("F1: keeps the ordinary limit when Media Studio is switched off on the server or for the company", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      for (const opts of [{ status: "disabled" }, { enabled: false }]) {
        const { companyId, runId } = await seed();
        await smallLimit(companyId);
        await installMediaStudio(companyId, opts);
        await expect(services(createStorageServiceStub(), MEDIA_STUDIO_PLUGIN_KEY).files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow(
          "The file is larger than this company allows (16 bytes)",
        );
        await db.delete(pluginCompanySettings);
        await db.delete(plugins);
      }
    });

    it("F1: another plugin never gets the larger limit", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, runId } = await seed();
      await smallLimit(companyId);
      await installMediaStudio(companyId);
      await expect(services(createStorageServiceStub(), "some-other-plugin").files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow(
        "The file is larger than this company allows (16 bytes)",
      );
    });

    it("lets a real video Media Studio made go past the ordinary limit where both allow it, counted in the media storage limit; nothing else", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, runId } = await seed();
      await smallLimit(companyId);
      await installMediaStudio(companyId);
      const storage = createStorageServiceStub();
      const svc = services(storage, MEDIA_STUDIO_PLUGIN_KEY);

      const video = await svc.files.createCompanyFile({ companyId, ...mp4File(), runId });
      expect(video.byteSize).toBe(mp4.length);
      // F2: kept where the company's media storage limit counts it.
      expect(storage.putFile).toHaveBeenCalledWith(expect.objectContaining({ companyId, namespace: "large-videos/files", contentType: "video/mp4" }));
      expect(probe.calls).toBe(1);
      expect(uploadSlotsInUse(companyId)).toBe(0);

      // A picture keeps the ordinary limit.
      await expect(
        svc.files.createCompanyFile({ companyId, ...png(), contentBase64: Buffer.alloc(64, 2).toString("base64"), runId }),
      ).rejects.toThrow("The file is larger than this company allows (16 bytes)");
      // Something that only says it is a video does not get the larger limit.
      await expect(
        svc.files.createCompanyFile({ companyId, contentBase64: Buffer.alloc(64, 3).toString("base64"), contentType: "video/mp4", filename: "x.mp4", runId }),
      ).rejects.toThrow("not an MP4, MOV or WebM video");
      // F3: nor does a file whose first bytes look right but that ffprobe does not see as a video.
      probe.isVideo = false;
      await expect(svc.files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow("not an MP4, MOV or WebM video");
      expect(await db.select().from(issueAttachments)).toHaveLength(1);
      expect(uploadSlotsInUse(companyId)).toBe(0);
    });

    it("F2: refuses a large video over the company's media storage limit, storing nothing", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, runId } = await seed();
      await smallLimit(companyId);
      await installMediaStudio(companyId, { settings: { mediaStorageQuotaBytes: mp4.length + 10 } });
      const storage = createStorageServiceStub();
      const svc = services(storage, MEDIA_STUDIO_PLUGIN_KEY);
      // The first one fits; the second would go over.
      await svc.files.createCompanyFile({ companyId, ...mp4File(), runId });
      await expect(svc.files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow("storage limit");
      expect(storage.putFile).toHaveBeenCalledTimes(1);
      expect(await db.select().from(issueAttachments)).toHaveLength(1);
      expect(uploadSlotsInUse(companyId)).toBe(0);
    });

    it("F2: asks a large video to wait while the company already has the most large uploads going; small files go on", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, runId } = await seed();
      await smallLimit(companyId);
      await installMediaStudio(companyId);
      const svc = services(createStorageServiceStub(), MEDIA_STUDIO_PLUGIN_KEY);
      const held = Array.from({ length: UPLOADS_IN_FLIGHT_PER_COMPANY }, () => tryTakeUploadSlot(companyId));
      try {
        await expect(svc.files.createCompanyFile({ companyId, ...mp4File(), runId })).rejects.toThrow("Other uploads for this company are still going");
        await svc.files.createCompanyFile({ companyId, contentBase64: Buffer.from("tiny").toString("base64"), contentType: "image/png", filename: "a.png", runId });
      } finally {
        held.forEach((release) => release?.());
      }
      await svc.files.createCompanyFile({ companyId, ...mp4File(), runId });
      expect(uploadSlotsInUse(companyId)).toBe(0);
    });
  });

  describe("D18 security review F2: one media storage limit per company", () => {
    async function asset(companyId: string, objectKey: string, byteSize: number) {
      await db.insert(assets).values({
        companyId,
        provider: "local_disk",
        objectKey,
        contentType: "video/mp4",
        byteSize,
        sha256: randomUUID(),
        originalFilename: "film.mp4",
      });
    }

    it("counts large videos on tasks and in Files with storyline music, and nothing else", async () => {
      const { companyId, otherCompanyId } = await seed();
      await asset(companyId, `${companyId}/large-videos/issues/${randomUUID()}/2026/10/28/a-film.mp4`, 1000);
      await asset(companyId, `${companyId}/large-videos/company-files/2026/10/28/b-film.mp4`, 2000);
      await asset(companyId, `${companyId}/video-storylines/music/2026/10/28/c-song.mp3`, 300);
      // Ordinary files on tasks and in Files are not counted.
      await asset(companyId, `${companyId}/issues/${randomUUID()}/2026/10/28/d-small.mp4`, 40_000);
      await asset(companyId, `${companyId}/company-files/2026/10/28/e-small.mp4`, 50_000);
      // Another company's large video is its own.
      await asset(otherCompanyId, `${otherCompanyId}/large-videos/company-files/2026/10/28/f-film.mp4`, 7000);
      expect(await companyStorageUsedBytes(db, companyId)).toBe(3300);
      expect(await companyStorageUsedBytes(db, otherCompanyId)).toBe(7000);
    });

    it("checks a large video's row against the limit in the same transaction as the insert", async () => {
      const { companyId } = await seed();
      const svc = issueService(db);
      const row = (name: string, byteSize: number) => ({
        companyId,
        provider: "local_disk",
        objectKey: `${companyId}/large-videos/company-files/2026/10/28/${name}`,
        contentType: "video/mp4",
        byteSize,
        sha256: randomUUID(),
        originalFilename: name,
        largeVideoQuotaBytes: 1500,
      });
      await svc.createCompanyFile(row("first.mp4", 1000));
      await expect(svc.createCompanyFile(row("second.mp4", 1000))).rejects.toMatchObject({ status: 413 });
      // Two at once cannot both fit the last free space.
      const results = await Promise.allSettled([svc.createCompanyFile(row("third.mp4", 400)), svc.createCompanyFile(row("fourth.mp4", 400))]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await companyStorageUsedBytes(db, companyId)).toBe(1400);
      // An ordinary file never counts against it.
      await svc.createCompanyFile({ ...row("small.png", 10), objectKey: `${companyId}/company-files/2026/10/28/small.png`, largeVideoQuotaBytes: null });
      expect(await db.select().from(issueAttachments)).toHaveLength(3);
    });
  });

  it("refuses a disallowed file type", async () => {
    const { companyId, runId } = await seed();
    await expect(
      services().files.createCompanyFile({ companyId, ...png(), contentType: "application/x-msdownload", runId }),
    ).rejects.toThrow("is not allowed");
  });

  it("reads a file only from its own company", async () => {
    const { companyId, otherCompanyId, runId } = await seed();
    const svc = services();
    const file = await svc.files.createCompanyFile({ companyId, ...png(), runId });

    expect((await svc.files.get({ fileId: file.id, companyId }))?.id).toBe(file.id);
    const content = await svc.files.readContent({ fileId: file.id, companyId });
    expect(Buffer.from(content.contentBase64, "base64").toString()).toBe("stored-picture-bytes");

    // Another company's file reads as missing and cannot be read.
    expect(await svc.files.get({ fileId: file.id, companyId: otherCompanyId })).toBeNull();
    await expect(svc.files.readContent({ fileId: file.id, companyId: otherCompanyId })).rejects.toThrow(
      "That file is not in this company's Files.",
    );
    expect(await svc.files.get({ fileId: "not-a-uuid", companyId })).toBeNull();

    // Pictures only: a company document cannot be read through this door.
    const doc = await svc.files.createCompanyFile({ companyId, ...png(), contentType: "application/pdf", runId });
    await expect(svc.files.readContent({ fileId: doc.id, companyId })).rejects.toThrow("that file is not a picture");
  });
});
