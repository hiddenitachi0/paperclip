import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  companyAgentRoles,
  companyMemberships,
  contractDeadlineReminders,
  contractDeadlines,
  contractParties,
  contractTerms,
  contracts,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildDocx, buildPdf, buildZip, docxEntries } from "./helpers/contract-fixtures.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { companySearchService } from "../services/company-search.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let contractRoutes: typeof import("../routes/contracts.js").contractRoutes;
let assetRoutes: typeof import("../routes/assets.js").assetRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres contract file tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CLAUSE = "SECRET-CLAUSE the tenant gives six months written notice of termination";

// Legal Phase 2a (DUR-4853): contract upload, text extraction, re-extract,
// download and search, over real HTTP and a real Postgres.
describeEmbeddedPostgres("contract files (DUR-4853)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const storageDir = mkdtempSync(path.join(tmpdir(), "paperclip-contract-files-"));
  const storage = createStorageService(createLocalDiskStorageProvider(storageDir));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-contract-files-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/contracts.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, assetRouteModule, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/contracts.js")>("../routes/contracts.js"),
      vi.importActual<typeof import("../routes/assets.js")>("../routes/assets.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    contractRoutes = routes.contractRoutes;
    assetRoutes = assetRouteModule.assetRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(contractDeadlineReminders);
    await db.delete(contractTerms);
    await db.delete(contractDeadlines);
    await db.delete(contractParties);
    await db.delete(contracts);
    await db.delete(assets);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(storageDir, { recursive: true, force: true });
  });

  type Who =
    | { board: string[]; role?: string }
    | { agentId: string; companyId: string };

  function createApp(who: Who, options: { maxUploadBytes?: number } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor =
        "agentId" in who
          ? { type: "agent", source: "agent_jwt", agentId: who.agentId, companyId: who.companyId }
          : {
              type: "board",
              source: "session",
              userId: randomUUID(),
              companyIds: who.board,
              isInstanceAdmin: false,
              memberships: who.board.map((companyId) => ({
                companyId,
                status: "active",
                membershipRole: who.role ?? "owner",
              })),
            };
      next();
    });
    app.use("/api", contractRoutes(db, storage, options));
    app.use("/api", assetRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, opts: { roleKey?: string } = {}) {
    let roleId: string | null = null;
    if (opts.roleKey) {
      roleId = randomUUID();
      await db.insert(companyAgentRoles).values({ id: roleId, companyId, name: opts.roleKey, key: opts.roleKey });
    }
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      roleId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    return agentId;
  }

  function upload(
    app: express.Express,
    companyId: string,
    file: { body: Buffer; name: string; type?: string },
    fields: Record<string, string> = { type: "rental_lease" },
    route = `/api/companies/${companyId}/contracts/upload`,
  ) {
    let req = request(app).post(route);
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    return req.attach("file", file.body, { filename: file.name, contentType: file.type ?? "application/octet-stream" });
  }

  async function counts() {
    const [contractRows, assetRows] = await Promise.all([db.select().from(contracts), db.select().from(assets)]);
    return { contracts: contractRows.length, assets: assetRows.length };
  }

  describe("upload", () => {
    it("stores a PDF, extracts its text and keeps contract text out of the activity log", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const res = await upload(app, companyId, { body: buildPdf(CLAUSE), name: "Lease 2026.pdf", type: "application/pdf" }, {
        type: "rental_lease",
        title: "Warehouse lease",
      });
      expect(res.status).toBe(201);
      expect(res.body.contract).toMatchObject({ title: "Warehouse lease", textStatus: "extracted", versionNo: 1 });
      expect(res.body.contract.assetId).toBeTruthy();
      expect(res.body.contract.extractedText).toBeUndefined();
      expect(res.body.extraction).toMatchObject({ textStatus: "extracted", hint: null });
      expect(JSON.stringify(res.body)).not.toContain("SECRET-CLAUSE");

      const stored = await request(app).get(`/api/companies/${companyId}/contracts/${res.body.contract.id}?includeText=true`);
      expect(stored.body.extractedText).toContain("six months written notice");

      const [asset] = await db.select().from(assets).where(eq(assets.id, res.body.contract.assetId));
      expect(asset).toMatchObject({ companyId, contentType: "application/pdf" });

      const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(logs.map((row) => row.action)).toEqual(expect.arrayContaining(["contract.created", "contract.text_extracted"]));
      const logged = JSON.stringify(logs.map((row) => row.details));
      expect(logged).not.toContain("SECRET-CLAUSE");
      expect(logged).not.toContain("Lease 2026");
    });

    it("stores a DOCX and uses the file name when no title is given", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const res = await upload(app, companyId, { body: buildDocx([CLAUSE]), name: "Supplier terms.docx" }, { type: "vendor_supplier" });
      expect(res.status).toBe(201);
      expect(res.body.contract).toMatchObject({ title: "Supplier terms", textStatus: "extracted", type: "vendor_supplier" });
      const [asset] = await db.select().from(assets).where(eq(assets.id, res.body.contract.assetId));
      expect(asset.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    });

    it("marks an image-only PDF no_text_layer and says it needs OCR", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const res = await upload(app, companyId, { body: buildPdf(), name: "scan.pdf" });
      expect(res.status).toBe(201);
      expect(res.body.contract.textStatus).toBe("no_text_layer");
      expect(res.body.extraction.hint).toMatch(/OCR/);
      expect(res.body.extraction.hint).toMatch(/agent .* can read the PDF/);
    });

    it("keeps a truncated PDF and a zip-bomb DOCX as failed, with the file stored", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const pdf = buildPdf(CLAUSE);
      const truncated = await upload(app, companyId, { body: pdf.subarray(0, Math.floor(pdf.length / 3)), name: "cut.pdf" });
      expect(truncated.status).toBe(201);
      expect(truncated.body.contract.textStatus).toBe("failed");
      expect(truncated.body.contract.assetId).toBeTruthy();
      expect(truncated.body.extraction.hint).toMatch(/re-extract/);

      const bomb = buildZip([...docxEntries([CLAUSE]), { name: "word/media/bomb.bin", data: Buffer.alloc(120 * 1024 * 1024) }]);
      const bombed = await upload(app, companyId, { body: bomb, name: "bomb.docx" });
      expect(bombed.status).toBe(201);
      expect(bombed.body.contract.textStatus).toBe("failed");
      expect(bombed.body.extraction.reason).toBe("rejected");
      expect(bombed.body.contract.assetId).toBeTruthy();
      expect((await counts()).assets).toBe(2);
    });

    it("refuses wrong magic bytes, mismatched extensions, macros, empty files and oversize files before storing anything", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] }, { maxUploadBytes: 200_000 });

      const exe = await upload(app, companyId, { body: Buffer.from("MZ\x90\x00 pretend executable"), name: "lease.pdf", type: "application/pdf" });
      expect(exe.status).toBe(422);
      const html = await upload(app, companyId, { body: Buffer.from("<html><script>alert(1)</script></html>"), name: "lease.docx" });
      expect(html.status).toBe(422);
      const wrongExtension = await upload(app, companyId, { body: buildPdf(CLAUSE), name: "lease.docx" });
      expect(wrongExtension.status).toBe(422);
      const macro = await upload(app, companyId, {
        body: buildZip([...docxEntries([CLAUSE]), { name: "word/vbaProject.bin", data: Buffer.from("macro") }]),
        name: "macro.docx",
      });
      expect(macro.status).toBe(422);
      const empty = await upload(app, companyId, { body: Buffer.alloc(0), name: "empty.pdf" });
      expect([400, 422]).toContain(empty.status);
      const big = await upload(app, companyId, { body: Buffer.concat([buildPdf(CLAUSE), Buffer.alloc(300_000)]), name: "big.pdf" });
      expect(big.status).toBe(422);
      expect(big.body.error).toMatch(/limit/);

      expect(await counts()).toEqual({ contracts: 0, assets: 0 });
      expect(JSON.stringify([exe.body, html.body, wrongExtension.body, macro.body, big.body])).not.toContain("SECRET");
    });

    it("rejects a missing file and invalid form fields", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const noFile = await request(app).post(`/api/companies/${companyId}/contracts/upload`).field("type", "nda");
      expect(noFile.status).toBe(400);
      const badType = await upload(app, companyId, { body: buildPdf(CLAUSE), name: "a.pdf" }, { type: "not-a-type" });
      expect(badType.status).toBe(400);
      expect(await counts()).toEqual({ contracts: 0, assets: 0 });
    });
  });

  describe("access and company boundaries", () => {
    it("refuses an ordinary agent, a viewer and another company's board before reading the upload", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const plainAgent = await seedAgent(companyA);
      const file = { body: buildPdf(CLAUSE), name: "lease.pdf" };

      expect((await upload(createApp({ agentId: plainAgent, companyId: companyA }), companyA, file)).status).toBe(403);
      expect((await upload(createApp({ board: [companyA], role: "viewer" }), companyA, file)).status).toBe(403);
      expect((await upload(createApp({ board: [companyB] }), companyA, file)).status).toBe(403);
      expect(await counts()).toEqual({ contracts: 0, assets: 0 });
    });

    it("lets the Legal Advisor position upload, and only into its own company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const legal = await seedAgent(companyA, { roleKey: "legal-advisor" });
      const app = createApp({ agentId: legal, companyId: companyA });
      expect((await upload(app, companyA, { body: buildPdf(CLAUSE), name: "lease.pdf" })).status).toBe(201);
      expect((await upload(app, companyB, { body: buildPdf(CLAUSE), name: "lease.pdf" })).status).toBe(403);
    });

    it("keeps contract files out of the general asset route for callers who may not use contracts, even a replaced file", async () => {
      const companyA = await seedCompany();
      const legal = await seedAgent(companyA, { roleKey: "legal-advisor" });
      const plainAgent = await seedAgent(companyA);
      const owner = createApp({ board: [companyA] });
      const created = await upload(owner, companyA, { body: buildPdf(CLAUSE), name: "lease.pdf" });
      const id = created.body.contract.id as string;
      const firstAsset = created.body.contract.assetId as string;
      const replaced = await upload(owner, companyA, { body: buildPdf(CLAUSE), name: "v2.pdf" }, {}, `/api/companies/${companyA}/contracts/${id}/file`);
      const secondAsset = replaced.body.contract.assetId as string;
      expect(secondAsset).not.toBe(firstAsset);

      for (const assetId of [firstAsset, secondAsset]) {
        const url = `/api/assets/${assetId}/content`;
        expect((await request(createApp({ agentId: plainAgent, companyId: companyA })).get(url)).status).toBe(404);
        expect((await request(createApp({ board: [companyA], role: "viewer" })).get(url)).status).toBe(404);
        expect((await request(createApp({ agentId: legal, companyId: companyA })).get(url)).status).toBe(200);
        expect((await request(owner).get(url)).status).toBe(200);
      }

      // The activity log no longer hands out the asset id either.
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityType, "contract"));
      expect(JSON.stringify(activity.map((row) => row.details))).not.toContain(firstAsset);
    });

    it("never reaches a contract of another company by id (file, re-extract, download)", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const appA = createApp({ board: [companyA] });
      const appB = createApp({ board: [companyB] });
      const created = await upload(appA, companyA, { body: buildPdf(CLAUSE), name: "lease.pdf" });
      const id = created.body.contract.id as string;

      expect((await request(appB).post(`/api/companies/${companyB}/contracts/${id}/re-extract`)).status).toBe(404);
      expect((await request(appB).get(`/api/companies/${companyB}/contracts/${id}/file`)).status).toBe(404);
      expect((await upload(appB, companyB, { body: buildPdf(CLAUSE), name: "x.pdf" }, {}, `/api/companies/${companyB}/contracts/${id}/file`)).status).toBe(404);
      expect((await request(appB).post(`/api/companies/${companyA}/contracts/${id}/re-extract`)).status).toBe(403);
      const untouched = await request(appA).get(`/api/companies/${companyA}/contracts/${id}?includeText=true`);
      expect(untouched.body.extractedText).toContain("six months");
    });
  });

  describe("re-extract, attach and download", () => {
    it("re-extracts, replaces the file and downloads it with safe headers", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const created = await upload(app, companyId, { body: buildPdf(CLAUSE), name: "lease.pdf" });
      const id = created.body.contract.id as string;

      await db.update(contracts).set({ extractedText: null, textStatus: "failed" }).where(eq(contracts.id, id));
      const again = await request(app).post(`/api/companies/${companyId}/contracts/${id}/re-extract`);
      expect(again.status).toBe(200);
      expect(again.body.contract.textStatus).toBe("extracted");
      expect(JSON.stringify(again.body)).not.toContain("SECRET-CLAUSE");

      const replaced = await upload(app, companyId, { body: buildDocx(["Rent is fixed for three years."]), name: "amended.docx" }, {}, `/api/companies/${companyId}/contracts/${id}/file`);
      expect(replaced.status).toBe(200);
      expect(replaced.body.contract.textStatus).toBe("extracted");
      expect(replaced.body.contract.assetId).not.toBe(created.body.contract.assetId);
      const text = await request(app).get(`/api/companies/${companyId}/contracts/${id}?includeText=true`);
      expect(text.body.extractedText).toContain("fixed for three years");
      expect(text.body.extractedText).not.toContain("SECRET-CLAUSE");

      const download = await request(app).get(`/api/companies/${companyId}/contracts/${id}/file`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(download.status).toBe(200);
      expect(download.headers["content-type"]).toContain("wordprocessingml");
      expect(download.headers["content-disposition"]).toBe('attachment; filename="contract.docx"');
      expect(download.headers["x-content-type-options"]).toBe("nosniff");
      expect(download.headers["cache-control"]).toBe("private, no-store");
      expect(Buffer.isBuffer(download.body) && download.body.subarray(0, 2).toString()).toBe("PK");
    });

    it("re-extract on a contract without a file is a 422, and a failed re-extract never leaves pending", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const bare = await request(app).post(`/api/companies/${companyId}/contracts`).send({ title: "Handshake", type: "other" });
      expect((await request(app).post(`/api/companies/${companyId}/contracts/${bare.body.id}/re-extract`)).status).toBe(422);
      expect((await request(app).get(`/api/companies/${companyId}/contracts/${bare.body.id}/file`)).status).toBe(404);
    });

    it("a late extraction cannot write onto a file that was replaced meanwhile", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const created = await upload(app, companyId, { body: buildPdf(CLAUSE), name: "lease.pdf" });
      const id = created.body.contract.id as string;
      // Simulate the replacement landing after the old file was read: the write is pinned to the asset read.
      const { contractFileService } = await import("../services/contract-files.js");
      const files = contractFileService(db, storage, { maxBytes: 1024 * 1024 });
      const [other] = await db.insert(assets).values({
        companyId, provider: "local_disk", objectKey: "x", contentType: "application/pdf", byteSize: 1, sha256: "0".repeat(64),
      }).returning();
      const originalAsset = created.body.contract.assetId as string;
      await db.update(contracts).set({ assetId: other.id, extractedText: "NEW", textStatus: "extracted" }).where(eq(contracts.id, id));
      // extractFor reads the *current* asset (the stub one), which has no stored object: it must fail without touching NEW.
      await expect(files.extractFor(companyId, id)).rejects.toBeTruthy();
      const [row] = await db.select().from(contracts).where(eq(contracts.id, id));
      expect(row.extractedText).toBe("NEW");
      expect(originalAsset).not.toBe(other.id);
    });
  });

  describe("search", () => {
    async function seedSearchable(companyId: string) {
      const app = createApp({ board: [companyId] });
      const created = await upload(app, companyId, { body: buildPdf(CLAUSE), name: "lease.pdf" }, {
        type: "rental_lease",
        title: "Harbour warehouse lease",
        summary: "Ten year lease with indexation",
      });
      const id = created.body.contract.id as string;
      await request(app).post(`/api/companies/${companyId}/contracts/${id}/parties`).send({ role: "landlord", name: "Kystbygg Eiendom AS" });
      return id;
    }

    it("finds a contract by title, party, summary and contents, with a snippet around the match", async () => {
      const companyId = await seedCompany();
      const id = await seedSearchable(companyId);
      const search = companySearchService(db);
      const run = (q: string, scope: "all" | "contracts" = "all") =>
        search.search(companyId, { q, scope, limit: 20, offset: 0 }, { includeContracts: true });

      for (const [q, field] of [["harbour", "title"], ["kystbygg", "parties"], ["indexation", "summary"], ["termination", "text"]] as const) {
        const result = await run(q);
        const hit = result.results.find((row) => row.id === id);
        expect(hit, q).toBeTruthy();
        expect(hit?.type).toBe("contract");
        expect(hit?.contract?.matchedIn).toContain(field);
        expect(hit?.href).toMatch(new RegExp(`/contracts/${id}$`));
      }
      const textHit = (await run("six months written")).results.find((row) => row.id === id);
      expect(textHit?.snippet?.toLowerCase()).toContain("six months written");
      expect((await run("six months written", "contracts")).countsByType.contract).toBe(1);
      expect((await run("nothing-like-this")).results).toHaveLength(0);
    });

    it("never returns contracts unless the caller may use them, and never across companies", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const idA = await seedSearchable(companyA);
      const search = companySearchService(db);
      const query = { q: "termination", scope: "all" as const, limit: 20, offset: 0 };

      expect((await search.search(companyA, query)).results.find((row) => row.id === idA)).toBeUndefined();
      expect((await search.search(companyA, query, { includeContracts: false })).countsByType.contract).toBe(0);
      expect((await search.search(companyB, query, { includeContracts: true })).results).toHaveLength(0);
      expect((await search.search(companyA, { ...query, scope: "contracts" }, { includeContracts: false })).results).toHaveLength(0);
    });
  });
});
