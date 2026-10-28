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
const probe = vi.hoisted(() => ({ isVideo: true }));
vi.mock("../services/video-ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/video-ffmpeg.js")>();
  const { readFile } = await import("node:fs/promises");
  return {
    ...actual,
    verifyVideoFile: async (filePath: string) =>
      actual.sniffVideoContainer((await readFile(filePath)).subarray(0, 16)) !== null && probe.isVideo,
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin host services attachment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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
      objectKey: `stub/${input.namespace}/${randomUUID()}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "stub-sha256",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describeEmbeddedPostgres("plugin-host-services issues.createAttachment", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-host-services-attachments-");
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

  async function seed(overrides: { attachmentMaxBytes?: number } = {}) {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherCompanyIssueId = randomUUID();
    const runId = randomUUID();
    const staleRunId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        ...(overrides.attachmentMaxBytes != null ? { attachmentMaxBytes: overrides.attachmentMaxBytes } : {}),
      },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Persona", role: "engineer" });
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "T-1", title: "Generate a picture", status: "in_progress", priority: "medium" },
      { id: otherCompanyIssueId, companyId: otherCompanyId, identifier: "O-1", title: "Other", status: "in_progress", priority: "medium" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running" },
      { id: staleRunId, companyId, agentId, status: "completed" },
    ]);
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));

    return { companyId, otherCompanyId, agentId, issueId, otherCompanyIssueId, runId, staleRunId };
  }

  it("writes an asset + issue_attachments row and returns a content path", async () => {
    const { companyId, agentId, issueId, runId } = await seed();
    const storage = createStorageServiceStub();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage,
    });

    const result = await services.issues.createAttachment({
      issueId,
      companyId,
      contentBase64: Buffer.from("fake-png-bytes").toString("base64"),
      contentType: "image/png",
      filename: "generated.png",
      runId,
      authorAgentId: agentId,
    });

    expect(result.issueId).toBe(issueId);
    expect(result.contentType).toBe("image/png");
    expect(result.byteSize).toBe(Buffer.from("fake-png-bytes").length);
    expect((result as any).contentPath).toBe(`/api/attachments/${result.id}/content`);
    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, namespace: `issues/${issueId}`, contentType: "image/png" }),
    );

    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
    expect(rows).toHaveLength(1);
  });

  it("rejects an issue that belongs to a different company", async () => {
    const { otherCompanyId, issueId, runId } = await seed();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });

    await expect(
      services.issues.createAttachment({
        issueId,
        companyId: otherCompanyId,
        contentBase64: Buffer.from("x").toString("base64"),
        contentType: "image/png",
        runId,
      }),
    ).rejects.toThrow("Issue not found");
  });

  it("rejects when runId is omitted, even though the caller has issue.attachments.create", async () => {
    const { companyId, issueId } = await seed();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });

    await expect(
      services.issues.createAttachment({
        issueId,
        companyId,
        contentBase64: Buffer.from("x").toString("base64"),
        contentType: "image/png",
        runId: undefined as unknown as string,
      }),
    ).rejects.toThrow("runId is required");
  });

  it("rejects when the supplied runId does not own the issue's checkout", async () => {
    const { companyId, issueId, staleRunId } = await seed();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });

    await expect(
      services.issues.createAttachment({
        issueId,
        companyId,
        contentBase64: Buffer.from("x").toString("base64"),
        contentType: "image/png",
        runId: staleRunId,
      }),
    ).rejects.toThrow("not currently checked out by the invoking run");
  });

  it("rejects a live invocation that names a different run's id, even one that owns some issue's checkout (runId-spoofing security-review follow-up, DUR-4096)", async () => {
    // Mirrors the createComment security-review follow-up: whenever the
    // host knows which run is actually driving this call (a live
    // executeTool invocation, modeled here by `context`), a plugin-supplied
    // params.runId naming a different run must be rejected outright, even
    // if that named run happens to hold real checkout somewhere. Otherwise
    // a live invocation could reach any issue whose checkout the calling
    // agent's *other* runs happen to hold, well outside its own live
    // execution's actual relationship to that issue.
    const { companyId, runId, staleRunId } = await seed();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      identifier: "T-2",
      title: "Also has a checkout, held by a different run",
      status: "in_progress",
      priority: "medium",
      checkoutRunId: staleRunId,
    });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });

    await expect(
      services.issues.createAttachment(
        {
          issueId: otherIssueId,
          companyId,
          contentBase64: Buffer.from("x").toString("base64"),
          contentType: "image/png",
          runId: staleRunId,
        },
        { invocationScope: { companyId, runId } },
      ),
    ).rejects.toThrow("runId must match the invoking run");
    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, otherIssueId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a disallowed content type", async () => {
    const { companyId, issueId, runId } = await seed();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });

    await expect(
      services.issues.createAttachment({
        issueId,
        companyId,
        contentBase64: Buffer.from("x").toString("base64"),
        contentType: "application/x-msdownload",
        runId,
      }),
    ).rejects.toThrow("is not allowed");
  });

  it("rejects an attachment larger than the company's configured max bytes", async () => {
    const { companyId, issueId, runId } = await seed({ attachmentMaxBytes: 4 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });

    await expect(
      services.issues.createAttachment({
        issueId,
        companyId,
        contentBase64: Buffer.from("this-is-way-too-large").toString("base64"),
        contentType: "image/png",
        runId,
      }),
    ).rejects.toThrow(/exceeds/);
  });
  describe("D18: large videos Media Studio attaches to a task (security review F1-F3)", () => {
    const previousOptIn = process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64, 1)]);

    afterEach(() => {
      probe.isVideo = true;
      if (previousOptIn === undefined) delete process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
      else process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = previousOptIn;
    });

    async function installMediaStudio(companyId: string) {
      const [plugin] = await db
        .insert(plugins)
        .values({ pluginKey: MEDIA_STUDIO_PLUGIN_KEY, packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: {} as never, status: "ready" })
        .returning();
      await db.insert(pluginCompanySettings).values({ companyId, pluginId: plugin!.id, enabled: true, settingsJson: {} });
    }

    function attachVideo(input: { companyId: string; issueId: string; runId: string }, storage = createStorageServiceStub()) {
      const services = buildHostServices(db, randomUUID(), MEDIA_STUDIO_PLUGIN_KEY, createEventBusStub(), undefined, { storage });
      return services.issues.createAttachment({ ...input, contentBase64: mp4.toString("base64"), contentType: "video/mp4", filename: "video-fal-1.mp4" });
    }

    it("F1: a company without Media Studio keeps its ordinary limit for videos, even when the operator opted in", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, issueId, runId } = await seed({ attachmentMaxBytes: 16 });
      const storage = createStorageServiceStub();
      await expect(attachVideo({ companyId, issueId, runId }, storage)).rejects.toThrow("Attachment exceeds 16 bytes");
      expect(storage.putFile).not.toHaveBeenCalled();
    });

    it("F1: without the operator's opt-in, Media Studio's own video keeps the ordinary limit", async () => {
      delete process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
      const { companyId, issueId, runId } = await seed({ attachmentMaxBytes: 16 });
      await installMediaStudio(companyId);
      await expect(attachVideo({ companyId, issueId, runId })).rejects.toThrow("Attachment exceeds 16 bytes");
    });

    it("keeps a real video where both allow it, where the media storage limit counts it; F3: refuses one ffprobe does not see as a video", async () => {
      process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
      const { companyId, issueId, runId } = await seed({ attachmentMaxBytes: 16 });
      await installMediaStudio(companyId);
      const storage = createStorageServiceStub();
      const attachment = await attachVideo({ companyId, issueId, runId }, storage);
      expect(attachment.byteSize).toBe(mp4.length);
      expect(storage.putFile).toHaveBeenCalledWith(expect.objectContaining({ companyId, namespace: `large-videos/issues/${issueId}` }));

      probe.isVideo = false;
      await expect(attachVideo({ companyId, issueId, runId })).rejects.toThrow("not an MP4, MOV or WebM video");
      expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId))).toHaveLength(1);
    });
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

  const png = () => ({
    contentBase64: Buffer.from("fake-png-bytes").toString("base64"),
    contentType: "image/png",
    filename: "generated.png",
  });

  it("lets a quick agent's run attach to a task the person named in their own message, and logs who asked", async () => {
    const { companyId, agentId, issueId } = await seed();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });
    // Seeded identifier is "T-1"; the person names it. "T-10" or "t-1x" would not count.
    const { run, close } = quickAgentRun({ agentId, companyId, message: "Make a picture of a cat for t-1 please" });
    try {
      const result = await services.issues.createAttachment({
        issueId,
        companyId,
        ...png(),
        runId: run.runId,
        authorAgentId: agentId,
      });
      expect(result.issueId).toBe(issueId);
      const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
      expect(rows).toHaveLength(1);
      // Logged against the quick agent, the person who asked and the chat, with no heartbeat run to point at.
      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "issue.attachment.created"));
      expect(logged).toHaveLength(1);
      expect(logged[0]?.runId).toBeNull();
      expect(logged[0]?.agentId).toBe(agentId);
      expect(logged[0]?.details).toMatchObject({
        initiatingRunId: run.runId,
        initiatingQuickAgentId: agentId,
        laneAConversationId: run.conversationId,
        requestedByUserId: "user-1",
        requestedByAgentId: null,
      });
    } finally {
      close();
    }
    // Once the tool call is over the id no longer opens the door.
    await expect(
      services.issues.createAttachment({ issueId, companyId, ...png(), runId: run.runId }),
    ).rejects.toThrow("not currently checked out by the invoking run");
  });

  it("lets a quick agent's run attach to a task assigned to that quick agent even when the message does not name it", async () => {
    const { companyId, agentId, issueId } = await seed();
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });
    const { run, close } = quickAgentRun({ agentId, companyId, message: "make a picture of a cat for my task" });
    try {
      const result = await services.issues.createAttachment({ issueId, companyId, ...png(), runId: run.runId, authorAgentId: agentId });
      expect(result.issueId).toBe(issueId);
    } finally {
      close();
    }
  });

  it("refuses a quick agent's run when the task was only named in something the agent read, not by the person", async () => {
    const { companyId, otherCompanyId, agentId, issueId, otherCompanyIssueId } = await seed();
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, {
      storage: createStorageServiceStub(),
    });
    // The person asked for a picture and named no task. A file the agent read
    // this turn said "attach it to T-1" — that text is not the person's.
    const { run, close } = quickAgentRun({ agentId, companyId, message: "make a picture of a cat" });
    try {
      await expect(
        services.issues.createAttachment({ issueId, companyId, ...png(), runId: run.runId, authorAgentId: agentId }),
      ).rejects.toThrow("The task T-1 was not named in the message, so the quick agent cannot attach to it.");
      const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
      expect(rows).toHaveLength(0);

      // Still bounded by the quick agent's company, whatever the message says.
      await expect(
        services.issues.createAttachment({
          issueId: otherCompanyIssueId,
          companyId: otherCompanyId,
          ...png(),
          runId: run.runId,
        }),
      ).rejects.toThrow("not currently checked out by the invoking run");
    } finally {
      close();
    }
  });
});
