import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentDailyCounters,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { agentDailyLimitService, dailyLimitReachedMessage } from "../services/agent-daily-limits.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// DUR-4000: the daily image limit is the AGENT's own (agents.limits
// .dailyImageGenerations), counted in agent_daily_counters, and still reached
// through the plugin host's `personas.reserveDailyGeneration` (same name and
// result shape as before, so the media-studio plugin needs no change).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent daily limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("agent daily limits (plugin-host personas.reserveDailyGeneration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-daily-limits-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentDailyCounters);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(limits: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const otherCompanyRunId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Sales agent 1", role: "engineer", limits });
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running" },
      { id: otherCompanyRunId, companyId: otherCompanyId, agentId, status: "running" },
    ]);

    return { companyId, otherCompanyId, agentId, runId, otherCompanyRunId };
  }

  it("allows unlimited generations for an agent with no limit set", async () => {
    const { companyId, runId } = await seed({});
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: true, cap: null, usedToday: 0 });
  });

  it("treats an explicit null as no limit", async () => {
    const { companyId, runId } = await seed({ dailyImageGenerations: null });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: true, cap: null, usedToday: 0 });
  });

  it("allows generations up to the limit, then rejects for the rest of the day", async () => {
    const { companyId, runId } = await seed({ dailyImageGenerations: 2 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    expect(await services.personas.reserveDailyGeneration({ companyId, runId })).toEqual({ allowed: true, cap: 2, usedToday: 0 });
    expect(await services.personas.reserveDailyGeneration({ companyId, runId })).toEqual({ allowed: true, cap: 2, usedToday: 1 });
    expect(await services.personas.reserveDailyGeneration({ companyId, runId })).toEqual({ allowed: false, cap: 2, usedToday: 2 });
    expect(dailyLimitReachedMessage("image_generation", 2)).toBe("Daily image limit (2) reached for this agent today.");
  });

  it("never lets concurrent calls push the day's count past the limit", async () => {
    const { companyId, runId } = await seed({ dailyImageGenerations: 5 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const results = await Promise.all(
      Array.from({ length: 20 }, () => services.personas.reserveDailyGeneration({ companyId, runId })),
    );
    expect(results.filter((r) => r.allowed).length).toBe(5);
  });

  it("rejects a limit of 0 without granting a first free generation", async () => {
    const { companyId, runId } = await seed({ dailyImageGenerations: 0 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    const result = await services.personas.reserveDailyGeneration({ companyId, runId });
    expect(result).toEqual({ allowed: false, cap: 0, usedToday: 0 });
    expect(await db.select().from(agentDailyCounters)).toHaveLength(0);
  });

  it("rejects when runId is omitted", async () => {
    const { companyId } = await seed({ dailyImageGenerations: 2 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    await expect(
      services.personas.reserveDailyGeneration({ companyId, runId: undefined as unknown as string }),
    ).rejects.toThrow("runId is required");
  });

  it("rejects a run that belongs to a different company", async () => {
    const { companyId, otherCompanyRunId } = await seed({ dailyImageGenerations: 2 });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    await expect(
      services.personas.reserveDailyGeneration({ companyId, runId: otherCompanyRunId }),
    ).rejects.toThrow("Run not found in this company");
  });

  it("counts per agent per kind per UTC day, so two jobs sharing one persona each have their own limit", async () => {
    const { companyId, agentId, runId } = await seed({ dailyImageGenerations: 1 });
    const secondAgentId = randomUUID();
    const secondRunId = randomUUID();
    await db.insert(agents).values({ id: secondAgentId, companyId, name: "Accountant", role: "engineer", limits: { dailyImageGenerations: 1 } });
    await db.insert(heartbeatRuns).values({ id: secondRunId, companyId, agentId: secondAgentId, status: "running" });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    expect((await services.personas.reserveDailyGeneration({ companyId, runId })).allowed).toBe(true);
    expect((await services.personas.reserveDailyGeneration({ companyId, runId })).allowed).toBe(false);
    // The other job is untouched by the first job's spend.
    expect((await services.personas.reserveDailyGeneration({ companyId, runId: secondRunId })).allowed).toBe(true);

    const rows = await db.select().from(agentDailyCounters).where(eq(agentDailyCounters.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "image_generation", count: 1 });

    // Simulate a new UTC day by moving the counter row's `day` back —
    // exercises the (agent, kind, day) uniqueness boundary.
    await db.update(agentDailyCounters).set({ day: "2000-01-01" }).where(eq(agentDailyCounters.id, rows[0]!.id));
    expect(await agentDailyLimitService(db).reserve(agentId, "image_generation")).toEqual({ allowed: true, cap: 1, usedToday: 0 });
    expect(await db.select().from(agentDailyCounters).where(eq(agentDailyCounters.agentId, agentId))).toHaveLength(2);
  });

  it("reads a malformed limits box as no limit rather than crashing the tool call", async () => {
    const { companyId, runId } = await seed({ dailyImageGenerations: "five" });
    const services = buildHostServices(db, randomUUID(), "media-studio-test", createEventBusStub());

    expect(await services.personas.reserveDailyGeneration({ companyId, runId })).toEqual({ allowed: true, cap: null, usedToday: 0 });
  });
});
