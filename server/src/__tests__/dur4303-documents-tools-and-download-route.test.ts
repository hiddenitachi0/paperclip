import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  dataConnections,
  instanceSettings,
  plugins,
} from "@paperclipai/db";
import { DOCUMENTS_PLUGIN_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { dataConnectionService } from "../services/data-connections.js";
import { documentsDataService, type DocumentsCaller } from "../services/documents-data.js";
import { documentsSettingsService } from "../services/documents-settings.js";
import { documentsDownloadRoutes } from "../routes/documents-download.js";
import { verifyDocumentDownloadToken } from "../services/documents-download-token.js";

/**
 * DUR-4303 acceptance tests: search_documents/get_document's query service
 * (documents-data.ts) and the proxied download route, against a real
 * Postgres with every migration applied and a fake paperless-ngx server
 * reached only through the same deps.fetchImpl seam paperless-source.ts
 * already uses.
 *
 * The single property Security Reviewer 2 sign-off is required on: the
 * proxied download path always resolves the container from the REQUESTING
 * company's own `data_connections` row, never a cached or cross-request
 * value. Proven here two ways: two companies whose documents share the same
 * id (1) never cross (each company's token can only ever reach that
 * company's own fake backend/bytes), and a token survives only as long as
 * the company it names keeps documents switched on -- the route re-checks
 * that on every request, not just at mint time.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4303 documents tests: ${support.reason ?? "unsupported environment"}`);
}

const HOST_A = "paperless-a.internal";
const HOST_B = "paperless-b.internal";
const PORT_A = 8001;
const PORT_B = 8002;

interface FakeDoc {
  id: number;
  title: string;
  correspondent: number | null;
  tags: number[];
  created: string;
  content: string;
  bytes: string;
}

function fakeBackend(label: string, doc: FakeDoc, names: { correspondents: Record<number, string>; tags: Record<number, string> }) {
  const calls: string[] = [];
  const handle = (url: string): Response => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/api/documents/" && u.searchParams.has("query")) {
      return new Response(
        JSON.stringify({ count: 1, results: [{ id: doc.id, title: doc.title, correspondent: doc.correspondent, tags: doc.tags, created: doc.created, content: doc.content }] }),
        { status: 200 },
      );
    }
    if (u.pathname === `/api/documents/${doc.id}/`) {
      return new Response(JSON.stringify({ id: doc.id, title: doc.title, correspondent: doc.correspondent, tags: doc.tags, created: doc.created, original_file_name: `${doc.title}.pdf` }), { status: 200 });
    }
    if (u.pathname === `/api/documents/${doc.id}/download/`) {
      return new Response(new TextEncoder().encode(doc.bytes), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (u.pathname.startsWith("/api/documents/") && u.pathname.endsWith("/download/")) {
      return new Response("", { status: 404 });
    }
    if (u.pathname.startsWith("/api/documents/")) {
      return new Response("", { status: 404 });
    }
    if (u.pathname === "/api/correspondents/") {
      const ids = (u.searchParams.get("id__in") ?? "").split(",").filter(Boolean).map(Number);
      return new Response(JSON.stringify({ results: ids.filter((id) => names.correspondents[id]).map((id) => ({ id, name: names.correspondents[id] })) }), { status: 200 });
    }
    if (u.pathname === "/api/tags/") {
      const ids = (u.searchParams.get("id__in") ?? "").split(",").filter(Boolean).map(Number);
      return new Response(JSON.stringify({ results: ids.filter((id) => names.tags[id]).map((id) => ({ id, name: names.tags[id] })) }), { status: 200 });
    }
    throw new Error(`${label}: unexpected url ${url}`);
  };
  return { calls, handle };
}

const docA: FakeDoc = { id: 1, title: "Leiekontrakt A", correspondent: 1, tags: [1], created: "2026-01-05T10:00:00Z", content: "a rental agreement for company A", bytes: "PDF-BYTES-A" };
const docB: FakeDoc = { id: 1, title: "Faktura B", correspondent: 2, tags: [2], created: "2026-02-10T10:00:00Z", content: "an invoice for company B", bytes: "PDF-BYTES-B" };

d("DUR-4303 documents tools and download route", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur4303-${randomUUID()}`);

  const backendA = fakeBackend("A", docA, { correspondents: { 1: "Statens vegvesen" }, tags: { 1: "contract" } });
  const backendB = fakeBackend("B", docB, { correspondents: { 2: "Elvia" }, tags: { 2: "invoice" } });

  const routedFetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    const host = new URL(url).hostname;
    if (host === HOST_A) return backendA.handle(url);
    if (host === HOST_B) return backendB.handle(url);
    throw new Error(`unexpected host ${host}`);
  }) as typeof fetch;

  const deps = () => ({ fetchImpl: routedFetch });

  let companyIdA!: string;
  let companyIdB!: string;
  let connIdA!: string;
  let connIdB!: string;

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "dur4303-test-signing-secret";
    const started = await startEmbeddedPostgresTestDatabase("dur4303-documents");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);

    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableBusinessData: true } });
    await db.insert(plugins).values({ pluginKey: DOCUMENTS_PLUGIN_KEY, packageName: "paperclip-documents", version: "1.0.0", manifestJson: {} as never, status: "installed" });

    async function seedCompany(name: string) {
      const id = randomUUID();
      await db.insert(companies).values({ id, name, issuePrefix: `D${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
      return id;
    }
    async function connectPaperless(companyId: string, host: string, port: number, token: string) {
      const svc = dataConnectionService(db, deps());
      const created = await svc.create(companyId, { kind: "paperless_ngx", name: "Documents", host, port, credential: { kind: "paperless_api_token", apiToken: token } }, { userId: "board-user" });
      await db.update(dataConnections).set({ status: "active" }).where(eq(dataConnections.id, created.id));
      await svc.setDatasetSource(companyId, "documents", created.id, { userId: "board-user" });
      return created.id;
    }

    companyIdA = await seedCompany("Company A");
    companyIdB = await seedCompany("Company B");
    connIdA = await connectPaperless(companyIdA, HOST_A, PORT_A, "tok-a");
    connIdB = await connectPaperless(companyIdB, HOST_B, PORT_B, "tok-b");
    await documentsSettingsService(db).setEnabled(companyIdA, true);
    await documentsSettingsService(db).setEnabled(companyIdB, true);
  }, 60_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function caller(companyId: string, overrides: Partial<DocumentsCaller> = {}): DocumentsCaller {
    return { companyId, channel: "quick_chat", agentId: null, userId: "board-user", runId: null, laneAConversationId: null, ...overrides };
  }

  it("search_documents returns only the requesting company's own documents", async () => {
    const service = documentsDataService(db, deps());
    const answer = await service.searchDocuments(caller(companyIdA), { query: "leiekontrakt" });
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain("Leiekontrakt A");
    expect(answer.text).toContain("Statens vegvesen");
    expect(answer.text).not.toContain("Faktura B");
    expect(answer.text).not.toContain("Elvia");
  });

  it("get_document mints a download token naming only this company's companyId and the document id", async () => {
    const service = documentsDataService(db, deps());
    const answer = await service.getDocument(caller(companyIdB), { id: 1 });
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain("Faktura B");
    const match = answer.text.match(/\/api\/documents\/download\/(\S+)/);
    expect(match).not.toBeNull();
    const claims = verifyDocumentDownloadToken(match![1]!);
    expect(claims).toMatchObject({ companyId: companyIdB, documentId: 1 });
    // Never the container's own host/port or its token.
    expect(answer.text).not.toContain(HOST_B);
    expect(answer.text).not.toContain("tok-b");
  });

  it("refuses with a plain sentence when documents are switched off for the company", async () => {
    const companyIdC = randomUUID();
    await db.insert(companies).values({ id: companyIdC, name: "Company C", issuePrefix: "DOCC01", requireBoardApprovalForNewAgents: false });
    const service = documentsDataService(db, deps());
    const answer = await service.searchDocuments(caller(companyIdC), { query: "anything" });
    expect(answer.ok).toBe(false);
    expect(answer.refusalCode).toBe("documents_disabled");
    expect(answer.text).toMatch(/switched off/);
  });

  it("refuses when the instance switch itself is off, regardless of the per-company flag", async () => {
    await db.update(instanceSettings).set({ experimental: { enableBusinessData: false } }).where(eq(instanceSettings.singletonKey, "default"));
    try {
      const service = documentsDataService(db, deps());
      const answer = await service.searchDocuments(caller(companyIdA), { query: "x" });
      expect(answer.ok).toBe(false);
      expect(answer.refusalCode).toBe("business_data_disabled");
    } finally {
      await db.update(instanceSettings).set({ experimental: { enableBusinessData: true } }).where(eq(instanceSettings.singletonKey, "default"));
    }
  });

  it("refuses with not_connected when the company has no documents data source set", async () => {
    const companyIdD = randomUUID();
    await db.insert(companies).values({ id: companyIdD, name: "Company D", issuePrefix: "DOCD01", requireBoardApprovalForNewAgents: false });
    await documentsSettingsService(db).setEnabled(companyIdD, true);
    const service = documentsDataService(db, deps());
    const answer = await service.searchDocuments(caller(companyIdD), { query: "x" });
    expect(answer.ok).toBe(false);
    expect(answer.refusalCode).toBe("not_connected");
  });

  it("enforces the per-run request budget (the request budget bounding one conversation)", async () => {
    const service = documentsDataService(db, deps());
    const runCaller = caller(companyIdA, { runId: `budget-run-${randomUUID()}` });
    for (let i = 0; i < 10; i += 1) {
      const answer = await service.searchDocuments(runCaller, { query: "leiekontrakt" });
      expect(answer.ok).toBe(true);
    }
    const eleventh = await service.searchDocuments(runCaller, { query: "leiekontrakt" });
    expect(eleventh.ok).toBe(false);
    expect(eleventh.refusalCode).toBe("run_limit");
  });

  it("enforces the per-agent-per-minute budget separately from the per-run budget", async () => {
    const service = documentsDataService(db, deps());
    const agentCaller = caller(companyIdA, { agentId: randomUUID() });
    for (let i = 0; i < 6; i += 1) {
      const answer = await service.searchDocuments(agentCaller, { query: "leiekontrakt" });
      expect(answer.ok).toBe(true);
    }
    const seventh = await service.searchDocuments(agentCaller, { query: "leiekontrakt" });
    expect(seventh.ok).toBe(false);
    expect(seventh.refusalCode).toBe("agent_minute_limit");
  });

  describe("the proxied download route", () => {
    function app() {
      const instance = express();
      instance.use(documentsDownloadRoutes(db, deps()));
      instance.use(errorHandler);
      return instance;
    }

    it("streams this company's own bytes for a token minted for it", async () => {
      const service = documentsDataService(db, deps());
      const answer = await service.getDocument(caller(companyIdA), { id: 1 });
      const token = answer.text.match(/\/api\/documents\/download\/(\S+)/)![1]!;

      const res = await request(app()).get(`/documents/download/${token}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).toString("utf8")).toBe("PDF-BYTES-A");
      expect(backendA.calls.some((u) => u.includes("/download/"))).toBe(true);
    });

    it("never crosses companies when document ids collide: company B's token reaches only company B's container", async () => {
      const service = documentsDataService(db, deps());
      const answerA = await service.getDocument(caller(companyIdA), { id: 1 });
      const answerB = await service.getDocument(caller(companyIdB), { id: 1 });
      const tokenA = answerA.text.match(/\/api\/documents\/download\/(\S+)/)![1]!;
      const tokenB = answerB.text.match(/\/api\/documents\/download\/(\S+)/)![1]!;

      const resA = await request(app()).get(`/documents/download/${tokenA}`);
      const resB = await request(app()).get(`/documents/download/${tokenB}`);
      expect(Buffer.from(resA.body).toString("utf8")).toBe("PDF-BYTES-A");
      expect(Buffer.from(resB.body).toString("utf8")).toBe("PDF-BYTES-B");
    });

    it("refuses a token whose companyId was swapped without re-signing", async () => {
      const service = documentsDataService(db, deps());
      const answer = await service.getDocument(caller(companyIdA), { id: 1 });
      const token = answer.text.match(/\/api\/documents\/download\/(\S+)/)![1]!;
      const [payload, signature] = token.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      const tampered = Buffer.from(JSON.stringify({ ...claims, companyId: companyIdB }), "utf8").toString("base64url");

      const res = await request(app()).get(`/documents/download/${tampered}.${signature}`);
      expect(res.status).toBe(401);
    });

    it("refuses once the company's documents flag is switched off after the token was minted", async () => {
      const service = documentsDataService(db, deps());
      const answer = await service.getDocument(caller(companyIdB), { id: 1 });
      const token = answer.text.match(/\/api\/documents\/download\/(\S+)/)![1]!;

      await documentsSettingsService(db).setEnabled(companyIdB, false);
      try {
        const res = await request(app()).get(`/documents/download/${token}`);
        expect(res.status).toBe(404);
      } finally {
        await documentsSettingsService(db).setEnabled(companyIdB, true);
      }
    });

    it("refuses an expired token", async () => {
      const { createDocumentDownloadToken } = await import("../services/documents-download-token.js");
      const token = createDocumentDownloadToken(companyIdA, 1, 1)!;
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const res = await request(app()).get(`/documents/download/${token}`);
      expect(res.status).toBe(401);
    });

    it("reports a plain not-found for a document id that does not exist upstream", async () => {
      const { createDocumentDownloadToken } = await import("../services/documents-download-token.js");
      const token = createDocumentDownloadToken(companyIdA, 999, 300)!;
      const res = await request(app()).get(`/documents/download/${token}`);
      expect(res.status).toBe(404);
    });
  });
});
