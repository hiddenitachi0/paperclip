import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
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
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { contractVersionLinkConfirmationKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  describeAggregateCoverage,
  extractSnippets,
  normalizePartyName,
  samePartiesForVersioning,
} from "../services/contracts.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let contractRoutes: typeof import("../routes/contracts.js").contractRoutes;

describe("contract agent-tool helpers (DUR-4856)", () => {
  it("treats legal forms and punctuation as the same party", () => {
    expect(normalizePartyName("Landlord A.S.")).toBe("landlord");
    expect(normalizePartyName("  LANDLORD AS ")).toBe("landlord");
    expect(normalizePartyName("Acme Ltd")).toBe(normalizePartyName("ACME"));
    expect(normalizePartyName("AS")).toBe("as");
  });

  it("needs more than our own company in common when both contracts list two or more parties", () => {
    const us = { organizationId: null, name: "Our Company AS" };
    const a = [us, { organizationId: null, name: "Landlord AS" }];
    expect(samePartiesForVersioning(a, [us, { organizationId: null, name: "Someone Else" }])).toBe(false);
    expect(samePartiesForVersioning(a, [{ organizationId: null, name: "landlord a.s." }, us])).toBe(true);
    // A single-party contract only needs that one party in common.
    expect(samePartiesForVersioning([{ organizationId: null, name: "Landlord AS" }], a)).toBe(true);
    expect(samePartiesForVersioning([], a)).toBe(false);
    const org = randomUUID();
    expect(
      samePartiesForVersioning([{ organizationId: org, name: null }], [{ organizationId: org, name: "Renamed" }]),
    ).toBe(true);
  });

  it("cuts a few short windows of text around a match, case-insensitively", () => {
    const text = `${"x".repeat(400)} Payment is due in 30 days. ${"y".repeat(400)} payment again ${"z".repeat(50)}`;
    const snippets = extractSnippets(text, "PAYMENT", 3, 20);
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toContain("Payment is due");
    expect(snippets.every((snippet) => snippet.length < 120)).toBe(true);
    expect(extractSnippets("nothing here", "payment")).toEqual([]);
  });

  it("always states the coverage next to an average and lists who is left out", () => {
    const ref = (contractId: string, clauseRef: string | null = null) => ({ contractId, clauseRef });
    const text = describeAggregateCoverage(
      {
        key: "free_shipping_threshold",
        filters: { type: "vendor_supplier", statuses: ["active"], partyOrganizationId: null },
        totalContracts: 5,
        numeric: [{ currency: "NOK", count: 2, avg: 450, min: 300, max: 600, contracts: [ref("a", "4.1"), ref("b", "2")] }],
        withValue: { count: 2, contracts: [ref("a", "4.1"), ref("b", "2")] },
        notMentioned: { count: 1, contracts: [ref("c")] },
        explicitlyNone: { count: 1, contracts: [ref("d", "7.3")] },
        noTermRecorded: { count: 1, contracts: [ref("e")] },
        malformed: { count: 0, contracts: [] },
      },
      { a: "Alpha deal", b: "Beta deal", c: "Gamma deal", d: "Delta deal", e: "Epsilon deal" },
    );
    expect(text).toContain("across 5 contract(s)");
    expect(text).toContain("2 contract(s) with a number in NOK: average 450 NOK");
    expect(text).toContain("Only these 2 are in the average: Alpha deal (4.1); Beta deal (2)");
    expect(text).toContain("1 contract(s) read and do not mention it: Gamma deal");
    expect(text).toContain("1 contract(s) state explicitly that there is none: Delta deal (7.3)");
    expect(text).toContain("1 contract(s) not checked yet");
    expect(text).toContain("Epsilon deal");
    expect(text).not.toContain("malformed");
  });

  it("says plainly when there is nothing to average", () => {
    const text = describeAggregateCoverage(
      {
        key: "liability_cap",
        filters: { type: null, statuses: ["active"], partyOrganizationId: null },
        totalContracts: 1,
        numeric: [],
        withValue: { count: 0, contracts: [] },
        notMentioned: { count: 1, contracts: [{ contractId: "a", clauseRef: null }] },
        explicitlyNone: { count: 0, contracts: [] },
        noTermRecorded: { count: 0, contracts: [] },
        malformed: { count: 0, contracts: [] },
      },
      { a: "Alpha" },
    );
    expect(text).toContain("no average");
    expect(text).not.toMatch(/average \d/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres contract agent-tool tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Legal Phase 4 (DUR-4856): the server side of the agent tools -- one-call
// intake, find, related-version detection, text search, the coverage report,
// and above all that an agent can never link a version without a card a board
// member accepted for exactly that pair.
describeEmbeddedPostgres("contract register agent tools (DUR-4856)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-contracts-tools-");
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
    await db.delete(issueThreadInteractions);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(contractDeadlineReminders);
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
  });

  type Who = { board: string[] } | { agentId: string; companyId: string };

  function createApp(who: Who) {
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
              memberships: who.board.map((companyId) => ({ companyId, status: "active", membershipRole: "owner" })),
            };
      next();
    });
    app.use("/api", contractRoutes(db));
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

  async function seedAgent(companyId: string, roleKey?: string) {
    let roleId: string | null = null;
    if (roleKey) {
      roleId = randomUUID();
      await db.insert(companyAgentRoles).values({ id: roleId, companyId, name: roleKey, key: roleKey });
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

  async function seedLegalAgent(companyId: string) {
    const agentId = await seedAgent(companyId, "legal-advisor");
    return { agentId, app: createApp({ agentId, companyId }) };
  }

  async function register(app: express.Express, companyId: string, body: Record<string, unknown>) {
    const res = await request(app).post(`/api/companies/${companyId}/contracts/register`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function seedIssue(companyId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Register the lease", status: "in_progress", priority: "medium" });
    return issueId;
  }

  async function seedConfirmation(
    companyId: string,
    issueId: string,
    agentId: string,
    opts: {
      key: string | null;
      status?: string;
      kind?: string;
      resolvedByUserId?: string | null;
      resolvedByAgentId?: string | null;
      result?: Record<string, unknown> | null;
    },
  ) {
    const [row] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId,
        kind: opts.kind ?? "request_confirmation",
        status: opts.status ?? "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        createdByAgentId: agentId,
        resolvedByUserId: opts.resolvedByUserId === undefined ? "board-user-1" : opts.resolvedByUserId,
        resolvedByAgentId: opts.resolvedByAgentId ?? null,
        resolvedAt: new Date(),
        result: (opts.result ?? undefined) as any,
        payload: {
          version: 1,
          prompt: "Is this a renegotiated version?",
          target: opts.key ? { type: "custom", key: opts.key } : null,
        } as any,
      })
      .returning();
    return row!.id;
  }

  describe("who may use the tools", () => {
    it("refuses every new route for an agent without the Legal position or a grant, and for another company's Legal agent", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const { app: legal } = await seedLegalAgent(companyId);
      const created = await register(legal, companyId, { title: "SECRET-TITLE lease", type: "rental_lease" });

      const plain = createApp({ agentId: await seedAgent(companyId), companyId });
      const outsider = createApp({ agentId: await seedAgent(otherCompany, "legal-advisor"), companyId: otherCompany });
      const base = `/api/companies/${companyId}`;
      for (const app of [plain, outsider]) {
        const responses = [
          await request(app).post(`${base}/contracts/register`).send({ title: "x", type: "nda" }),
          await request(app).get(`${base}/contracts/find?q=lease`),
          await request(app).get(`${base}/contracts/search-text?q=lease`),
          await request(app).get(`${base}/contracts/${created.id}/related`),
          await request(app).get(`${base}/contract-terms/payment_terms_days/aggregate?report=true`),
          await request(app)
            .post(`${base}/contracts/${created.id}/link-previous-version`)
            .send({ previousContractId: randomUUID(), changeSummary: "x", carryDeadlines: true }),
        ];
        for (const res of responses) {
          expect(res.status).toBe(403);
          expect(JSON.stringify(res.body)).not.toContain("SECRET-TITLE");
        }
      }
      expect(await db.select().from(contracts)).toHaveLength(1);
    });
  });

  describe("register_contract (one-call intake)", () => {
    it("saves the contract, parties, terms with clause refs and deadlines together", async () => {
      const companyId = await seedCompany();
      const { agentId, app } = await seedLegalAgent(companyId);
      const created = await request(app)
        .post(`/api/companies/${companyId}/contracts/register`)
        .send({
          title: "Warehouse lease",
          type: "rental_lease",
          status: "active",
          governingLaw: "Norway",
          parties: [
            { name: "Landlord AS", role: "landlord" },
            { name: "Our Company AS", role: "tenant" },
          ],
          terms: [
            { key: "notice_period_days", valueKind: "number", numberValue: 90, clauseRef: "12.1", pageRef: "7" },
            { key: "liability_cap", valueKind: "explicitly_none", clauseRef: "15" },
            { key: "price_indexation", valueKind: "not_mentioned" },
          ],
          deadlines: [{ kind: "notice_terminate", dueDate: "2027-03-31", clauseRef: "12.1" }],
        });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ partyCount: 2, termCount: 3, deadlineCount: 1, createdByAgentId: agentId });
      expect(created.body.extractedText).toBeUndefined();

      const full = await request(app).get(`/api/companies/${companyId}/contracts/${created.body.id}`);
      expect(full.body.terms.map((t: any) => [t.key, t.valueKind, t.clauseRef])).toEqual([
        ["liability_cap", "explicitly_none", "15"],
        ["notice_period_days", "number", "12.1"],
        ["price_indexation", "not_mentioned", null],
      ]);
      expect(full.body.deadlines).toMatchObject([{ kind: "notice_terminate", leadTimesDays: [60, 30, 7], state: "open" }]);
      expect(full.body.parties).toHaveLength(2);
    });

    it("saves nothing when any part is refused", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      const [foreignAsset] = await db
        .insert(assets)
        .values({ companyId: otherCompany, provider: "local_disk", objectKey: "k", contentType: "application/pdf", byteSize: 1, sha256: "s" })
        .returning();
      const base = `/api/companies/${companyId}/contracts/register`;

      const duplicateKeys = await request(app)
        .post(base)
        .send({
          title: "T",
          type: "nda",
          terms: [
            { key: "governing_law", valueKind: "text", textValue: "Norway" },
            { key: "governing_law", valueKind: "text", textValue: "Sweden" },
          ],
        });
      expect(duplicateKeys.status).toBe(400);

      const zeroForNotMentioned = await request(app)
        .post(base)
        .send({ title: "T", type: "nda", terms: [{ key: "liability_cap", valueKind: "not_mentioned", numberValue: 0 }] });
      expect(zeroForNotMentioned.status).toBe(400);

      const foreign = await request(app).post(base).send({ title: "T", type: "nda", assetId: foreignAsset!.id });
      expect(foreign.status).toBe(422);

      expect(await db.select().from(contracts)).toHaveLength(0);
      expect(await db.select().from(contractTerms)).toHaveLength(0);
    });

    it("writes only ids, enums and counts to the activity log", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      await register(app, companyId, {
        title: "TITLE-MARKER",
        type: "customer",
        summary: "SUMMARY-MARKER",
        extractedText: "TEXT-MARKER shipping clause",
        textStatus: "extracted",
        parties: [{ name: "PARTY-MARKER", role: "customer" }],
        terms: [{ key: "price_indexation", valueKind: "text", textValue: "TERM-MARKER", clauseRef: "CLAUSE-MARKER" }],
        deadlines: [{ kind: "renewal", dueDate: "2027-01-01", note: "NOTE-MARKER" }],
      });
      await request(app).get(`/api/companies/${companyId}/contracts/search-text?q=SEARCH-QUERY-MARKER`);
      await request(app).get(`/api/companies/${companyId}/contracts/search-text?q=shipping`);

      const rows = await db.select().from(activityLog);
      expect(rows.map((row) => row.action).sort()).toEqual([
        "contract.registered",
        "contract.text_searched",
        "contract.text_searched",
      ]);
      const dump = JSON.stringify(rows);
      for (const marker of ["TITLE-MARKER", "SUMMARY-MARKER", "TEXT-MARKER", "PARTY-MARKER", "TERM-MARKER", "CLAUSE-MARKER", "NOTE-MARKER", "SEARCH-QUERY-MARKER", "shipping"]) {
        expect(dump).not.toContain(marker);
      }
    });
  });

  describe("find_contract", () => {
    it("finds by title, party and type, tolerates a typo, hides replaced versions and links the file without text", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      const [org] = await db.insert(crmOrganizations).values({ companyId, name: "Fjordfrakt AS" }).returning();
      const [asset] = await db
        .insert(assets)
        .values({ companyId, provider: "local_disk", objectKey: "lease.pdf", contentType: "application/pdf", byteSize: 10, sha256: "s", originalFilename: "lease.pdf" })
        .returning();
      const lease = await register(app, companyId, {
        title: "Warehouse lease Oslo",
        type: "rental_lease",
        summary: "Ten year lease",
        extractedText: "NEVER-RETURNED-TEXT",
        assetId: asset!.id,
        parties: [{ organizationId: org!.id, role: "landlord" }],
      });
      await register(app, companyId, { title: "Cleaning services", type: "service", parties: [{ name: "Rent-a-Mop", role: "vendor" }] });
      const find = (qs: string) => request(app).get(`/api/companies/${companyId}/contracts/find?${qs}`);

      const byTitle = await find("q=warehouse");
      expect(byTitle.body.contracts.map((c: any) => c.id)).toEqual([lease.id]);
      expect(byTitle.body.contracts[0].file).toEqual({
        assetId: asset!.id,
        contentPath: `/api/assets/${asset!.id}/content`,
        filename: "lease.pdf",
        contentType: "application/pdf",
      });
      expect(JSON.stringify(byTitle.body)).not.toContain("NEVER-RETURNED-TEXT");

      expect((await find("q=warehous%20oslo")).body.contracts[0].id).toBe(lease.id); // prefix
      expect((await find("q=wharehouse")).body.contracts[0].id).toBe(lease.id); // typo
      expect((await find("party=fjordfrakt")).body.contracts.map((c: any) => c.id)).toEqual([lease.id]); // CRM org name
      expect((await find("type=service")).body.contracts.map((c: any) => c.title)).toEqual(["Cleaning services"]);
      expect((await find("q=zzzz")).body.contracts).toEqual([]);
      expect((await find("q=")).status).toBe(400); // an empty search is a mistake, not "everything"

      const v2 = await register(app, companyId, { title: "Warehouse lease Oslo v2", type: "rental_lease" });
      await request(createApp({ board: [companyId] }))
        .post(`/api/companies/${companyId}/contracts/${v2.id}/link-previous-version`)
        .send({ previousContractId: lease.id, changeSummary: "x", carryDeadlines: false });
      expect((await find("q=warehouse")).body.contracts.map((c: any) => c.id)).toEqual([v2.id]);
      expect((await find("q=warehouse&includeSuperseded=true")).body.contracts).toHaveLength(2);
    });

    it("never returns another company's contracts", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const { app: appA } = await seedLegalAgent(companyA);
      const { app: appB } = await seedLegalAgent(companyB);
      await register(appB, companyB, { title: "Nordstrand lease", type: "rental_lease" });
      const res = await request(appA).get(`/api/companies/${companyA}/contracts/find?q=nordstrand`);
      expect(res.body.contracts).toEqual([]);
    });
  });

  describe("find_related_contracts", () => {
    it("suggests an older contract with the same type and parties, or one named in the text, and nothing else", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      const us = { name: "Our Company AS", role: "tenant" };
      const old = await register(app, companyId, {
        title: "Warehouse lease 2022",
        type: "rental_lease",
        status: "active",
        parties: [{ name: "Landlord AS", role: "landlord" }, us],
      });
      const otherType = await register(app, companyId, {
        title: "Landlord framework agreement",
        type: "service",
        status: "active",
        parties: [{ name: "Landlord AS", role: "landlord" }, us],
      });
      const otherLandlord = await register(app, companyId, {
        title: "Office lease",
        type: "rental_lease",
        status: "active",
        parties: [{ name: "Someone Else", role: "landlord" }, us],
      });
      const named = await register(app, companyId, { title: "Side letter on parking", type: "other", status: "active" });
      const current = await register(app, companyId, {
        title: "Warehouse lease 2025",
        type: "rental_lease",
        parties: [{ name: "landlord a.s.", role: "landlord" }, us],
        extractedText: "This agreement replaces the Side letter on parking dated 2023.",
        textStatus: "extracted",
      });

      const res = await request(app).get(`/api/companies/${companyId}/contracts/${current.id}/related`);
      expect(res.status).toBe(200);
      expect(res.body.alreadyHasPreviousVersion).toBe(false);
      const byId = Object.fromEntries(res.body.candidates.map((c: any) => [c.id, c.reasons]));
      expect(byId).toEqual({
        [old.id]: ["same_parties_and_type"],
        [named.id]: ["named_in_contract_text"],
      });
      expect(byId[otherType.id]).toBeUndefined();
      expect(byId[otherLandlord.id]).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain("replaces the");
    });

    it("leaves out replaced versions and the contract's own successors, and reports an existing previous version", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      const board = createApp({ board: [companyId] });
      const parties = [{ name: "Landlord AS", role: "landlord" }, { name: "Our Company AS", role: "tenant" }];
      const v1 = await register(app, companyId, { title: "Lease v1", type: "rental_lease", status: "active", parties });
      const v2 = await register(app, companyId, { title: "Lease v2", type: "rental_lease", status: "active", parties });
      await request(board)
        .post(`/api/companies/${companyId}/contracts/${v2.id}/link-previous-version`)
        .send({ previousContractId: v1.id, changeSummary: "x", carryDeadlines: false });
      const v3 = await register(app, companyId, { title: "Lease v3", type: "rental_lease", status: "active", parties });

      const forV3 = await request(app).get(`/api/companies/${companyId}/contracts/${v3.id}/related`);
      expect(forV3.body.candidates.map((c: any) => c.id)).toEqual([v2.id]); // v1 is replaced already

      const forV2 = await request(app).get(`/api/companies/${companyId}/contracts/${v2.id}/related`);
      expect(forV2.body).toMatchObject({ alreadyHasPreviousVersion: true, candidates: [] });

      const forV1 = await request(app).get(`/api/companies/${companyId}/contracts/${v1.id}/related`);
      expect(forV1.body.candidates).toEqual([]); // v1 is superseded itself
      expect((await request(app).get(`/api/companies/${companyId}/contracts/${randomUUID()}/related`)).status).toBe(404);
    });
  });

  describe("link_contract_version needs a board-accepted confirmation from an agent", () => {
    async function setup() {
      const companyId = await seedCompany();
      const { agentId, app } = await seedLegalAgent(companyId);
      const parties = [{ name: "Landlord AS", role: "landlord" }];
      const oldC = await register(app, companyId, {
        title: "Lease 2022",
        type: "rental_lease",
        status: "active",
        parties,
        deadlines: [{ kind: "renewal", dueDate: "2027-05-01" }],
      });
      const newC = await register(app, companyId, { title: "Lease 2025", type: "rental_lease", parties });
      const issueId = await seedIssue(companyId);
      const key = contractVersionLinkConfirmationKey(newC.id, oldC.id);
      const link = (body: Record<string, unknown> = {}) =>
        request(app)
          .post(`/api/companies/${companyId}/contracts/${newC.id}/link-previous-version`)
          .send({ previousContractId: oldC.id, changeSummary: "Rent +3%", carryDeadlines: true, ...body });
      return { companyId, agentId, app, oldC, newC, issueId, key, link };
    }

    async function expectNotLinked(oldId: string, newId: string) {
      const rows = await db.select().from(contracts);
      expect(rows.find((row) => row.id === newId)!.supersedesContractId).toBeNull();
      expect(rows.find((row) => row.id === oldId)!.status).toBe("active");
    }

    it("refuses an agent without a confirmation id", async () => {
      const { oldC, newC, link, key } = await setup();
      const res = await link();
      expect(res.status).toBe(403);
      expect(res.body.error).toContain(key); // tells the agent exactly what to ask for
      await expectNotLinked(oldC.id, newC.id);
    });

    it("refuses a card that is pending, rejected, expired or the wrong kind", async () => {
      const { companyId, agentId, oldC, newC, issueId, key, link } = await setup();
      for (const opts of [
        { status: "pending", resolvedByUserId: null },
        { status: "rejected" },
        { status: "expired" },
        { kind: "request_checkbox_confirmation" },
        { kind: "ask_user_questions" },
      ]) {
        const id = await seedConfirmation(companyId, issueId, agentId, { key, ...opts });
        const res = await link({ confirmationInteractionId: id });
        expect(res.status, JSON.stringify(opts)).toBe(403);
      }
      await expectNotLinked(oldC.id, newC.id);
    });

    it("refuses a card the agent resolved itself, or one with no person who resolved it", async () => {
      const { companyId, agentId, oldC, newC, issueId, key, link } = await setup();
      const selfResolved = await seedConfirmation(companyId, issueId, agentId, {
        key,
        resolvedByUserId: null,
        resolvedByAgentId: agentId,
      });
      expect((await link({ confirmationInteractionId: selfResolved })).status).toBe(403);
      const nobody = await seedConfirmation(companyId, issueId, agentId, { key, resolvedByUserId: null });
      expect((await link({ confirmationInteractionId: nobody })).status).toBe(403);
      await expectNotLinked(oldC.id, newC.id);
    });

    it("refuses a card an agent linked to an ordinary approval, once the operator approves that other card", async () => {
      const { companyId, agentId, oldC, newC, issueId, key, link } = await setup();
      const [approval] = await db
        .insert(approvals)
        .values({ companyId, type: "approve_ceo_strategy", status: "pending", payload: { plan: "Q4 strategy" } })
        .returning();
      // The agent files the confirmation through the real service, linked to an unrelated waiting approval.
      const interactionsSvc = issueThreadInteractionService(db);
      const card = await interactionsSvc.create(
        { id: issueId, companyId },
        {
          kind: "request_confirmation",
          payload: { version: 1, prompt: "Is this a renegotiated version?", target: { type: "custom", key } },
          linkedApprovalId: approval!.id,
        } as Parameters<typeof interactionsSvc.create>[1],
        { agentId, userId: null },
      );
      expect(card.linkedApprovalId).toBe(approval!.id);

      // The operator approves the other card; the service closes the linked confirmation as accepted by them.
      await db
        .update(approvals)
        .set({ status: "approved", decidedByUserId: "board-user-1", decidedAt: new Date() })
        .where(eq(approvals.id, approval!.id));
      const resolved = await interactionsSvc.resolveInteractionsLinkedToApproval(
        { id: approval!.id, companyId, status: "approved" },
        { userId: "board-user-1" },
      );
      expect(resolved.map((row) => row.id)).toEqual([card.id]);
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored).toMatchObject({ status: "accepted", resolvedByUserId: "board-user-1", resolvedByAgentId: null });

      expect((await link({ confirmationInteractionId: card.id })).status).toBe(403);
      await expectNotLinked(oldC.id, newC.id);
      const deadlines = await db.select().from(contractDeadlines).where(eq(contractDeadlines.contractId, oldC.id));
      expect(deadlines.map((row) => row.state)).toEqual(["open"]);
    });

    it("refuses an accepted card that was closed automatically, which always carries a reason", async () => {
      const { companyId, agentId, oldC, newC, issueId, key, link } = await setup();
      const autoClosed = await seedConfirmation(companyId, issueId, agentId, {
        key,
        result: { version: 1, outcome: "accepted", reason: "Closed automatically: the linked board approval was approved." },
      });
      expect((await link({ confirmationInteractionId: autoClosed })).status).toBe(403);
      await expectNotLinked(oldC.id, newC.id);
    });

    it("refuses a card for another pair, with no target, or from another company", async () => {
      const { companyId, agentId, oldC, newC, issueId, link } = await setup();
      const third = await register(createApp({ board: [companyId] }), companyId, { title: "Third", type: "rental_lease" });
      const wrongPair = await seedConfirmation(companyId, issueId, agentId, {
        key: contractVersionLinkConfirmationKey(newC.id, third.id),
      });
      const reversed = await seedConfirmation(companyId, issueId, agentId, {
        key: contractVersionLinkConfirmationKey(oldC.id, newC.id),
      });
      const noTarget = await seedConfirmation(companyId, issueId, agentId, { key: null });
      expect((await link({ confirmationInteractionId: wrongPair })).status).toBe(403);
      expect((await link({ confirmationInteractionId: reversed })).status).toBe(403);
      expect((await link({ confirmationInteractionId: noTarget })).status).toBe(403);
      expect((await link({ confirmationInteractionId: randomUUID() })).status).toBe(403);

      const otherCompany = await seedCompany();
      const otherAgent = await seedAgent(otherCompany);
      const otherIssue = await seedIssue(otherCompany);
      const foreignCard = await seedConfirmation(otherCompany, otherIssue, otherAgent, {
        key: contractVersionLinkConfirmationKey(newC.id, oldC.id),
      });
      expect((await link({ confirmationInteractionId: foreignCard })).status).toBe(403);
      await expectNotLinked(oldC.id, newC.id);
    });

    it("links after a board member accepted the card for exactly this pair, once", async () => {
      const { companyId, agentId, app, oldC, newC, issueId, key, link } = await setup();
      const accepted = await seedConfirmation(companyId, issueId, agentId, { key });
      const res = await link({ confirmationInteractionId: accepted });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ versionNo: 2, previousContractId: oldC.id, movedDeadlines: 1 });

      const next = await request(app).get(`/api/companies/${companyId}/contracts/${newC.id}`);
      expect(next.body).toMatchObject({ supersedesContractId: oldC.id, changeSummary: "Rent +3%", versionNo: 2 });
      expect(next.body.deadlines).toHaveLength(1);

      const logged = (await db.select().from(activityLog)).find((row) => row.action === "contract.version_linked");
      expect(logged?.details).toMatchObject({ confirmationInteractionId: accepted, previousContractId: oldC.id });
      expect(JSON.stringify(logged?.details)).not.toContain("Rent +3%");

      // The same card cannot be replayed to relink or fork.
      expect((await link({ confirmationInteractionId: accepted })).status).toBe(409);
    });

    it("lets a board member link directly, because they are the person", async () => {
      const { companyId, oldC, newC } = await setup();
      const res = await request(createApp({ board: [companyId] }))
        .post(`/api/companies/${companyId}/contracts/${newC.id}/link-previous-version`)
        .send({ previousContractId: oldC.id, changeSummary: "x", carryDeadlines: false });
      expect(res.status).toBe(200);
    });
  });

  describe("aggregate_term coverage report", () => {
    it("adds titles and a plain-words coverage that never averages what is not stated", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      const mk = (title: string, term: Record<string, unknown> | null) =>
        register(app, companyId, {
          title,
          type: "vendor_supplier",
          status: "active",
          terms: term ? [{ key: "free_shipping_threshold", ...term }] : [],
        });
      await mk("Alpha", { valueKind: "number", numberValue: 300, currency: "NOK", clauseRef: "4.1" });
      await mk("Beta", { valueKind: "number", numberValue: 600, currency: "NOK", clauseRef: "2" });
      await mk("Gamma", { valueKind: "not_mentioned" });
      await mk("Delta", { valueKind: "explicitly_none", clauseRef: "7.3" });
      await mk("Epsilon", null);

      const res = await request(app).get(`/api/companies/${companyId}/contract-terms/free_shipping_threshold/aggregate?report=true`);
      expect(res.status).toBe(200);
      expect(res.body.totalContracts).toBe(5);
      expect(res.body.numeric).toMatchObject([{ currency: "NOK", count: 2, avg: 450, min: 300, max: 600 }]);
      expect(res.body.notMentioned.count).toBe(1);
      expect(res.body.explicitlyNone.count).toBe(1);
      expect(res.body.noTermRecorded.count).toBe(1);
      expect(Object.values(res.body.contractTitles).sort()).toEqual(["Alpha", "Beta", "Delta", "Epsilon", "Gamma"]);
      expect(res.body.coverageText).toContain("Only these 2 are in the average: Alpha (4.1); Beta (2)");
      expect(res.body.coverageText).toContain("do not mention it: Gamma");
      expect(res.body.coverageText).toContain("explicitly that there is none: Delta (7.3)");
      expect(res.body.coverageText).toContain("not checked yet");
      expect(res.body.coverageText).toContain("Epsilon");

      // Without the flag the plain aggregate is unchanged (no titles).
      const plain = await request(app).get(`/api/companies/${companyId}/contract-terms/free_shipping_threshold/aggregate`);
      expect(plain.body.contractTitles).toBeUndefined();
      expect(plain.body.totalContracts).toBe(5);
    });

    it("does not count another company's contracts or leak its titles", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const { app: appA } = await seedLegalAgent(companyA);
      const { app: appB } = await seedLegalAgent(companyB);
      await register(appB, companyB, {
        title: "NORDSTRAND-SECRET",
        type: "vendor_supplier",
        status: "active",
        terms: [{ key: "payment_terms_days", valueKind: "number", numberValue: 14 }],
      });
      const res = await request(appA).get(`/api/companies/${companyA}/contract-terms/payment_terms_days/aggregate?report=true`);
      expect(res.body.totalContracts).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain("NORDSTRAND-SECRET");
    });
  });

  describe("search_contract_text", () => {
    it("returns short snippets, says which contracts have no readable text, and skips replaced versions", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      const filler = "lorem ipsum ".repeat(60);
      const hit = await register(app, companyId, {
        title: "Supplier A",
        type: "vendor_supplier",
        status: "active",
        extractedText: `${filler} Free shipping applies above NOK 500. ${filler}`,
        textStatus: "extracted",
      });
      await register(app, companyId, {
        title: "Supplier B",
        type: "vendor_supplier",
        status: "active",
        extractedText: `${filler} Nothing relevant. ${filler}`,
        textStatus: "extracted",
      });
      const scanned = await register(app, companyId, { title: "Scanned C", type: "vendor_supplier", status: "active", textStatus: "no_text_layer" });
      const old = await register(app, companyId, {
        title: "Supplier A old",
        type: "vendor_supplier",
        status: "active",
        extractedText: "Free shipping applies above NOK 100.",
        textStatus: "extracted",
      });
      await request(createApp({ board: [companyId] }))
        .post(`/api/companies/${companyId}/contracts/${hit.id}/link-previous-version`)
        .send({ previousContractId: old.id, changeSummary: "x", carryDeadlines: false });

      const res = await request(app).get(`/api/companies/${companyId}/contracts/search-text?q=FREE%20SHIPPING`);
      expect(res.status).toBe(200);
      expect(res.body.matches).toHaveLength(1);
      expect(res.body.matches[0]).toMatchObject({ contractId: hit.id, title: "Supplier A" });
      expect(res.body.matches[0].snippets[0]).toContain("Free shipping applies above NOK 500");
      expect(res.body.matches[0].snippets[0].length).toBeLessThan(400);
      expect(res.body.contractsInScope).toBe(3);
      expect(res.body.withExtractedText).toBe(2);
      expect(res.body.withoutExtractedText).toEqual([{ contractId: scanned.id, title: "Scanned C", textStatus: "no_text_layer" }]);
      expect(res.body.moreMatchesThanShown).toBe(false);
    });

    it("treats % and _ in the query as plain characters and validates the query", async () => {
      const companyId = await seedCompany();
      const { app } = await seedLegalAgent(companyId);
      await register(app, companyId, { title: "A", type: "nda", extractedText: "a discount of 10% applies", textStatus: "extracted" });
      await register(app, companyId, { title: "B", type: "nda", extractedText: "a discount of 10 days", textStatus: "extracted" });
      const get = (q: string) => request(app).get(`/api/companies/${companyId}/contracts/search-text?q=${encodeURIComponent(q)}`);
      expect((await get("10%")).body.matches.map((m: any) => m.title)).toEqual(["A"]);
      expect((await get("%%")).body.matches).toEqual([]); // not a wildcard
      expect((await get("10_")).body.matches).toEqual([]); // "_" is not "any one character"
      expect((await get("a")).status).toBe(400); // too short to be useful
      expect((await request(app).get(`/api/companies/${companyId}/contracts/search-text`)).status).toBe(400);
    });

    it("keeps one company's text out of another company's search", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const { app: appA } = await seedLegalAgent(companyA);
      const { app: appB } = await seedLegalAgent(companyB);
      await register(appB, companyB, { title: "B only", type: "nda", extractedText: "confidential nordstrand clause", textStatus: "extracted" });
      const res = await request(appA).get(`/api/companies/${companyA}/contracts/search-text?q=nordstrand`);
      expect(res.body.matches).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain("confidential");
    });
  });
});
