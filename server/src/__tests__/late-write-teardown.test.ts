import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeState, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { deleteAfterLateWritesDrain } from "./helpers/late-write-teardown.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres late-write teardown tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("deleteAfterLateWritesDrain", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-late-write-teardown-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRuntimeState() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Late write co ${companyId.slice(0, 8)}`,
      issuePrefix: `L${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Late writer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const insertRuntimeState = async () => {
      await db
        .insert(agentRuntimeState)
        .values({ agentId, companyId, adapterType: "codex_local", stateJson: {} })
        .onConflictDoNothing({ target: agentRuntimeState.agentId });
    };
    await insertRuntimeState();
    return { companyId, agentId, insertRuntimeState };
  }

  /**
   * drizzle wraps the postgres.js error ("Failed query: delete from ...") and
   * keeps the real 23503 on `cause`, so assert against the whole chain.
   */
  async function expectAgentsDeleteFkViolation(run: () => Promise<unknown>) {
    let thrown: unknown = null;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "expected the agents delete to fail").not.toBeNull();
    const chain: string[] = [];
    for (let error: unknown = thrown; error instanceof Error; error = error.cause) {
      chain.push(`${error.message} ${JSON.stringify((error as { constraint_name?: string }).constraint_name ?? "")}`);
    }
    expect(chain.join("\n")).toContain("agent_runtime_state_agent_id_agents_id_fk");
  }

  async function cleanup() {
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  }

  it("reproduces the FK violation the hand-rolled child-then-parent delete hits", async () => {
    const { insertRuntimeState } = await seedAgentWithRuntimeState();

    // The teardown order is already correct: children before parents.
    await db.delete(agentRuntimeState);
    // ...but a fire-and-forget continuation (heartbeat.ts ensureRuntimeState,
    // reached from an executeRun() dispatch the test never awaited) commits a
    // fresh row right here, in the gap between the two statements.
    await insertRuntimeState();

    await expectAgentsDeleteFkViolation(() => db.delete(agents));

    await cleanup();
  });

  it("survives a late child write landing between the drain and the parent delete", async () => {
    const { insertRuntimeState } = await seedAgentWithRuntimeState();

    let lateWriteFired = false;
    let attempts = 0;
    await deleteAfterLateWritesDrain(
      async () => {
        attempts += 1;
        await db.delete(agentRuntimeState);
        if (!lateWriteFired) {
          lateWriteFired = true;
          await insertRuntimeState();
        }
      },
      () => db.delete(agents),
    );

    expect(lateWriteFired).toBe(true);
    expect(attempts).toBe(2);
    expect(await db.select().from(agents)).toHaveLength(0);
    expect(await db.select().from(agentRuntimeState)).toHaveLength(0);

    await cleanup();
  });

  it("does not retry when the parent delete succeeds first time", async () => {
    await seedAgentWithRuntimeState();

    let attempts = 0;
    await deleteAfterLateWritesDrain(
      async () => {
        attempts += 1;
        await db.delete(agentRuntimeState);
      },
      () => db.delete(agents),
    );

    expect(attempts).toBe(1);
    await cleanup();
  });

  it("rethrows the last error when the late writer never stops", async () => {
    const { insertRuntimeState } = await seedAgentWithRuntimeState();

    await expectAgentsDeleteFkViolation(() =>
      deleteAfterLateWritesDrain(
        async () => {
          await db.delete(agentRuntimeState);
          await insertRuntimeState();
        },
        () => db.delete(agents),
        { attempts: 3, delayMs: 1 },
      ),
    );

    await cleanup();
  });
});
