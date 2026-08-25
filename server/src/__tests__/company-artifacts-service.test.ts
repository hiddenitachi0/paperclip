import { Readable } from "node:stream";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { companyArtifactsService } from "../services/company-artifacts.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company artifacts tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createStorageService(files: Record<string, Buffer> = {}): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(async (_companyId, objectKey, options) => {
      const body = files[objectKey] ?? Buffer.alloc(0);
      const range = options?.range;
      const ranged = range ? body.subarray(range.start, range.end + 1) : body;
      return {
        stream: Readable.from(ranged),
        contentType: "text/plain",
        contentLength: ranged.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describeEmbeddedPostgres("companyArtifactsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-artifacts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedArtifacts() {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const otherCompanyId = "22222222-2222-4222-8222-222222222222";
    const agentId = "33333333-3333-4333-8333-333333333333";
    const otherAgentId = "44444444-4444-4444-8444-444444444444";
    const projectId = "55555555-5555-4555-8555-555555555555";
    const issueId = "66666666-6666-4666-8666-666666666666";
    const secondIssueId = "77777777-7777-4777-8777-777777777777";
    const otherIssueId = "88888888-8888-4888-8888-888888888888";
    const runId = "99999999-9999-4999-8999-999999999999";
    const otherRunId = "19191919-1919-4191-8191-191919191919";
    const directAttachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workProductAttachmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: "PAP", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Coder", role: "engineer" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Artifacts", status: "in_progress" });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        projectId,
        identifier: "PAP-1",
        title: "Make the reel",
        status: "done",
        priority: "medium",
      },
      {
        id: secondIssueId,
        companyId,
        identifier: "PAP-2",
        title: "Write the plan",
        status: "done",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId: otherCompanyId,
        identifier: "OTH-1",
        title: "Other output",
        status: "done",
        priority: "medium",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        status: "completed",
      },
      {
        id: otherRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "completed",
      },
    ]);
    await db.insert(documents).values([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId,
        title: "Review Notes",
        latestBody: "# Review\n\nAgent-created review document with useful details.",
        createdByAgentId: agentId,
        updatedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        companyId,
        title: "Continuation Summary",
        latestBody: "System handoff",
        createdByAgentId: agentId,
        updatedAt: new Date("2026-01-05T00:00:00.000Z"),
      },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        companyId,
        title: "User Upload Notes",
        latestBody: "User-authored context",
        createdByUserId: "user-1",
        updatedAt: new Date("2026-01-06T00:00:00.000Z"),
      },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId: otherCompanyId,
        title: "Other Company Plan",
        latestBody: "Must not cross tenants",
        createdByAgentId: otherAgentId,
        updatedAt: new Date("2026-01-07T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: secondIssueId,
        documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        key: "review",
      },
      {
        companyId,
        issueId,
        documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      },
      {
        companyId,
        issueId,
        documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        key: "user-notes",
      },
      {
        companyId: otherCompanyId,
        issueId: otherIssueId,
        documentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        key: "plan",
      },
    ]);
    await db.insert(issueComments).values({
      id: "12121212-1212-4121-8121-121212121212",
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "comment with screenshot",
    });
    await db.insert(assets).values([
      {
        id: "13131313-1313-4131-8131-131313131313",
        companyId,
        provider: "local_disk",
        objectKey: "direct-video.mp4",
        contentType: "video/mp4",
        byteSize: 100,
        sha256: "sha256-direct-video",
        originalFilename: "direct-video.mp4",
        createdByAgentId: agentId,
      },
      {
        id: "14141414-1414-4141-8141-141414141414",
        companyId,
        provider: "local_disk",
        objectKey: "primary-cut.mp4",
        contentType: "video/mp4",
        byteSize: 200,
        sha256: "sha256-primary-cut",
        originalFilename: "primary-cut.mp4",
        createdByAgentId: agentId,
      },
      {
        id: "15151515-1515-4151-8151-151515151515",
        companyId,
        provider: "local_disk",
        objectKey: "operator-screenshot.png",
        contentType: "image/png",
        byteSize: 300,
        sha256: "sha256-user",
        originalFilename: "operator-screenshot.png",
        createdByUserId: "user-1",
      },
      {
        id: "16161616-1616-4161-8161-161616161616",
        companyId,
        provider: "local_disk",
        objectKey: "comment-screenshot.png",
        contentType: "image/png",
        byteSize: 400,
        sha256: "sha256-comment",
        originalFilename: "comment-screenshot.png",
        createdByAgentId: agentId,
      },
      {
        id: "17171717-1717-4171-8171-171717171717",
        companyId,
        provider: "local_disk",
        objectKey: "notes.txt",
        contentType: "text/plain",
        byteSize: 64,
        sha256: "sha256-notes",
        originalFilename: "notes.txt",
        createdByAgentId: agentId,
      },
    ]);
    await db.insert(issueAttachments).values([
      {
        id: directAttachmentId,
        companyId,
        issueId,
        assetId: "13131313-1313-4131-8131-131313131313",
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: workProductAttachmentId,
        companyId,
        issueId,
        assetId: "14141414-1414-4141-8141-141414141414",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "15151515-1515-4151-8151-151515151515",
        updatedAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "16161616-1616-4161-8161-161616161616",
        issueCommentId: "12121212-1212-4121-8121-121212121212",
        updatedAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "17171717-1717-4171-8171-171717171717",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueWorkProducts).values({
      id: "18181818-1818-4181-8181-181818181818",
      companyId,
      projectId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Primary Cut",
      status: "ready_for_review",
      summary: "Main render for review",
      isPrimary: true,
      metadata: {
        attachmentId: workProductAttachmentId,
        contentType: "video/mp4",
        byteSize: 200,
        contentPath: `/api/attachments/${workProductAttachmentId}/content`,
        openPath: `/api/attachments/${workProductAttachmentId}/content`,
        downloadPath: `/api/attachments/${workProductAttachmentId}/content?download=1`,
        originalFilename: "primary-cut.mp4",
      },
      createdByRunId: runId,
      updatedAt: new Date("2026-01-02T12:00:00.000Z"),
    });

    return { companyId, otherCompanyId, projectId, issueId, secondIssueId, otherIssueId, otherRunId };
  }

  it("projects agent-created documents, direct attachments, and work products while excluding noisy sources", async () => {
    const { companyId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Text file preview from an agent output.") });
    const result = await companyArtifactsService(db, storage).list(companyId, { limit: 20 });

    expect(result.nextCursor).toBeNull();
    expect(result.artifacts.map((artifact) => artifact.title)).toEqual([
      "comment-screenshot.png",
      "operator-screenshot.png",
      "Review Notes",
      "direct-video.mp4",
      "Primary Cut",
      "notes.txt",
    ]);
    expect(result.artifacts.map((artifact) => artifact.source)).toEqual([
      "attachment",
      "attachment",
      "document",
      "attachment",
      "work_product",
      "attachment",
    ]);
    expect(result.artifacts.find((artifact) => artifact.title === "notes.txt")?.previewText)
      .toBe("Text file preview from an agent output.");
    expect(result.artifacts.some((artifact) => artifact.title === "primary-cut.mp4")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "Continuation Summary")).toBe(false);

    // A file an agent posts inside a task comment is now included, still
    // attributed to that agent.
    const commentUpload = result.artifacts.find((artifact) => artifact.title === "comment-screenshot.png");
    expect(commentUpload?.createdByAgent).toEqual({ id: expect.any(String), name: "Coder" });
    expect(commentUpload?.createdByUser).toBeFalsy();

    // A file a human operator uploads directly is now included, labeled
    // distinctly from an agent maker.
    const humanUpload = result.artifacts.find((artifact) => artifact.title === "operator-screenshot.png");
    expect(humanUpload?.createdByAgent).toBeNull();
    expect(humanUpload?.createdByUser).toBe(true);

    expect(result.artifacts.some((artifact) => artifact.issue.identifier === "OTH-1")).toBe(false);
  });

  it("supports project, kind, search, and cursor filters", async () => {
    const { companyId, projectId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Searchable notes preview") });

    const projectVideos = await companyArtifactsService(db, storage).list(companyId, {
      projectId,
      kind: "video",
      limit: 10,
    });
    expect(projectVideos.artifacts.map((artifact) => artifact.title)).toEqual(["direct-video.mp4", "Primary Cut"]);

    const search = await companyArtifactsService(db, storage).list(companyId, {
      q: "review document",
      limit: 10,
    });
    expect(search.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes"]);

    const firstPage = await companyArtifactsService(db, storage).list(companyId, { limit: 2 });
    expect(firstPage.artifacts.map((artifact) => artifact.title)).toEqual([
      "comment-screenshot.png",
      "operator-screenshot.png",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await companyArtifactsService(db, storage).list(companyId, {
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.artifacts.map((artifact) => artifact.title)).toEqual([
      "Review Notes",
      "direct-video.mp4",
      "Primary Cut",
      "notes.txt",
    ]);

    const pageAfterPrimaryWorkProduct = await companyArtifactsService(db, storage).list(companyId, { limit: 3 });
    expect(pageAfterPrimaryWorkProduct.artifacts.map((artifact) => artifact.title)).toEqual([
      "comment-screenshot.png",
      "operator-screenshot.png",
      "Review Notes",
    ]);

    const afterPrimaryCursor = await companyArtifactsService(db, storage).list(companyId, {
      limit: 10,
      cursor: pageAfterPrimaryWorkProduct.nextCursor ?? undefined,
    });
    expect(afterPrimaryCursor.artifacts.map((artifact) => artifact.title)).toEqual([
      "direct-video.mp4",
      "Primary Cut",
      "notes.txt",
    ]);
  });

  it("deduplicates work product attachments beyond the work product fetch window", async () => {
    const { companyId, projectId, issueId } = await seedArtifacts();
    const dedupedAttachmentId = "abababab-abab-4bab-8bab-abababababab";

    await db.insert(assets).values({
      id: "acacacac-acac-4cac-8cac-acacacacacac",
      companyId,
      provider: "local_disk",
      objectKey: "late-render.mp4",
      contentType: "video/mp4",
      byteSize: 500,
      sha256: "sha256-late-render",
      originalFilename: "late-render.mp4",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: dedupedAttachmentId,
      companyId,
      issueId,
      assetId: "acacacac-acac-4cac-8cac-acacacacacac",
      updatedAt: new Date("2026-01-20T00:00:00.000Z"),
    });

    const fillerWorkProducts = Array.from({ length: 21 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      companyId,
      projectId,
      issueId,
      type: "artifact" as const,
      provider: "paperclip",
      title: `Filler Video ${index + 1}`,
      status: "ready_for_review" as const,
      summary: "Filler artifact to push the attachment-backed work product past the fetch window",
      metadata: { contentType: "video/mp4" },
      createdByRunId: "99999999-9999-4999-8999-999999999999",
      updatedAt: new Date(`2026-01-10T00:${String(index).padStart(2, "0")}:00.000Z`),
    }));
    await db.insert(issueWorkProducts).values([
      ...fillerWorkProducts,
      {
        id: "adadadad-adad-4dad-8dad-adadadadadad",
        companyId,
        projectId,
        issueId,
        type: "artifact",
        provider: "paperclip",
        title: "Late Render",
        status: "ready_for_review",
        summary: "Attachment-backed work product outside the limited fetch window",
        metadata: {
          attachmentId: dedupedAttachmentId,
          contentType: "video/mp4",
          byteSize: 500,
          contentPath: `/api/attachments/${dedupedAttachmentId}/content`,
          openPath: `/api/attachments/${dedupedAttachmentId}/content`,
          downloadPath: `/api/attachments/${dedupedAttachmentId}/content?download=1`,
          originalFilename: "late-render.mp4",
        },
        createdByRunId: "99999999-9999-4999-8999-999999999999",
        updatedAt: new Date("2026-01-01T12:00:00.000Z"),
      },
    ]);

    const result = await companyArtifactsService(db, createStorageService()).list(companyId, {
      kind: "video",
      limit: 20,
    });

    expect(result.artifacts.some((artifact) => artifact.title === "late-render.mp4")).toBe(false);
  });

  it("does not project a foreign agent from a malformed work product run reference", async () => {
    const { companyId, issueId, otherRunId } = await seedArtifacts();

    await db.insert(issueWorkProducts).values({
      id: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Forged Run Artifact",
      status: "ready_for_review",
      summary: "Historically malformed run attribution",
      metadata: { contentType: "text/plain" },
      createdByRunId: otherRunId,
      updatedAt: new Date("2026-01-10T00:00:00.000Z"),
    });

    const result = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });
    const forged = result.artifacts.find((artifact) => artifact.title === "Forged Run Artifact");

    expect(forged).toBeTruthy();
    expect(forged?.createdByAgent).toBeNull();
    expect(result.artifacts.some((artifact) => artifact.createdByAgent?.name === "Other")).toBe(false);
  });

  it("does not leak foreign issue or project metadata through malformed artifact link rows", async () => {
    const { companyId, otherCompanyId, otherIssueId } = await seedArtifacts();
    const foreignProjectId = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
    const malformedAttachmentId = "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c";

    await db.insert(projects).values({
      id: foreignProjectId,
      companyId: otherCompanyId,
      name: "Foreign Project",
      status: "in_progress",
    });
    await db.update(issues).set({ projectId: foreignProjectId }).where(eq(issues.id, otherIssueId));
    await db.insert(documents).values({
      id: "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d",
      companyId,
      title: "Forged Link Document",
      latestBody: "This row is company-owned but points at a foreign issue.",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      updatedAt: new Date("2026-01-30T00:00:00.000Z"),
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: otherIssueId,
      documentId: "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d",
      key: "forged-link-document",
    });
    await db.insert(assets).values({
      id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e",
      companyId,
      provider: "local_disk",
      objectKey: "forged-link.txt",
      contentType: "text/plain",
      byteSize: 42,
      sha256: "sha256-forged-link",
      originalFilename: "forged-link.txt",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: malformedAttachmentId,
      companyId,
      issueId: otherIssueId,
      assetId: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e",
      updatedAt: new Date("2026-01-29T00:00:00.000Z"),
    });
    await db.insert(issueWorkProducts).values({
      id: "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f",
      companyId,
      issueId: otherIssueId,
      type: "artifact",
      provider: "paperclip",
      title: "Forged Link Work Product",
      status: "ready_for_review",
      summary: "This row is company-owned but points at a foreign issue.",
      metadata: { contentType: "text/plain" },
      createdByRunId: "99999999-9999-4999-8999-999999999999",
      updatedAt: new Date("2026-01-28T00:00:00.000Z"),
    });

    const flat = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });
    expect(flat.artifacts.map((artifact) => artifact.title)).not.toEqual(expect.arrayContaining([
      "Forged Link Document",
      "forged-link.txt",
      "Forged Link Work Product",
    ]));
    expect(flat.artifacts.some((artifact) => artifact.issue.identifier === "OTH-1")).toBe(false);
    expect(flat.artifacts.some((artifact) => artifact.issue.title === "Other output")).toBe(false);
    expect(flat.artifacts.some((artifact) => artifact.project?.name === "Foreign Project")).toBe(false);

    const grouped = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      limit: 20,
    });
    expect(grouped.groups?.some((group) => group.issue.identifier === "OTH-1")).toBe(false);
    expect(grouped.groups?.some((group) => group.issue.title === "Other output")).toBe(false);
    expect(grouped.groups?.some((group) =>
      group.previewArtifacts.some((artifact) => artifact.project?.name === "Foreign Project")
    )).toBe(false);

    const selectedForeignGroup = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: otherIssueId,
      limit: 20,
    });
    expect(selectedForeignGroup).toEqual({
      artifacts: [],
      selectedGroup: null,
      nextCursor: null,
    });
  });

  it("groups artifacts by task after applying media, project, and search filters", async () => {
    const { companyId, projectId, issueId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Searchable notes preview") });

    const grouped = await companyArtifactsService(db, storage).list(companyId, {
      groupBy: "task",
      limit: 10,
    });
    expect(grouped.artifacts).toEqual([]);
    expect(grouped.nextCursor).toBeNull();
    expect(grouped.groups?.map((group) => ({
      issue: group.issue.identifier,
      count: group.count,
      mediaKinds: group.mediaKinds,
      href: group.href,
    }))).toEqual([
      {
        issue: "PAP-2",
        count: 1,
        mediaKinds: ["text"],
        href: "/PAP/artifacts?groupBy=task&groupIssueId=77777777-7777-4777-8777-777777777777",
      },
      {
        issue: "PAP-1",
        count: 5,
        mediaKinds: ["image", "video", "text"],
        href: "/PAP/artifacts?groupBy=task&groupIssueId=66666666-6666-4666-8666-666666666666",
      },
    ]);
    expect(grouped.groups?.find((group) => group.issue.id === issueId)?.previewArtifacts.map((artifact) => artifact.title))
      .toEqual(["comment-screenshot.png", "operator-screenshot.png", "direct-video.mp4"]);

    const projectVideos = await companyArtifactsService(db, storage).list(companyId, {
      groupBy: "task",
      projectId,
      kind: "video",
      limit: 10,
    });
    expect(projectVideos.groups?.map((group) => ({
      issue: group.issue.identifier,
      count: group.count,
      href: group.href,
    }))).toEqual([
      {
        issue: "PAP-1",
        count: 2,
        href:
          "/PAP/artifacts?groupBy=task&groupIssueId=66666666-6666-4666-8666-666666666666&kind=video&projectId=55555555-5555-4555-8555-555555555555",
      },
    ]);

    const search = await companyArtifactsService(db, storage).list(companyId, {
      groupBy: "task",
      q: "review document",
      limit: 10,
    });
    expect(search.groups?.map((group) => ({ issue: group.issue.identifier, count: group.count }))).toEqual([
      { issue: "PAP-2", count: 1 },
    ]);
  });

  it("paginates grouped task lists with the active group cursor", async () => {
    const { companyId } = await seedArtifacts();

    const firstPage = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      limit: 1,
    });
    expect(firstPage.groups?.map((group) => group.issue.identifier)).toEqual(["PAP-2"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.groups?.map((group) => group.issue.identifier)).toEqual(["PAP-1"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("groups parent-task artifacts under the topmost same-company ancestor", async () => {
    const { companyId, issueId, secondIssueId } = await seedArtifacts();
    const grandchildIssueId = "21212121-2121-4212-8121-212121212121";
    const grandchildAttachmentId = "23232323-2323-4232-8232-232323232323";

    await db.update(issues).set({ parentId: issueId }).where(eq(issues.id, secondIssueId));
    await db.insert(issues).values({
      id: grandchildIssueId,
      companyId,
      parentId: secondIssueId,
      identifier: "PAP-3",
      title: "Grandchild render",
      status: "done",
      priority: "medium",
    });
    await db.insert(assets).values({
      id: "24242424-2424-4242-8242-242424242424",
      companyId,
      provider: "local_disk",
      objectKey: "grandchild.txt",
      contentType: "text/plain",
      byteSize: 48,
      sha256: "sha256-grandchild",
      originalFilename: "grandchild.txt",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: grandchildAttachmentId,
      companyId,
      issueId: grandchildIssueId,
      assetId: "24242424-2424-4242-8242-242424242424",
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    });

    const grouped = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "parent_task",
      limit: 10,
    });

    expect(grouped.artifacts).toEqual([]);
    expect(grouped.groups?.map((group) => ({
      issue: group.issue.identifier,
      count: group.count,
      previewTitles: group.previewArtifacts.map((artifact) => artifact.title),
    }))).toEqual([
      {
        issue: "PAP-1",
        count: 7,
        previewTitles: ["comment-screenshot.png", "operator-screenshot.png", "grandchild.txt"],
      },
    ]);
  });

  it("returns selected group artifact pages and metadata without leaking foreign group issues", async () => {
    const { companyId, issueId, otherIssueId } = await seedArtifacts();

    const selected = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: issueId,
      limit: 2,
    });
    expect(selected.groups).toBeUndefined();
    expect(selected.selectedGroup).toMatchObject({
      id: `task:${issueId}`,
      groupBy: "task",
      issue: { identifier: "PAP-1" },
      count: 5,
    });
    expect(selected.artifacts.map((artifact) => artifact.title)).toEqual([
      "comment-screenshot.png",
      "operator-screenshot.png",
    ]);
    expect(selected.nextCursor).toEqual(expect.any(String));

    const selectedSecondPage = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: issueId,
      limit: 10,
      cursor: selected.nextCursor ?? undefined,
    });
    expect(selectedSecondPage.artifacts.map((artifact) => artifact.title)).toEqual([
      "direct-video.mp4",
      "Primary Cut",
      "notes.txt",
    ]);

    const selectedEmptyByFilter = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: issueId,
      q: "does-not-match-this-stack",
      limit: 10,
    });
    expect(selectedEmptyByFilter.selectedGroup).toMatchObject({
      id: `task:${issueId}`,
      count: 0,
    });
    expect(selectedEmptyByFilter.artifacts).toEqual([]);

    const foreignSelected = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "task",
      groupIssueId: otherIssueId,
      limit: 10,
    });
    expect(foreignSelected).toEqual({
      artifacts: [],
      selectedGroup: null,
      nextCursor: null,
    });
  });

  it("classifies real PDF/Word attachments as mediaKind document, keeps issue documents as text, and filters by kind=document", async () => {
    const { companyId, issueId } = await seedArtifacts();
    await db.insert(assets).values([
      {
        id: "31313131-3131-4131-8131-313131313131",
        companyId,
        provider: "local_disk",
        objectKey: "report.pdf",
        contentType: "application/pdf",
        byteSize: 555,
        sha256: "sha256-report-pdf",
        originalFilename: "report.pdf",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
      },
      {
        id: "32323232-3232-4232-8232-323232323232",
        companyId,
        provider: "local_disk",
        objectKey: "memo.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 666,
        sha256: "sha256-memo-docx",
        originalFilename: "memo.docx",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
      },
    ]);
    await db.insert(issueAttachments).values([
      {
        companyId,
        issueId,
        assetId: "31313131-3131-4131-8131-313131313131",
        updatedAt: new Date("2026-01-11T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "32323232-3232-4232-8232-323232323232",
        updatedAt: new Date("2026-01-12T00:00:00.000Z"),
      },
    ]);

    const flat = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });
    expect(flat.artifacts.find((artifact) => artifact.title === "report.pdf")?.mediaKind).toBe("document");
    expect(flat.artifacts.find((artifact) => artifact.title === "memo.docx")?.mediaKind).toBe("document");
    expect(flat.artifacts.find((artifact) => artifact.title === "Review Notes")?.mediaKind).toBe("text");

    const documentsOnly = await companyArtifactsService(db, createStorageService()).list(companyId, {
      kind: "document",
      limit: 20,
    });
    expect(documentsOnly.artifacts.map((artifact) => artifact.title).sort()).toEqual(["memo.docx", "report.pdf"]);
    expect(documentsOnly.artifacts.some((artifact) => artifact.title === "Review Notes")).toBe(false);
    expect(documentsOnly.artifacts.some((artifact) => artifact.title === "direct-video.mp4")).toBe(false);
  });

  it("filters documents by agentId using OR semantics across creator and updater", async () => {
    const { companyId, secondIssueId } = await seedArtifacts();
    const secondAgentId = "41414141-4141-4141-8141-414141414141";
    await db.insert(agents).values({ id: secondAgentId, companyId, name: "Editor", role: "engineer" });
    await db.insert(documents).values({
      id: "42424242-4242-4242-8242-424242424242",
      companyId,
      title: "Co-authored Plan",
      latestBody: "Created by one agent, revised by another.",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      updatedByAgentId: secondAgentId,
      updatedAt: new Date("2026-01-15T00:00:00.000Z"),
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: secondIssueId,
      documentId: "42424242-4242-4242-8242-424242424242",
      key: "co-authored-plan",
    });

    const byCreator = await companyArtifactsService(db, createStorageService()).list(companyId, {
      agentId: "33333333-3333-4333-8333-333333333333",
      limit: 20,
    });
    expect(byCreator.artifacts.some((artifact) => artifact.title === "Co-authored Plan")).toBe(true);

    const byUpdater = await companyArtifactsService(db, createStorageService()).list(companyId, {
      agentId: secondAgentId,
      limit: 20,
    });
    expect(byUpdater.artifacts.some((artifact) => artifact.title === "Co-authored Plan")).toBe(true);
    expect(byUpdater.artifacts.some((artifact) => artifact.title === "Review Notes")).toBe(false);
  });

  it("rejects a cross-company agentId with notFound before reading any artifact rows", async () => {
    const { companyId } = await seedArtifacts();
    const otherAgentId = "44444444-4444-4444-8444-444444444444";

    await expect(
      companyArtifactsService(db, createStorageService()).list(companyId, { agentId: otherAgentId, limit: 20 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("filters items with no maker agent via noAgent, without matching agent-authored artifacts", async () => {
    const { companyId, issueId, otherRunId } = await seedArtifacts();

    await db.insert(issueWorkProducts).values({
      id: "51515151-5151-4151-8151-515151515151",
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Ownerless Artifact",
      status: "ready_for_review",
      summary: "No resolvable maker agent",
      metadata: { contentType: "text/plain" },
      createdByRunId: otherRunId,
      updatedAt: new Date("2026-01-16T00:00:00.000Z"),
    });

    const noAgentResult = await companyArtifactsService(db, createStorageService()).list(companyId, {
      noAgent: true,
      limit: 20,
    });
    expect(noAgentResult.artifacts.map((artifact) => artifact.title)).toEqual(["Ownerless Artifact"]);

    const agentResult = await companyArtifactsService(db, createStorageService()).list(companyId, {
      agentId: "33333333-3333-4333-8333-333333333333",
      limit: 20,
    });
    expect(agentResult.artifacts.some((artifact) => artifact.title === "Ownerless Artifact")).toBe(false);
  });

  it("groups artifacts by agent, including the no-agent bucket", async () => {
    const { companyId, issueId, otherRunId } = await seedArtifacts();

    await db.insert(issueWorkProducts).values({
      id: "52525252-5252-4252-8252-525252525252",
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Ownerless Artifact",
      status: "ready_for_review",
      summary: "No resolvable maker agent",
      metadata: { contentType: "text/plain" },
      createdByRunId: otherRunId,
      updatedAt: new Date("2026-01-16T00:00:00.000Z"),
    });

    const grouped = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      limit: 20,
    });
    expect(grouped.artifacts).toEqual([]);
    const coderGroup = grouped.groups?.find((group) => group.id === "agent:33333333-3333-4333-8333-333333333333");
    expect(coderGroup).toMatchObject({
      groupBy: "agent",
      agent: { id: "33333333-3333-4333-8333-333333333333", name: "Coder" },
      issue: null,
    });
    expect(coderGroup?.count).toBeGreaterThan(0);
    const noneGroup = grouped.groups?.find((group) => group.id === "agent:none");
    expect(noneGroup).toMatchObject({ groupBy: "agent", agent: null, count: 1 });

    const selectedNone = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      noAgent: true,
      limit: 20,
    });
    expect(selectedNone.selectedGroup).toMatchObject({ id: "agent:none", agent: null, count: 1 });
    expect(selectedNone.artifacts.map((artifact) => artifact.title)).toEqual(["Ownerless Artifact"]);

    const selectedCoder = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      groupAgentId: "33333333-3333-4333-8333-333333333333",
      limit: 20,
    });
    expect(selectedCoder.selectedGroup).toMatchObject({
      id: "agent:33333333-3333-4333-8333-333333333333",
      agent: { name: "Coder" },
    });
    expect(selectedCoder.artifacts.length).toBeGreaterThan(0);

    const foreignAgent = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      groupAgentId: "44444444-4444-4444-8444-444444444444",
      limit: 20,
    });
    expect(foreignAgent).toEqual({ artifacts: [], selectedGroup: null, nextCursor: null });
  });

  it("gives human uploads their own 'Uploaded by you' bucket, distinct from the no-idea-who-made-this bucket", async () => {
    const { companyId } = await seedArtifacts();

    const grouped = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      limit: 20,
    });
    const humanGroup = grouped.groups?.find((group) => group.id === "agent:human");
    expect(humanGroup).toMatchObject({
      groupBy: "agent",
      agent: null,
      isUserUploadGroup: true,
      title: "Uploaded by you",
      count: 1,
    });
    expect(humanGroup?.previewArtifacts.map((artifact) => artifact.title)).toEqual(["operator-screenshot.png"]);
    const noneGroup = grouped.groups?.find((group) => group.id === "agent:none");
    expect(noneGroup).toBeUndefined();

    const selectedHuman = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      uploadedByUser: true,
      limit: 20,
    });
    expect(selectedHuman.selectedGroup).toMatchObject({ id: "agent:human", agent: null, isUserUploadGroup: true });
    expect(selectedHuman.artifacts.map((artifact) => artifact.title)).toEqual(["operator-screenshot.png"]);

    const selectedNoAgent = await companyArtifactsService(db, createStorageService()).list(companyId, {
      groupBy: "agent",
      noAgent: true,
      limit: 20,
    });
    expect(selectedNoAgent.artifacts.some((artifact) => artifact.title === "operator-screenshot.png")).toBe(false);
  });

  it("only matches filenames (not the parent task's identifier/title) when qScope=filename", async () => {
    const { companyId } = await seedArtifacts();
    const storage = createStorageService();

    // "Write the plan" is secondIssueId's title (PAP-2), which only has a
    // document attached (no attachments/work products) — so it isolates the
    // document predicate's qScope behavior without also hitting the
    // always-on issue-title clause in the (out-of-scope-for-qScope) work
    // product predicate.
    const allScope = await companyArtifactsService(db, storage).list(companyId, {
      q: "Write the plan",
      limit: 20,
    });
    expect(allScope.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes"]);

    const filenameScope = await companyArtifactsService(db, storage).list(companyId, {
      q: "Write the plan",
      qScope: "filename",
      limit: 20,
    });
    expect(filenameScope.artifacts).toEqual([]);

    const filenameMatch = await companyArtifactsService(db, storage).list(companyId, {
      q: "direct-video",
      qScope: "filename",
      limit: 20,
    });
    expect(filenameMatch.artifacts.map((artifact) => artifact.title)).toEqual(["direct-video.mp4"]);
  });

  it("populates byteSize/originalFilename for attachments and work products, but leaves them null for documents", async () => {
    const { companyId } = await seedArtifacts();
    const result = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });

    const attachment = result.artifacts.find((artifact) => artifact.title === "direct-video.mp4");
    expect(attachment).toMatchObject({ byteSize: 100, originalFilename: "direct-video.mp4" });

    const workProduct = result.artifacts.find((artifact) => artifact.title === "Primary Cut");
    expect(workProduct).toMatchObject({ byteSize: 200, originalFilename: "primary-cut.mp4" });

    const document = result.artifacts.find((artifact) => artifact.title === "Review Notes");
    expect(document).toMatchObject({ byteSize: null, originalFilename: null });
  });

  it("lists agents who made at least one file, most-recently-active first", async () => {
    const { companyId, issueId, otherRunId } = await seedArtifacts();

    const secondAgentId = "61616161-6161-4161-8161-616161616161";
    await db.insert(agents).values({ id: secondAgentId, companyId, name: "Newcomer", role: "engineer" });
    await db.insert(assets).values({
      id: "62626262-6262-4262-8262-626262626262",
      companyId,
      provider: "local_disk",
      objectKey: "newcomer-file.txt",
      contentType: "text/plain",
      byteSize: 10,
      sha256: "sha256-newcomer-file",
      originalFilename: "newcomer-file.txt",
      createdByAgentId: secondAgentId,
    });
    await db.insert(issueAttachments).values({
      companyId,
      issueId,
      assetId: "62626262-6262-4262-8262-626262626262",
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    // Agent-less work product should not show up as a "maker" in the roster.
    await db.insert(issueWorkProducts).values({
      id: "63636363-6363-4363-8363-636363636363",
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Ownerless Roster Artifact",
      status: "ready_for_review",
      summary: "No resolvable maker agent",
      metadata: { contentType: "text/plain" },
      createdByRunId: otherRunId,
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    });

    const agentsList = await companyArtifactsService(db, createStorageService()).listAgents(companyId);
    expect(agentsList.map((agent) => agent.name)).toEqual(["Newcomer", "Coder"]);
    expect(agentsList.every((agent) => agent.id !== "44444444-4444-4444-8444-444444444444")).toBe(true);
  });

  it("counts an agent as a maker even when their only file was posted inside a comment", async () => {
    const { companyId, issueId } = await seedArtifacts();

    const commentOnlyAgentId = "64646464-6464-4646-8646-646464646464";
    await db.insert(agents).values({ id: commentOnlyAgentId, companyId, name: "Commenter", role: "engineer" });
    await db.insert(issueComments).values({
      id: "65656565-6565-4656-8656-656565656565",
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: commentOnlyAgentId,
      body: "comment-only upload",
    });
    await db.insert(assets).values({
      id: "66666666-6666-4666-8666-666666666667",
      companyId,
      provider: "local_disk",
      objectKey: "comment-only.png",
      contentType: "image/png",
      byteSize: 50,
      sha256: "sha256-comment-only",
      originalFilename: "comment-only.png",
      createdByAgentId: commentOnlyAgentId,
    });
    await db.insert(issueAttachments).values({
      companyId,
      issueId,
      assetId: "66666666-6666-4666-8666-666666666667",
      issueCommentId: "65656565-6565-4656-8656-656565656565",
      updatedAt: new Date("2026-01-31T00:00:00.000Z"),
    });

    const agentsList = await companyArtifactsService(db, createStorageService()).listAgents(companyId);
    expect(agentsList.some((agent) => agent.name === "Commenter")).toBe(true);
  });

  it("serves GET /:companyId/artifacts/agents with the agent roster", async () => {
    const { companyId } = await seedArtifacts();
    const app = express();
    app.use((_req, _res, next) => {
      (_req as any).actor = { type: "board", source: "local_implicit", userId: "user-1" };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService()));
    app.use(errorHandler);

    const res = await request(app).get(`/api/companies/${companyId}/artifacts/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "33333333-3333-4333-8333-333333333333", name: "Coder" }]);
  });
});

describe("company artifacts route authorization", () => {
  it("rejects agent access across company boundaries before reading artifacts", async () => {
    const app = express();
    app.use((_req, _res, next) => {
      (_req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-allowed",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any, createStorageService()));
    app.use(errorHandler);

    const res = await request(app).get("/api/companies/company-denied/artifacts");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });

  it("rejects agent access across company boundaries before listing artifact-making agents", async () => {
    const app = express();
    app.use((_req, _res, next) => {
      (_req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-allowed",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any, createStorageService()));
    app.use(errorHandler);

    const res = await request(app).get("/api/companies/company-denied/artifacts/agents");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });
});
