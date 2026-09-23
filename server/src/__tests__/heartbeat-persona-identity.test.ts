import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, personas } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

// DUR-4000: a real heartbeat run hands the adapter the persona's voice and
// identity when a person is attached to the job, and the plain tone /
// personality when not. The adapter is a fake that records the agent row it
// was given (same shape as heartbeat-runtime-skills.test.ts).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "persona_identity_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat persona identity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat hands the adapter the persona's voice and identity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let paperclipHome: string | null = null;
  const captured: Array<{ agentId: string; name: string; tone: string | null; personality: string | null }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-persona-identity-");
    db = createDb(tempDb.connectionString);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-persona-identity-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        captured.push({
          agentId: ctx.agent.id,
          name: ctx.agent.name,
          tone: ctx.agent.tone ?? null,
          personality: ctx.agent.personality ?? null,
        });
        return { exitCode: 0, signal: null, timedOut: false, label: "Captured agent identity" };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    captured.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "personas",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, personaId: string | null) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      tone: "Plain and brief.",
      personality: "The job's own personality text.",
      personaId,
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function runAndCapture(agentId: string) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");
    const entry = captured.find((c) => c.agentId === agentId);
    expect(entry).toBeDefined();
    return entry!;
  }

  it("two jobs sharing one persona each get the persona's voice and their own job name; a blank job keeps its own text", async () => {
    const companyId = await seedCompany();
    const [persona] = await db
      .insert(personas)
      .values({
        companyId,
        displayName: "Maja",
        pronouns: "she/her",
        traits: "curious, dry humour",
        backstory: "Grew up by the sea.",
        voice: "Short sentences. Warm.",
        status: "active",
      })
      .returning();
    const salesId = await seedAgent(companyId, "Sales agent 1", persona!.id);
    const booksId = await seedAgent(companyId, "Accountant", persona!.id);
    const blankId = await seedAgent(companyId, "Blank job", null);

    const sales = await runAndCapture(salesId);
    expect(sales.name).toBe("Sales agent 1");
    expect(sales.tone).toBe("Short sentences. Warm.");
    expect(sales.personality).toBe(
      "You are Maja (she/her), working as Sales agent 1.\n\nTraits: curious, dry humour\n\nBackstory: Grew up by the sea.",
    );

    const books = await runAndCapture(booksId);
    expect(books.name).toBe("Accountant");
    expect(books.tone).toBe("Short sentences. Warm.");
    expect(books.personality).toContain("You are Maja (she/her), working as Accountant.");
    expect(books.personality).not.toContain("Sales agent 1");

    const blank = await runAndCapture(blankId);
    expect(blank).toEqual({
      agentId: blankId,
      name: "Blank job",
      tone: "Plain and brief.",
      personality: "The job's own personality text.",
    });

    // The rows themselves were never rewritten by the run.
    const rows = await db.select({ name: agents.name, tone: agents.tone, personality: agents.personality }).from(agents);
    for (const row of rows) {
      expect(row.tone).toBe("Plain and brief.");
      expect(row.personality).toBe("The job's own personality text.");
    }
  });

  it("a persona without a voice leaves the agent's own tone in place", async () => {
    const companyId = await seedCompany();
    const [persona] = await db
      .insert(personas)
      .values({ companyId, displayName: "Maja", status: "active" })
      .returning();
    const agentId = await seedAgent(companyId, "Sales agent 1", persona!.id);

    const entry = await runAndCapture(agentId);
    expect(entry.tone).toBe("Plain and brief.");
    expect(entry.personality).toBe("You are Maja, working as Sales agent 1.");
  });
});
