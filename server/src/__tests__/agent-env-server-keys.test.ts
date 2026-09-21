/**
 * DUR-3994 Stage 0: a real heartbeat run (process adapter -> the real
 * runChildProcess) must not hand the server's own keys to the agent.
 *
 * The server process is given random decoy values ("canaries") for every key.
 * The agent writes only the NAMES it can see to a file -- never a value -- and
 * the test checks that none of the server's keys is among them, while a
 * deliberately different per-agent DATABASE_URL still reaches its agent.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-env tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SERVER_KEY_NAMES = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SERVER_ANTHROPIC_API_KEY",
  "DATABASE_URL",
  "DATABASE_BYPASS_URL",
  "DATABASE_MIGRATION_URL",
] as const;

// Agent program: writes the names of the server keys it can see (never their
// values), plus whether DATABASE_URL matches the value it was told to expect.
const PROBE_SOURCE = `
const fs = require("node:fs");
const names = ${JSON.stringify(SERVER_KEY_NAMES)};
const seen = names.filter((n) => typeof process.env[n] === "string");
const expectDb = process.env.PROBE_EXPECT_DATABASE_URL;
const dbMatches = expectDb ? process.env.DATABASE_URL === expectDb : null;
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ seen, dbMatches }));
`;

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("DUR-3994: agents never inherit the server's keys", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let outDir = "";
  const savedEnv: Record<string, string | undefined> = {};
  const canaries: Record<string, string> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-env-server-keys-");
    db = createDb(tempDb.connectionString);
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "dur3994-probe-"));
  }, 30_000);

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  function plantServerCanaries() {
    for (const name of SERVER_KEY_NAMES) {
      savedEnv[name] = process.env[name];
      canaries[name] = `canary-${name.toLowerCase()}-${randomUUID()}`;
      process.env[name] = canaries[name];
    }
  }

  async function runProbeAgent(extraEnv: Record<string, string>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const outFile = path.join(outDir, `${agentId}.json`);
    await db.insert(companies).values({
      id: companyId,
      name: "Canary Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProbeAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", PROBE_SOURCE],
        env: { PROBE_OUT: outFile, ...extraEnv },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    return JSON.parse(await fs.readFile(outFile, "utf8")) as { seen: string[]; dbMatches: boolean | null };
  }

  it("a process-adapter agent sees none of the server's keys", async () => {
    plantServerCanaries();
    const result = await runProbeAgent({});
    expect(result.seen).toEqual([]);
  }, 30_000);

  it("a deliberately different per-agent DATABASE_URL still reaches that agent", async () => {
    plantServerCanaries();
    const perAgent = `canary-per-agent-db-${randomUUID()}`;
    const result = await runProbeAgent({ DATABASE_URL: perAgent, PROBE_EXPECT_DATABASE_URL: perAgent });
    expect(result.seen).toEqual(["DATABASE_URL"]);
    expect(result.dbMatches).toBe(true);
  }, 30_000);

  it("an agent configured with the server's OWN database address (under any name) does not get it", async () => {
    plantServerCanaries();
    const result = await runProbeAgent({
      DATABASE_URL: canaries.DATABASE_BYPASS_URL,
      BETTER_AUTH_SECRET: "configured-on-the-agent",
    });
    expect(result.seen).toEqual([]);
  }, 30_000);
});
