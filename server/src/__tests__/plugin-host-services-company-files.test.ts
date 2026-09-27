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
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { openLaneAPluginRun } from "../services/lane-a-plugin-runs.js";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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
      objectKey: `stub/${input.namespace}/${randomUUID()}`,
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

  function services(storage: StorageService = createStorageServiceStub()) {
    return buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub(), undefined, { storage });
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
