import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  personaGenerationCounters,
  personas,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin host services persona generation cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("plugin-host-services personas.reserveDailyGeneration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-host-services-persona-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(personaGenerationCounters);
    await db.delete(personas);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(overrides: { dailyGenerationCap?: number | null; asPersona?: boolean } = {}) {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const otherCompanyRunId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Persona", role: "engineer" });
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running" },
      { id: otherCompanyRunId, companyId: otherCompanyId, agentId, status: "running" },
    ]);
    if (overrides.asPersona !== false) {
      await db.insert(personas).values({
        id: randomUUID(),
        companyId,
        agentId,
        handle: "@test",
        dailyGenerationCap: overrides.dailyGenerationCap ?? null,
      });
    }

    return { companyId, otherCompanyId, agentId, runId, otherCompanyRunId };
  }

  it("allows unlimited generations for an agent that is not a persona", async () => {
    const { companyId, runId } = await seed({ asPersona: false });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: true, cap: null, usedToday: 0 });
  });

  it("allows unlimited generations for a persona with no cap set", async () => {
    const { companyId, runId } = await seed({ dailyGenerationCap: null });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: true, cap: null, usedToday: 0 });
  });

  it("allows generations up to the cap, then rejects for the rest of the day", async () => {
    const { companyId, runId } = await seed({ dailyGenerationCap: 2 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const first = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(first).toEqual({ allowed: true, cap: 2, usedToday: 0 });

    const second = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(second).toEqual({ allowed: true, cap: 2, usedToday: 1 });

    const third = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(third).toEqual({ allowed: false, cap: 2, usedToday: 2 });
  });

  it("never lets concurrent calls push the day's count past the cap", async () => {
    const { companyId, runId } = await seed({ dailyGenerationCap: 5 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const results = await Promise.all(
      Array.from({ length: 20 }, () => services.personas.reserveDailyGeneration({ companyId, runId })),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(5);
  });

  it("rejects a non-positive cap without granting a first free generation", async () => {
    const { companyId, runId } = await seed({ dailyGenerationCap: 0 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: false, cap: 0, usedToday: 0 });
  });

  it("rejects when runId is omitted", async () => {
    const { companyId } = await seed({ dailyGenerationCap: 2 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    await expect(
      services.personas.reserveDailyGeneration({ companyId, runId: undefined as unknown as string }),
    ).rejects.toThrow("runId is required");
  });

  it("rejects a run that belongs to a different company", async () => {
    const { companyId, otherCompanyRunId } = await seed({ dailyGenerationCap: 2 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    await expect(
      services.personas.reserveDailyGeneration({ companyId, runId: otherCompanyRunId }),
    ).rejects.toThrow("Run not found in this company");
  });

  it("tracks separate counters per persona per day", async () => {
    const { companyId, runId } = await seed({ dailyGenerationCap: 1 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    await services.personas.reserveDailyGeneration({ companyId, runId });
    const rows = await db.select().from(personaGenerationCounters);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);

    // Simulate a new UTC day by moving the counter row's `day` back —
    // exercises the (persona_id, day) uniqueness boundary rather than the
    // capped increment itself.
    await db
      .update(personaGenerationCounters)
      .set({ day: "2000-01-01" })
      .where(eq(personaGenerationCounters.id, rows[0]!.id));

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: true, cap: 1, usedToday: 0 });

    const rowsAfter = await db.select().from(personaGenerationCounters);
    expect(rowsAfter).toHaveLength(2);
  });
});
