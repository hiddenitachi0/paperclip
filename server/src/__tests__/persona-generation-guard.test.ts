import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, personas } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { personaGenerationGuard } from "../services/persona-generation-guard.ts";

// DUR-177 item 18: personaGenerationGuard.reserve() gates the daily
// image-generation cap with a single conditional UPDATE (see the top-of-file
// comment in ../services/persona-generation-guard.ts). This is the actual
// atomic-reservation logic the route-level tests in
// plugin-routes-authz.test.ts mock out entirely -- this suite exercises it
// against a real Postgres instance, including a concurrent race, so the
// "Postgres serializes concurrent UPDATEs to the same row" claim is checked
// rather than assumed.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres persona-generation-guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("personaGenerationGuard", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let guard!: ReturnType<typeof personaGenerationGuard>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("persona-generation-guard");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    guard = personaGenerationGuard(db);
  });

  afterEach(async () => {
    await db.delete(personas);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedPersona(opts: { dailyGenerationCap: number | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maja",
      role: "persona",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [persona] = await db
      .insert(personas)
      .values({
        companyId,
        agentId,
        handle: "@maja",
        status: "active",
        dailyGenerationCap: opts.dailyGenerationCap,
      })
      .returning();
    return { companyId, agentId, personaId: persona!.id };
  }

  it("is a no-op passthrough for an agent with no personas row", async () => {
    const reservation = await guard.reserve(randomUUID());
    expect(reservation).toEqual({ allowed: true, personaId: null, countToday: 0, cap: null });
  });

  it("is a no-op passthrough for a persona with no cap set (DUR-63: opt-in, no global default)", async () => {
    const { agentId } = await seedPersona({ dailyGenerationCap: null });
    const reservation = await guard.reserve(agentId);
    expect(reservation).toEqual({ allowed: true, personaId: expect.any(String), countToday: 0, cap: null });
  });

  it("allows exactly `cap` reservations sequentially, then blocks the next one", async () => {
    const { agentId, personaId } = await seedPersona({ dailyGenerationCap: 2 });

    const first = await guard.reserve(agentId);
    expect(first).toMatchObject({ allowed: true, personaId, countToday: 1, cap: 2 });

    const second = await guard.reserve(agentId);
    expect(second).toMatchObject({ allowed: true, personaId, countToday: 2, cap: 2 });

    const third = await guard.reserve(agentId);
    expect(third).toMatchObject({ allowed: false, personaId, countToday: 2, cap: 2 });
  });

  it("rejects a persona with a non-positive cap outright", async () => {
    const { agentId, personaId } = await seedPersona({ dailyGenerationCap: 0 });
    const reservation = await guard.reserve(agentId);
    expect(reservation).toEqual({ allowed: false, personaId, countToday: 0, cap: 0 });
  });

  it("gives back a reservation on release, allowing another one to take its place", async () => {
    const { agentId, personaId } = await seedPersona({ dailyGenerationCap: 1 });

    const first = await guard.reserve(agentId);
    expect(first.allowed).toBe(true);

    const blocked = await guard.reserve(agentId);
    expect(blocked.allowed).toBe(false);

    await guard.release(personaId!);

    const afterRelease = await guard.reserve(agentId);
    expect(afterRelease).toMatchObject({ allowed: true, countToday: 1, cap: 1 });
  });

  it("never lets release drive the counter negative", async () => {
    const { personaId } = await seedPersona({ dailyGenerationCap: 5 });
    await guard.release(personaId!);
    await guard.release(personaId!);
    const [row] = await db.select().from(personas).where(eq(personas.id, personaId!));
    expect(row!.generationCountToday).toBe(0);
  });

  it("under a 20-way concurrent race, lets exactly `cap` reservations succeed", async () => {
    const cap = 5;
    const { agentId, personaId } = await seedPersona({ dailyGenerationCap: cap });

    const results = await Promise.all(Array.from({ length: 20 }, () => guard.reserve(agentId)));

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(cap);

    const [row] = await db.select().from(personas).where(eq(personas.id, personaId!));
    expect(row!.generationCountToday).toBe(cap);
  });
});
