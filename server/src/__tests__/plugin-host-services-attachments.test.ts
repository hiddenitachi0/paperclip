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
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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
});
