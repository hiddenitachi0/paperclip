import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  crmOrganizations,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let contractRoutes: typeof import("../routes/contracts.js").contractRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres contract register tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Legal Phase 1 (DUR-4852): the contract register over real HTTP and a real
// Postgres -- company isolation, who may use it (board / Legal position /
// explicit grant), the version chain, term rules and the aggregate answer.
describeEmbeddedPostgres("contract register routes (DUR-4852)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const storageDir = mkdtempSync(path.join(tmpdir(), "paperclip-contract-files-"));
  const storage = createStorageService(createLocalDiskStorageProvider(storageDir));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-contracts-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/contracts.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/contracts.js")>("../routes/contracts.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    contractRoutes = routes.contractRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(contractDeadlineReminders);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(contractTerms);
    await db.delete(contractDeadlines);
    await db.delete(contractParties);
    await db.delete(contracts);
    await db.delete(crmOrganizations);
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
    | { agentId: string; companyId: string; actorExtra?: Record<string, unknown> };

  function createApp(who: Who) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor =
        "agentId" in who
          ? { type: "agent", source: "agent_jwt", agentId: who.agentId, companyId: who.companyId, ...who.actorExtra }
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
    app.use("/api", contractRoutes(db, storage));
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

  async function seedAgent(
    companyId: string,
    opts: { roleKey?: string; grant?: boolean; status?: string; permissions?: Record<string, unknown> } = {},
  ) {
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
      status: opts.status ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: opts.permissions ?? {},
      roleId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    if (opts.grant) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "contracts:access",
        scope: null,
      });
    }
    return agentId;
  }

  async function createContract(app: express.Express, companyId: string, body: Record<string, unknown> = {}) {
    const res = await request(app)
      .post(`/api/companies/${companyId}/contracts`)
      .send({ title: "Warehouse lease", type: "rental_lease", status: "active", ...body });
    expect(res.status).toBe(201);
    return res.body as { id: string; versionNo: number };
  }

  async function setTerm(app: express.Express, companyId: string, contractId: string, key: string, body: Record<string, unknown>) {
    const res = await request(app).put(`/api/companies/${companyId}/contracts/${contractId}/terms/${key}`).send(body);
    expect(res.status).toBe(200);
    return res.body;
  }

  describe("board CRUD", () => {
    it("creates with parties, lists without text, and returns text only on request", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const [org] = await db.insert(crmOrganizations).values({ companyId, name: "Landlord AS" }).returning();

      const created = await request(app)
        .post(`/api/companies/${companyId}/contracts`)
        .send({
          title: "Warehouse lease",
          type: "rental_lease",
          extractedText: "SECRET-CLAUSE-TEXT 4.2 the tenant shall",
          textStatus: "extracted",
          expiryDate: "2027-06-30",
          parties: [
            { organizationId: org.id, role: "landlord" },
            { name: "Our Company AS", role: "tenant" },
          ],
        });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ companyId, status: "draft", versionNo: 1, supersedesContractId: null });
      expect(created.body.extractedText).toBeUndefined();

      const list = await request(app).get(`/api/companies/${companyId}/contracts`);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain("SECRET-CLAUSE-TEXT");

      const detail = await request(app).get(`/api/companies/${companyId}/contracts/${created.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.parties).toHaveLength(2);
      expect(JSON.stringify(detail.body)).not.toContain("SECRET-CLAUSE-TEXT");

      const withText = await request(app).get(`/api/companies/${companyId}/contracts/${created.body.id}?includeText=true`);
      expect(withText.body.extractedText).toContain("SECRET-CLAUSE-TEXT");
    });

    it("filters the list by status, type and expiry", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      await createContract(app, companyId, { title: "A", type: "nda", status: "active", expiryDate: "2026-12-01" });
      await createContract(app, companyId, { title: "B", type: "service", status: "expired", expiryDate: "2025-01-01" });
      const q = (qs: string) => request(app).get(`/api/companies/${companyId}/contracts?${qs}`).then((r) => r.body);
      expect(await q("status=active")).toHaveLength(1);
      expect(await q("type=service")).toHaveLength(1);
      expect(await q("expiresBefore=2026-01-01")).toHaveLength(1);
      expect((await request(app).get(`/api/companies/${companyId}/contracts?status=bogus`)).status).toBe(400);
    });

    it("updates a contract but never to superseded", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const ok = await request(app).patch(`/api/companies/${companyId}/contracts/${id}`).send({ status: "terminated", governingLaw: "Norwegian law" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "terminated", governingLaw: "Norwegian law" });
      const bad = await request(app).patch(`/api/companies/${companyId}/contracts/${id}`).send({ status: "superseded" });
      expect(bad.status).toBe(400);
    });

    it("rejects an asset, issue or organisation from another company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const app = createApp({ board: [companyA, companyB] });
      const [assetB] = await db
        .insert(assets)
        .values({ companyId: companyB, provider: "local", objectKey: "k", contentType: "application/pdf", byteSize: 1, sha256: "x" })
        .returning();
      const [orgB] = await db.insert(crmOrganizations).values({ companyId: companyB, name: "B org" }).returning();

      const withAsset = await request(app)
        .post(`/api/companies/${companyA}/contracts`)
        .send({ title: "t", type: "nda", assetId: assetB.id });
      expect(withAsset.status).toBe(422);
      const withOrg = await request(app)
        .post(`/api/companies/${companyA}/contracts`)
        .send({ title: "t", type: "nda", parties: [{ organizationId: orgB.id, role: "vendor" }] });
      expect(withOrg.status).toBe(422);
      expect(await db.select().from(contracts)).toHaveLength(0);
    });

    it("deletes a stand-alone contract (board only) and refuses one in a version chain", async () => {
      const companyId = await seedCompany();
      const board = createApp({ board: [companyId] });
      const legalAgent = await seedAgent(companyId, { roleKey: "legal-advisor" });
      const agentApp = createApp({ agentId: legalAgent, companyId });

      const solo = await createContract(board, companyId);
      expect((await request(agentApp).delete(`/api/companies/${companyId}/contracts/${solo.id}`)).status).toBe(403);
      expect((await request(board).delete(`/api/companies/${companyId}/contracts/${solo.id}`)).status).toBe(200);
      expect((await request(board).get(`/api/companies/${companyId}/contracts/${solo.id}`)).status).toBe(404);

      const v1 = await createContract(board, companyId);
      const v2 = await createContract(board, companyId);
      const link = await request(board)
        .post(`/api/companies/${companyId}/contracts/${v2.id}/link-previous-version`)
        .send({ previousContractId: v1.id, changeSummary: "rent up", carryDeadlines: false });
      expect(link.status).toBe(200);
      expect((await request(board).delete(`/api/companies/${companyId}/contracts/${v1.id}`)).status).toBe(409);
      expect((await request(board).delete(`/api/companies/${companyId}/contracts/${v2.id}`)).status).toBe(409);
    });
  });

  describe("confidentiality and company isolation", () => {
    it("lets an agent in the Legal position use the register, and refuses other agents", async () => {
      const companyId = await seedCompany();
      const legal = await seedAgent(companyId, { roleKey: "legal-advisor" });
      const plain = await seedAgent(companyId);
      const otherPosition = await seedAgent(companyId, { roleKey: "customer-support" });

      const legalApp = createApp({ agentId: legal, companyId });
      expect((await request(legalApp).get(`/api/companies/${companyId}/contracts`)).status).toBe(200);
      const created = await request(legalApp)
        .post(`/api/companies/${companyId}/contracts`)
        .send({ title: "NDA", type: "nda" });
      expect(created.status).toBe(201);
      expect(created.body.createdByAgentId).toBe(legal);

      for (const agentId of [plain, otherPosition]) {
        const app = createApp({ agentId, companyId });
        for (const res of [
          await request(app).get(`/api/companies/${companyId}/contracts`),
          await request(app).get(`/api/companies/${companyId}/contracts/${created.body.id}`),
          await request(app).post(`/api/companies/${companyId}/contracts`).send({ title: "x", type: "nda" }),
          await request(app).get(`/api/companies/${companyId}/contract-deadlines`),
          await request(app).get(`/api/companies/${companyId}/contract-terms/payment_terms_days/aggregate`),
        ]) {
          expect(res.status).toBe(403);
          expect(JSON.stringify(res.body)).not.toContain("NDA");
        }
      }
    });

    it("lets any agent with the explicit contracts:access grant in, and no one else", async () => {
      const companyId = await seedCompany();
      const granted = await seedAgent(companyId, { grant: true });
      const plain = await seedAgent(companyId);
      expect((await request(createApp({ agentId: granted, companyId })).get(`/api/companies/${companyId}/contracts`)).status).toBe(200);
      expect((await request(createApp({ agentId: plain, companyId })).get(`/api/companies/${companyId}/contracts`)).status).toBe(403);
    });

    it("refuses a task-bridge key even for the Legal Advisor or a granted agent", async () => {
      const companyId = await seedCompany();
      const legal = await seedAgent(companyId, { roleKey: "legal-advisor" });
      const granted = await seedAgent(companyId, { grant: true });
      const contract = await createContract(createApp({ board: [companyId] }), companyId);
      for (const agentId of [legal, granted]) {
        const app = createApp({
          agentId,
          companyId,
          actorExtra: {
            source: "agent_key",
            keyId: randomUUID(),
            keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
          },
        });
        for (const res of [
          await request(app).get(`/api/companies/${companyId}/contracts`),
          await request(app).get(`/api/companies/${companyId}/contracts/${contract.id}?includeText=true`),
          await request(app).patch(`/api/companies/${companyId}/contracts/${contract.id}`).send({ title: "x" }),
        ]) {
          expect(res.status).toBe(403);
        }
      }
    });

    it("refuses a Limited-trust agent even for the Legal Advisor or a granted agent", async () => {
      const companyId = await seedCompany();
      const permissions = {
        trustPreset: "low_trust_review",
        authorizationPolicy: { trustBoundary: { mode: "low_trust_review", projectIds: [randomUUID()] } },
      };
      const legal = await seedAgent(companyId, { roleKey: "legal-advisor", permissions });
      const granted = await seedAgent(companyId, { grant: true, permissions });
      for (const agentId of [legal, granted]) {
        const res = await request(createApp({ agentId, companyId })).get(`/api/companies/${companyId}/contracts`);
        expect(res.status).toBe(403);
      }
    });

    it("refuses a terminated or pending Legal agent", async () => {
      const companyId = await seedCompany();
      const terminated = await seedAgent(companyId, { roleKey: "legal-advisor", status: "terminated" });
      expect((await request(createApp({ agentId: terminated, companyId })).get(`/api/companies/${companyId}/contracts`)).status).toBe(403);
    });

    it("keeps a position key in another company from opening this company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const legalB = await seedAgent(companyB, { roleKey: "legal-advisor" });
      const boardA = createApp({ board: [companyA] });
      const contractA = await createContract(boardA, companyA);

      const appB = createApp({ agentId: legalB, companyId: companyB });
      for (const res of [
        await request(appB).get(`/api/companies/${companyA}/contracts`),
        await request(appB).get(`/api/companies/${companyA}/contracts/${contractA.id}`),
        await request(appB).post(`/api/companies/${companyA}/contracts`).send({ title: "x", type: "nda" }),
        await request(appB).get(`/api/companies/${companyA}/contract-terms/payment_terms_days/aggregate`),
      ]) {
        expect([403, 404]).toContain(res.status);
      }
      expect(await db.select().from(contracts)).toHaveLength(1);
    });

    it("keeps board members of one company out of another's contracts", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const boardA = createApp({ board: [companyA] });
      const boardB = createApp({ board: [companyB] });
      const contractB = await createContract(boardB, companyB);
      expect((await request(boardA).get(`/api/companies/${companyB}/contracts`)).status).toBe(403);
      expect((await request(boardA).get(`/api/companies/${companyB}/contracts/${contractB.id}`)).status).toBe(403);
      // Reaching B's contract id through A's own path finds nothing.
      expect((await request(boardA).get(`/api/companies/${companyA}/contracts/${contractB.id}`)).status).toBe(404);
      expect((await request(boardA).patch(`/api/companies/${companyA}/contracts/${contractB.id}`).send({ title: "pwn" })).status).toBe(404);
      expect((await request(boardA).delete(`/api/companies/${companyA}/contracts/${contractB.id}`)).status).toBe(404);
      expect(
        (await request(boardA).put(`/api/companies/${companyA}/contracts/${contractB.id}/terms/liability_cap`).send({ valueKind: "not_mentioned" })).status,
      ).toBe(404);
      expect(
        (await request(boardA).post(`/api/companies/${companyA}/contracts/${contractB.id}/deadlines`).send({ kind: "expiry", dueDate: "2027-01-01" })).status,
      ).toBe(404);
      const after = await db.select().from(contracts);
      expect(after.find((row) => row.id === contractB.id)?.title).toBe("Warehouse lease");
    });

    it("refuses read-only viewer members", async () => {
      const companyId = await seedCompany();
      const viewer = createApp({ board: [companyId], role: "viewer" });
      expect((await request(viewer).get(`/api/companies/${companyId}/contracts`)).status).toBe(403);
    });

    it("never links a previous version from another company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const boardA = createApp({ board: [companyA] });
      const boardB = createApp({ board: [companyB] });
      const a = await createContract(boardA, companyA);
      const b = await createContract(boardB, companyB);
      const res = await request(boardA)
        .post(`/api/companies/${companyA}/contracts/${a.id}/link-previous-version`)
        .send({ previousContractId: b.id, changeSummary: "x", carryDeadlines: true });
      expect(res.status).toBe(404);
      const rows = await db.select().from(contracts);
      expect(rows.every((row) => row.status === "active" && row.supersedesContractId === null)).toBe(true);
    });

    it("writes no contract text, title, summary or term value to the activity log", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const created = await request(app)
        .post(`/api/companies/${companyId}/contracts`)
        .send({
          title: "TITLE-MARKER",
          type: "vendor_supplier",
          summary: "SUMMARY-MARKER",
          extractedText: "TEXT-MARKER",
          parties: [{ name: "PARTY-NAME-MARKER", role: "vendor" }],
        });
      const id = created.body.id as string;
      await request(app).patch(`/api/companies/${companyId}/contracts/${id}`).send({ summary: "SUMMARY-MARKER-2", extractedText: "TEXT-MARKER-2" });
      await request(app)
        .put(`/api/companies/${companyId}/contracts/${id}/terms/price_indexation`)
        .send({ valueKind: "text", textValue: "TERM-MARKER", clauseRef: "CLAUSE-MARKER" });
      await request(app)
        .post(`/api/companies/${companyId}/contracts/${id}/deadlines`)
        .send({ kind: "notice_terminate", dueDate: "2027-01-01", note: "NOTE-MARKER", clauseRef: "CLAUSE-MARKER" });
      const v2 = await createContract(app, companyId, { title: "TITLE-MARKER-2" });
      await request(app)
        .post(`/api/companies/${companyId}/contracts/${v2.id}/link-previous-version`)
        .send({ previousContractId: id, changeSummary: "CHANGE-MARKER", carryDeadlines: true });

      const rows = await db.select().from(activityLog);
      expect(rows.length).toBeGreaterThanOrEqual(6);
      const dump = JSON.stringify(rows);
      for (const marker of ["TITLE-MARKER", "SUMMARY-MARKER", "TEXT-MARKER", "PARTY-NAME-MARKER", "TERM-MARKER", "CLAUSE-MARKER", "NOTE-MARKER", "CHANGE-MARKER"]) {
        expect(dump).not.toContain(marker);
      }
    });

    it("does not echo contract content in validation or conflict errors", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const bad = await request(app)
        .post(`/api/companies/${companyId}/contracts`)
        .send({ title: "ERR-TITLE-MARKER", type: "not-a-type", extractedText: "ERR-TEXT-MARKER" });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toContain("ERR-TEXT-MARKER");
      expect(JSON.stringify(bad.body)).not.toContain("ERR-TITLE-MARKER");
    });
  });

  describe("version chain", () => {
    async function twoVersions(app: express.Express, companyId: string) {
      const v1 = await createContract(app, companyId, { title: "Lease v1" });
      const v2 = await createContract(app, companyId, { title: "Lease v2" });
      return { v1, v2 };
    }
    const link = (app: express.Express, companyId: string, currentId: string, body: Record<string, unknown>) =>
      request(app).post(`/api/companies/${companyId}/contracts/${currentId}/link-previous-version`).send(body);

    it("supersedes the old version, numbers the new one and records the change note", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { v1, v2 } = await twoVersions(app, companyId);
      const res = await link(app, companyId, v2.id, { previousContractId: v1.id, changeSummary: "Rent +3%", carryDeadlines: false });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ versionNo: 2, previousContractId: v1.id });

      const old = await request(app).get(`/api/companies/${companyId}/contracts/${v1.id}`);
      const next = await request(app).get(`/api/companies/${companyId}/contracts/${v2.id}`);
      expect(old.body.status).toBe("superseded");
      expect(next.body).toMatchObject({ versionNo: 2, supersedesContractId: v1.id, changeSummary: "Rent +3%" });
    });

    it("carryDeadlines=false closes the old version's open deadlines as superseded and leaves closed ones alone", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { v1, v2 } = await twoVersions(app, companyId);
      const open = await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "notice_terminate", dueDate: "2027-03-01" });
      const done = await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "payment", dueDate: "2026-11-01" });
      await request(app).patch(`/api/companies/${companyId}/contracts/${v1.id}/deadlines/${done.body.id}`).send({ state: "done" });

      const res = await link(app, companyId, v2.id, { previousContractId: v1.id, changeSummary: "x", carryDeadlines: false });
      expect(res.body).toMatchObject({ movedDeadlines: 0, supersededDeadlines: 1 });
      const rows = await db.select().from(contractDeadlines);
      expect(rows.find((r) => r.id === open.body.id)).toMatchObject({ state: "superseded", contractId: v1.id });
      expect(rows.find((r) => r.id === done.body.id)).toMatchObject({ state: "done", contractId: v1.id });
    });

    it("carryDeadlines=true moves open deadlines to the new version and does not duplicate one it already has", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { v1, v2 } = await twoVersions(app, companyId);
      const moves = await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "notice_terminate", dueDate: "2027-03-01" });
      const dup = await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "expiry", dueDate: "2027-06-30" });
      const already = await request(app).post(`/api/companies/${companyId}/contracts/${v2.id}/deadlines`).send({ kind: "expiry", dueDate: "2027-06-30" });

      const res = await link(app, companyId, v2.id, { previousContractId: v1.id, changeSummary: "x", carryDeadlines: true });
      expect(res.body).toMatchObject({ movedDeadlines: 1, supersededDeadlines: 1 });
      const rows = await db.select().from(contractDeadlines);
      expect(rows.find((r) => r.id === moves.body.id)).toMatchObject({ state: "open", contractId: v2.id });
      expect(rows.find((r) => r.id === dup.body.id)).toMatchObject({ state: "superseded", contractId: v1.id });
      expect(rows.find((r) => r.id === already.body.id)).toMatchObject({ state: "open", contractId: v2.id });
      expect(rows.filter((r) => r.contractId === v2.id && r.state === "open")).toHaveLength(2);
    });

    it("keeps reminder history attached to a moved deadline", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { v1, v2 } = await twoVersions(app, companyId);
      // 55 days out: the 60-day step is in range, so the reminder sync keeps its row.
      const dueDate = new Date(Date.now() + 55 * 86_400_000).toISOString().slice(0, 10);
      const deadline = await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "notice_terminate", dueDate });
      await db.delete(contractDeadlineReminders);
      await db.insert(contractDeadlineReminders).values({ companyId, deadlineId: deadline.body.id, leadDays: 60 });
      await link(app, companyId, v2.id, { previousContractId: v1.id, changeSummary: "x", carryDeadlines: true });
      const reminders = await db.select().from(contractDeadlineReminders);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].deadlineId).toBe(deadline.body.id);
    });

    it("walks the chain in order from any version and chains three versions", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const v1 = await createContract(app, companyId, { title: "v1" });
      const v2 = await createContract(app, companyId, { title: "v2" });
      const v3 = await createContract(app, companyId, { title: "v3" });
      expect((await link(app, companyId, v2.id, { previousContractId: v1.id, changeSummary: "one", carryDeadlines: false })).status).toBe(200);
      const third = await link(app, companyId, v3.id, { previousContractId: v2.id, changeSummary: "two", carryDeadlines: false });
      expect(third.body.versionNo).toBe(3);
      for (const start of [v1.id, v2.id, v3.id]) {
        const log = await request(app).get(`/api/companies/${companyId}/contracts/${start}/versions`);
        expect(log.status).toBe(200);
        expect(log.body.map((v: { title: string }) => v.title)).toEqual(["v1", "v2", "v3"]);
        expect(log.body.map((v: { versionNo: number }) => v.versionNo)).toEqual([1, 2, 3]);
        expect(log.body[1].changeSummary).toBe("one");
        expect(log.body[2].changeSummary).toBe("two");
        expect(log.body[0].extractedText).toBeUndefined();
      }
    });

    it("refuses self-links, forks, re-links, loops and superseded contracts", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const v1 = await createContract(app, companyId, { title: "v1" });
      const v2 = await createContract(app, companyId, { title: "v2" });
      const other = await createContract(app, companyId, { title: "other" });
      const body = (previousContractId: string) => ({ previousContractId, changeSummary: "x", carryDeadlines: false });

      expect((await link(app, companyId, v1.id, body(v1.id))).status).toBe(422);
      expect((await link(app, companyId, v2.id, body(v1.id))).status).toBe(200);
      // v1 already has a successor: no fork.
      expect((await link(app, companyId, other.id, body(v1.id))).status).toBe(409);
      // v2 already has a previous version.
      expect((await link(app, companyId, v2.id, body(other.id))).status).toBe(409);
      // Loop: v1 as the newer version of v2.
      expect((await link(app, companyId, v1.id, body(v2.id))).status).toBe(409);
      // v1 is superseded and cannot be the "newer" one for anyone.
      expect((await link(app, companyId, v1.id, body(other.id))).status).toBe(409);
      const rows = await db.select().from(contracts);
      expect(rows.find((r) => r.id === other.id)).toMatchObject({ status: "active", supersedesContractId: null });
      expect(rows.find((r) => r.id === v1.id)).toMatchObject({ status: "superseded", supersedesContractId: null });
    });

    it("rolls back completely when the link fails part-way", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const v1 = await createContract(app, companyId);
      const v2 = await createContract(app, companyId);
      const res = await link(app, companyId, v2.id, { previousContractId: randomUUID(), changeSummary: "x", carryDeadlines: true });
      expect(res.status).toBe(404);
      const rows = await db.select().from(contracts);
      expect(rows.every((r) => r.status === "active" && r.versionNo === 1 && r.supersedesContractId === null)).toBe(true);
      expect(v1.id).not.toBe(v2.id);
    });

    it("refuses new deadlines on a superseded contract and refuses to reactivate one", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { v1, v2 } = await twoVersions(app, companyId);
      await link(app, companyId, v2.id, { previousContractId: v1.id, changeSummary: "x", carryDeadlines: false });
      expect((await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "expiry", dueDate: "2027-01-01" })).status).toBe(409);
      expect((await request(app).patch(`/api/companies/${companyId}/contracts/${v1.id}`).send({ status: "active" })).status).toBe(409);
    });
  });

  describe("deadlines", () => {
    it("fills the default lead times per kind and lets the caller override them", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const post = (body: Record<string, unknown>) =>
        request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send(body);
      expect((await post({ kind: "notice_terminate", dueDate: "2027-03-01" })).body.leadTimesDays).toEqual([60, 30, 7]);
      expect((await post({ kind: "notice_extend", dueDate: "2027-03-01" })).body.leadTimesDays).toEqual([60, 30, 7]);
      expect((await post({ kind: "expiry", dueDate: "2027-03-01" })).body.leadTimesDays).toEqual([30, 7]);
      expect((await post({ kind: "price_review", dueDate: "2027-03-01", leadTimesDays: [14] })).body.leadTimesDays).toEqual([14]);
      expect((await post({ kind: "expiry", dueDate: "not-a-date" })).status).toBe(400);
    });

    it("lists open deadlines across the company by due date and only for that company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const appA = createApp({ board: [companyA] });
      const appB = createApp({ board: [companyB] });
      const a = await createContract(appA, companyA);
      const b = await createContract(appB, companyB);
      await request(appA).post(`/api/companies/${companyA}/contracts/${a.id}/deadlines`).send({ kind: "expiry", dueDate: "2027-05-01" });
      await request(appA).post(`/api/companies/${companyA}/contracts/${a.id}/deadlines`).send({ kind: "payment", dueDate: "2026-12-01" });
      await request(appB).post(`/api/companies/${companyB}/contracts/${b.id}/deadlines`).send({ kind: "expiry", dueDate: "2026-11-01" });
      const list = await request(appA).get(`/api/companies/${companyA}/contract-deadlines?state=open&dueBefore=2027-12-31`);
      expect(list.body.map((d: { dueDate: string }) => d.dueDate)).toEqual(["2026-12-01", "2027-05-01"]);
      const narrow = await request(appA).get(`/api/companies/${companyA}/contract-deadlines?dueBefore=2026-12-01`);
      expect(narrow.body).toHaveLength(1);
    });

    it("makes reminders unique per (deadline, lead step)", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const deadline = await request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ kind: "notice_terminate", dueDate: "2027-03-01" });
      await db.insert(contractDeadlineReminders).values({ companyId, deadlineId: deadline.body.id, leadDays: 60 });
      await db.insert(contractDeadlineReminders).values({ companyId, deadlineId: deadline.body.id, leadDays: 30 });
      await expect(
        db.insert(contractDeadlineReminders).values({ companyId, deadlineId: deadline.body.id, leadDays: 60 }),
      ).rejects.toThrow();
    });
  });

  describe("terms and aggregate", () => {
    it("upserts one term per (contract, key) and clears fields the new kind does not carry", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      await setTerm(app, companyId, id, "free_shipping_threshold", { valueKind: "number", numberValue: 500, currency: "nok", clauseRef: "3.1", pageRef: "2" });
      const replaced = await setTerm(app, companyId, id, "free_shipping_threshold", { valueKind: "explicitly_none" });
      expect(replaced).toMatchObject({ valueKind: "explicitly_none", numberValue: null, currency: null, clauseRef: null });
      expect(await db.select().from(contractTerms)).toHaveLength(1);
    });

    it("rejects invalid term bodies and keys", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const put = (key: string, body: Record<string, unknown>) =>
        request(app).put(`/api/companies/${companyId}/contracts/${id}/terms/${key}`).send(body);
      expect((await put("liability_cap", { valueKind: "not_mentioned", numberValue: 0 })).status).toBe(400);
      expect((await put("liability_cap", { valueKind: "number" })).status).toBe(400);
      expect((await put("Liability Cap", { valueKind: "not_mentioned" })).status).toBe(400);
      expect((await put("custom_key_x", { valueKind: "text", textValue: "ok" })).status).toBe(200);
    });

    it("answers an aggregate with real numbers separated from not-mentioned, none and unrecorded", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const make = (title: string, extra: Record<string, unknown> = {}) => createContract(app, companyId, { title, type: "vendor_supplier", ...extra });
      const a = await make("A");
      const b = await make("B");
      const c = await make("C");
      const d = await make("D");
      const e = await make("E");
      const eur = await make("EUR vendor");
      const expired = await make("Old", { status: "expired" });
      const customer = await make("Customer", { type: "customer" });
      const key = "free_shipping_threshold";
      await setTerm(app, companyId, a.id, key, { valueKind: "number", numberValue: 500, currency: "NOK", clauseRef: "3.1" });
      await setTerm(app, companyId, b.id, key, { valueKind: "number", numberValue: 1500, currency: "NOK" });
      await setTerm(app, companyId, c.id, key, { valueKind: "not_mentioned" });
      await setTerm(app, companyId, d.id, key, { valueKind: "explicitly_none", clauseRef: "9" });
      await setTerm(app, companyId, eur.id, key, { valueKind: "number", numberValue: 100, currency: "EUR" });
      await setTerm(app, companyId, expired.id, key, { valueKind: "number", numberValue: 9999, currency: "NOK" });
      await setTerm(app, companyId, customer.id, key, { valueKind: "number", numberValue: 7777, currency: "NOK" });
      // e: never recorded.

      const res = await request(app).get(`/api/companies/${companyId}/contract-terms/${key}/aggregate?type=vendor_supplier&statuses=active`);
      expect(res.status).toBe(200);
      const nok = res.body.numeric.find((n: { currency: string }) => n.currency === "NOK");
      const euro = res.body.numeric.find((n: { currency: string }) => n.currency === "EUR");
      expect(nok).toMatchObject({ count: 2, avg: 1000, min: 500, max: 1500 });
      expect(nok.contracts).toEqual(expect.arrayContaining([{ contractId: a.id, clauseRef: "3.1" }]));
      expect(euro).toMatchObject({ count: 1, avg: 100 });
      expect(res.body.totalContracts).toBe(6);
      expect(res.body.notMentioned.contracts).toEqual([{ contractId: c.id, clauseRef: null }]);
      expect(res.body.explicitlyNone.contracts).toEqual([{ contractId: d.id, clauseRef: "9" }]);
      expect(res.body.noTermRecorded.contracts).toEqual([{ contractId: e.id, clauseRef: null }]);
      expect(res.body.withValue.count).toBe(3);

      // Default population: every status except superseded, every type.
      const wide = await request(app).get(`/api/companies/${companyId}/contract-terms/${key}/aggregate`);
      expect(wide.body.totalContracts).toBe(8);
      expect(wide.body.filters.statuses).not.toContain("superseded");
    });

    it("leaves superseded versions out of the default population so old versions never count twice", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const v1 = await createContract(app, companyId, { type: "vendor_supplier" });
      const v2 = await createContract(app, companyId, { type: "vendor_supplier" });
      await setTerm(app, companyId, v1.id, "payment_terms_days", { valueKind: "number", numberValue: 30 });
      await setTerm(app, companyId, v2.id, "payment_terms_days", { valueKind: "number", numberValue: 60 });
      await request(app)
        .post(`/api/companies/${companyId}/contracts/${v2.id}/link-previous-version`)
        .send({ previousContractId: v1.id, changeSummary: "terms", carryDeadlines: false });
      const res = await request(app).get(`/api/companies/${companyId}/contract-terms/payment_terms_days/aggregate`);
      expect(res.body.totalContracts).toBe(1);
      expect(res.body.numeric[0]).toMatchObject({ currency: null, count: 1, avg: 60 });
    });

    it("filters by party organisation without double counting a contract with two matching parties", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const [org] = await db.insert(crmOrganizations).values({ companyId, name: "Acme" }).returning();
      const withOrg = await createContract(app, companyId, {
        parties: [
          { organizationId: org.id, role: "vendor" },
          { organizationId: org.id, role: "landlord" },
        ],
      });
      await createContract(app, companyId);
      await setTerm(app, companyId, withOrg.id, "payment_terms_days", { valueKind: "number", numberValue: 14 });
      const res = await request(app).get(`/api/companies/${companyId}/contract-terms/payment_terms_days/aggregate?partyOrganizationId=${org.id}`);
      expect(res.body.totalContracts).toBe(1);
      expect(res.body.numeric[0]).toMatchObject({ count: 1, avg: 14 });
    });

    it("never counts another company's terms", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const appA = createApp({ board: [companyA] });
      const appB = createApp({ board: [companyB] });
      const a = await createContract(appA, companyA);
      const b = await createContract(appB, companyB);
      await setTerm(appA, companyA, a.id, "liability_cap", { valueKind: "number", numberValue: 100, currency: "NOK" });
      await setTerm(appB, companyB, b.id, "liability_cap", { valueKind: "number", numberValue: 900000, currency: "NOK" });
      const res = await request(appA).get(`/api/companies/${companyA}/contract-terms/liability_cap/aggregate`);
      expect(res.body.totalContracts).toBe(1);
      expect(res.body.numeric[0]).toMatchObject({ count: 1, avg: 100, max: 100 });
    });

    it("lists the registry keys plus free-form keys in use", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      await setTerm(app, companyId, id, "custom_clause_x", { valueKind: "not_mentioned" });
      const res = await request(app).get(`/api/companies/${companyId}/contract-terms`);
      expect(res.body.keys).toEqual(expect.arrayContaining(["free_shipping_threshold", "termination_for_convenience", "custom_clause_x"]));
    });
  });

  describe("parties", () => {
    it("adds, edits and removes a party, keeping the name/organisation rule", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const added = await request(app).post(`/api/companies/${companyId}/contracts/${id}/parties`).send({ name: "Acme AS", role: "vendor" });
      expect(added.status).toBe(201);
      expect((await request(app).post(`/api/companies/${companyId}/contracts/${id}/parties`).send({ role: "vendor" })).status).toBe(400);
      const edited = await request(app).patch(`/api/companies/${companyId}/contracts/${id}/parties/${added.body.id}`).send({ role: "landlord" });
      expect(edited.body.role).toBe("landlord");
      expect((await request(app).patch(`/api/companies/${companyId}/contracts/${id}/parties/${added.body.id}`).send({ name: null })).status).toBe(422);
      expect((await request(app).delete(`/api/companies/${companyId}/contracts/${id}/parties/${added.body.id}`)).status).toBe(200);
      expect((await request(app).delete(`/api/companies/${companyId}/contracts/${id}/parties/${added.body.id}`)).status).toBe(404);
    });
  });
  // Legal Phase 3 (DUR-4855): the deadline routes keep reminder issues in step.
  describe("deadline reminders", () => {
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const issuesOf = (deadlineId: string) =>
      db.select().from(issues).where(and(eq(issues.originKind, "contract_deadline"), eq(issues.originId, deadlineId)));

    it("defaults needsOwner to true for decision kinds and false for the rest, and lets the caller override", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const post = (body: Record<string, unknown>) =>
        request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ dueDate: inDays(400), ...body });
      expect((await post({ kind: "notice_extend" })).body.needsOwner).toBe(true);
      expect((await post({ kind: "notice_terminate" })).body.needsOwner).toBe(true);
      expect((await post({ kind: "renewal" })).body.needsOwner).toBe(true);
      expect((await post({ kind: "payment" })).body.needsOwner).toBe(false);
      expect((await post({ kind: "payment", needsOwner: true })).body.needsOwner).toBe(true);
      expect((await post({ kind: "notice_extend", needsOwner: false })).body.needsOwner).toBe(false);
    });

    it("opens the reminder as soon as a deadline inside its lead time is added, and closes it when done", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const added = await request(app)
        .post(`/api/companies/${companyId}/contracts/${id}/deadlines`)
        .send({ kind: "payment", dueDate: inDays(20) });
      const [reminder] = await issuesOf(added.body.id);
      expect(reminder).toMatchObject({ companyId, status: "todo", dueDate: inDays(20) });

      const done = await request(app)
        .patch(`/api/companies/${companyId}/contracts/${id}/deadlines/${added.body.id}`)
        .send({ state: "done" });
      expect(done.status).toBe(200);
      expect((await issuesOf(added.body.id))[0]!.status).toBe("cancelled");
    });

    it("moves the open reminder to the new date and closes it when the date moves out of range", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const added = await request(app)
        .post(`/api/companies/${companyId}/contracts/${id}/deadlines`)
        .send({ kind: "payment", dueDate: inDays(20) });
      const url = `/api/companies/${companyId}/contracts/${id}/deadlines/${added.body.id}`;
      await request(app).patch(url).send({ dueDate: inDays(25) });
      const [moved] = await issuesOf(added.body.id);
      expect(moved).toMatchObject({ status: "todo", dueDate: inDays(25) });
      await request(app).patch(url).send({ dueDate: inDays(300) });
      expect((await issuesOf(added.body.id)).map((i) => i.status)).toEqual(["cancelled"]);
    });

    it("closes the reminders of a deadline that is removed, and of a contract that is deleted", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const a = await request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ kind: "payment", dueDate: inDays(20) });
      const b = await request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ kind: "reporting", dueDate: inDays(20) });
      expect((await request(app).delete(`/api/companies/${companyId}/contracts/${id}/deadlines/${a.body.id}`)).status).toBe(200);
      expect((await issuesOf(a.body.id)).map((i) => i.status)).toEqual(["cancelled"]);
      expect((await request(app).delete(`/api/companies/${companyId}/contracts/${id}`)).status).toBe(200);
      expect((await issuesOf(b.body.id)).map((i) => i.status)).toEqual(["cancelled"]);
    });

    it("closes the reminders of a deadline superseded by a new version, and keeps a carried one", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const v1 = await createContract(app, companyId);
      const v2 = await createContract(app, companyId, { title: "Warehouse lease v2" });
      const dropped = await request(app).post(`/api/companies/${companyId}/contracts/${v1.id}/deadlines`).send({ kind: "payment", dueDate: inDays(20) });
      const res = await request(app)
        .post(`/api/companies/${companyId}/contracts/${v2.id}/link-previous-version`)
        .send({ previousContractId: v1.id, changeSummary: "x", carryDeadlines: false });
      expect(res.status).toBe(200);
      expect((await issuesOf(dropped.body.id)).map((i) => i.status)).toEqual(["cancelled"]);

      const v3 = await createContract(app, companyId, { title: "Warehouse lease v3" });
      const carried = await request(app).post(`/api/companies/${companyId}/contracts/${v2.id}/deadlines`).send({ kind: "payment", dueDate: inDays(20) });
      await request(app)
        .post(`/api/companies/${companyId}/contracts/${v3.id}/link-previous-version`)
        .send({ previousContractId: v2.id, changeSummary: "y", carryDeadlines: true });
      const [kept] = await issuesOf(carried.body.id);
      expect(kept!.status).toBe("todo");
      expect(kept!.description).toContain(v3.id);
    });

    it("reads and sets the company's default lead times, which new deadlines then use", async () => {
      const companyId = await seedCompany();
      const app = createApp({ board: [companyId] });
      const { id } = await createContract(app, companyId);
      const initial = await request(app).get(`/api/companies/${companyId}/contract-settings`);
      expect(initial.body).toMatchObject({
        noticeLeadTimesDays: null,
        effectiveNoticeLeadTimesDays: [60, 30, 7],
        effectiveOtherLeadTimesDays: [30, 7],
      });
      const set = await request(app)
        .patch(`/api/companies/${companyId}/contract-settings`)
        .send({ noticeLeadTimesDays: [90, 14], otherLeadTimesDays: [10] });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ effectiveNoticeLeadTimesDays: [90, 14], effectiveOtherLeadTimesDays: [10] });
      const notice = await request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ kind: "notice_extend", dueDate: inDays(400) });
      const other = await request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ kind: "payment", dueDate: inDays(400) });
      const own = await request(app).post(`/api/companies/${companyId}/contracts/${id}/deadlines`).send({ kind: "payment", dueDate: inDays(400), leadTimesDays: [3] });
      expect(notice.body.leadTimesDays).toEqual([90, 14]);
      expect(other.body.leadTimesDays).toEqual([10]);
      expect(own.body.leadTimesDays).toEqual([3]);
      // Clearing goes back to the built-in defaults.
      const cleared = await request(app).patch(`/api/companies/${companyId}/contract-settings`).send({ noticeLeadTimesDays: null });
      expect(cleared.body.effectiveNoticeLeadTimesDays).toEqual([60, 30, 7]);
      expect((await request(app).patch(`/api/companies/${companyId}/contract-settings`).send({ noticeLeadTimesDays: [] })).status).toBe(400);
      expect((await request(app).patch(`/api/companies/${companyId}/contract-settings`).send({ bogus: 1 })).status).toBe(400);
    });

    it("keeps the settings per company and board-only to change", async () => {
      const one = await seedCompany();
      const two = await seedCompany();
      const boardApp = createApp({ board: [one, two] });
      await request(boardApp).patch(`/api/companies/${one}/contract-settings`).send({ otherLeadTimesDays: [5] });
      expect((await request(boardApp).get(`/api/companies/${two}/contract-settings`)).body.otherLeadTimesDays).toBeNull();

      const legal = await seedAgent(one, { roleKey: "legal-advisor" });
      const agentApp = createApp({ agentId: legal, companyId: one });
      expect((await request(agentApp).get(`/api/companies/${one}/contract-settings`)).status).toBe(200);
      expect((await request(agentApp).patch(`/api/companies/${one}/contract-settings`).send({ otherLeadTimesDays: [1] })).status).toBe(403);
      const outsider = await seedAgent(one);
      expect((await request(createApp({ agentId: outsider, companyId: one })).get(`/api/companies/${one}/contract-settings`)).status).toBe(403);
      expect((await request(agentApp).get(`/api/companies/${two}/contract-settings`)).status).toBe(403);
    });
  });
});
