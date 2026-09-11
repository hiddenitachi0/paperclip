import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyServiceTokens, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  companyServiceTokenService,
  createCompanyServiceTokenValue,
} from "../services/company-service-tokens.ts";

/**
 * DUR-3977 acceptance item 2, the part that has to be right: a service token
 * is stored hashed, is never readable again, and belongs to exactly one
 * company.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres service token tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company service tokens", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("company-service-tokens");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(companyServiceTokens);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Nordstrand") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("stores only a hash — the token value is nowhere in the row", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "Nordstrand dashboard",
      createdByUserId: "user-1",
      scopes: ["lane_a:transform"],
    });

    const rows = await db.select().from(companyServiceTokens);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(created.token);
    expect(rows[0]!.tokenHash).not.toBe(created.token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never gives the token back once it has been created", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "Nordstrand dashboard",
      createdByUserId: "user-1",
      scopes: ["lane_a:transform"],
    });

    const listed = await companyServiceTokenService(db).listTokens(companyId);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("tokenHash");

    const fetched = await companyServiceTokenService(db).getTokenForCompany(created.id, companyId);
    expect(JSON.stringify(fetched)).not.toContain(created.token);
    expect(fetched).not.toHaveProperty("tokenHash");
  });

  it("authenticates a live token as its own company and nothing else", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const service = companyServiceTokenService(db);
    const tokenA = await service.createToken({ companyId: companyA, name: "A", createdByUserId: null, scopes: ["lane_a:transform"] });
    await service.createToken({ companyId: companyB, name: "B", createdByUserId: null, scopes: ["lane_a:transform"] });

    const resolved = await service.findByToken(tokenA.token);
    expect(resolved).toMatchObject({ id: tokenA.id, companyId: companyA });
    expect(resolved).not.toHaveProperty("tokenHash");
  });

  it("returns null for a revoked token — the same answer as for a token that never existed", async () => {
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({ companyId, name: "N", createdByUserId: null, scopes: ["lane_a:transform"] });

    await service.revokeToken({ tokenId: created.id, companyId, revokedByUserId: "user-1" });

    expect(await service.findByToken(created.token)).toBeNull();
    expect(await service.findByToken(createCompanyServiceTokenValue())).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({
      companyId,
      name: "N",
      createdByUserId: null,
      scopes: ["lane_a:transform"],
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await service.findByToken(created.token)).toBeNull();
  });

  it("refuses to revoke another company's token", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const service = companyServiceTokenService(db);
    const tokenA = await service.createToken({ companyId: companyA, name: "A", createdByUserId: null, scopes: ["lane_a:transform"] });

    // Company B's board user, holding A's token id.
    const revoked = await service.revokeToken({
      tokenId: tokenA.id,
      companyId: companyB,
      revokedByUserId: "user-b",
    });

    expect(revoked).toBeNull();
    // A's token still works.
    expect(await service.findByToken(tokenA.token)).toMatchObject({ companyId: companyA });
  });

  it("only lists the asking company's tokens", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const service = companyServiceTokenService(db);
    await service.createToken({ companyId: companyA, name: "A token", createdByUserId: null, scopes: ["lane_a:transform"] });
    await service.createToken({ companyId: companyB, name: "B token", createdByUserId: null, scopes: ["lane_a:transform"] });

    const listed = await service.listTokens(companyA);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("A token");
  });

  it("hides revoked tokens from the default listing but keeps them on request", async () => {
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({ companyId, name: "N", createdByUserId: null, scopes: ["lane_a:transform"] });
    await service.revokeToken({ tokenId: created.id, companyId, revokedByUserId: null });

    expect(await service.listTokens(companyId)).toHaveLength(0);
    expect(await service.listTokens(companyId, { includeInactive: true })).toHaveLength(1);
  });

  it("mints a recognisable, high-entropy token", () => {
    const token = createCompanyServiceTokenValue();
    expect(token).toMatch(/^pcp_service_[0-9a-f]{48}$/);
    expect(new Set(Array.from({ length: 50 }, () => createCompanyServiceTokenValue())).size).toBe(50);
  });

  it("ignores a bearer token that is not a service token at all", async () => {
    await seedCompany();
    expect(await companyServiceTokenService(db).findByToken("pcp_board_deadbeef")).toBeNull();
  });

  it("stores the scopes it was asked for, and hands them back on lookup", async () => {
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({
      companyId,
      name: "Nordstrand dashboard",
      createdByUserId: null,
      scopes: ["lane_a:transform"],
    });

    expect(created.scopes).toEqual(["lane_a:transform"]);
    expect(await service.findByToken(created.token)).toMatchObject({
      companyId,
      scopes: ["lane_a:transform"],
    });
    expect((await service.listTokens(companyId))[0]!.scopes).toEqual(["lane_a:transform"]);
  });

  it("drops a scope it does not recognise rather than storing it", async () => {
    // Normalisation happens on write AND on every read, so neither a bad
    // caller here nor a hand-edited row can widen what a token reaches.
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({
      companyId,
      name: "N",
      createdByUserId: null,
      scopes: ["lane_a:transform", "board:everything"] as never,
    });

    expect(created.scopes).toEqual(["lane_a:transform"]);
  });

  it("accepts a token with no scopes at all, which then reaches nothing", async () => {
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({
      companyId,
      name: "N",
      createdByUserId: null,
      scopes: [],
    });

    expect(created.scopes).toEqual([]);
    expect(await service.findByToken(created.token)).toMatchObject({ scopes: [] });
  });
});
