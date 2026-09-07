import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeState, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  deleteAfterLateWritesDrain,
  deleteTablesAfterLateWritesDrain,
  isLateWriteTeardownError,
  type TeardownDeleter,
} from "./helpers/late-write-teardown.js";

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

  describe("deleteTablesAfterLateWritesDrain (DUR-3925)", () => {
    const teardownOrder = [agentRuntimeState, agents, companies] as const;

    /**
     * A db whose `delete` behaves exactly like the real one, except that it
     * fires `onDelete(table)` after each delete resolves -- the hook stands in
     * for the fire-and-forget continuation that re-inserts a child row between
     * the child drain and the parent delete.
     */
    function dbWithLateWriter(onDelete: (table: PgTable) => Promise<void>): TeardownDeleter & { deletes: PgTable[] } {
      const deletes: PgTable[] = [];
      return {
        deletes,
        delete: (table) => {
          deletes.push(table);
          return db.delete(table).then(async (result) => {
            await onDelete(table);
            return result;
          });
        },
      };
    }

    it("recognises the two retryable teardown errors and nothing else", async () => {
      const { insertRuntimeState } = await seedAgentWithRuntimeState();
      await db.delete(agentRuntimeState);
      await insertRuntimeState();
      let fkError: unknown = null;
      try {
        await db.delete(agents);
      } catch (error) {
        fkError = error;
      }
      expect(fkError).not.toBeNull();
      expect(isLateWriteTeardownError(fkError)).toBe(true);

      expect(isLateWriteTeardownError({ code: "40P01" })).toBe(true);
      expect(isLateWriteTeardownError(new Error("write CONNECTION_ENDED"))).toBe(false);
      expect(isLateWriteTeardownError({ code: "42601" })).toBe(false);
      expect(isLateWriteTeardownError(null)).toBe(false);

      await cleanup();
    });

    it("re-drains the earlier tables and retries when a late child write trips the parent delete", async () => {
      const { insertRuntimeState } = await seedAgentWithRuntimeState();

      let lateWriteFired = false;
      const spy = dbWithLateWriter(async (table) => {
        if (table === agentRuntimeState && !lateWriteFired) {
          lateWriteFired = true;
          await insertRuntimeState();
        }
      });

      await deleteTablesAfterLateWritesDrain(spy, teardownOrder, { delayMs: 1 });

      expect(lateWriteFired).toBe(true);
      // agentRuntimeState, agents (23503), then agentRuntimeState again, agents, companies.
      expect(spy.deletes).toEqual([agentRuntimeState, agents, agentRuntimeState, agents, companies]);
      expect(await db.select().from(agents)).toHaveLength(0);
      expect(await db.select().from(agentRuntimeState)).toHaveLength(0);
      expect(await db.select().from(companies)).toHaveLength(0);
    });

    it("issues exactly one delete per table on the happy path", async () => {
      await seedAgentWithRuntimeState();
      const spy = dbWithLateWriter(async () => {});

      await deleteTablesAfterLateWritesDrain(spy, teardownOrder);

      expect(spy.deletes).toEqual([agentRuntimeState, agents, companies]);
    });

    it("rethrows the last FK error when the late writer never stops", async () => {
      const { insertRuntimeState } = await seedAgentWithRuntimeState();
      const spy = dbWithLateWriter(async (table) => {
        if (table === agentRuntimeState) await insertRuntimeState();
      });

      await expectAgentsDeleteFkViolation(() =>
        deleteTablesAfterLateWritesDrain(spy, teardownOrder, { attempts: 3, delayMs: 1 }),
      );
      // Three attempts on `agents`, each preceded by a drain of agent_runtime_state.
      expect(spy.deletes.filter((table) => table === agents)).toHaveLength(3);

      await cleanup();
    });

    it("rethrows a non-retryable error immediately instead of looping on it", async () => {
      let calls = 0;
      const broken: TeardownDeleter = {
        delete: () => {
          calls += 1;
          return Promise.reject(new Error("write CONNECTION_ENDED 127.0.0.1:5432"));
        },
      };

      await expect(
        deleteTablesAfterLateWritesDrain(broken, teardownOrder, { attempts: 5, delayMs: 1 }),
      ).rejects.toThrow("CONNECTION_ENDED");
      expect(calls).toBe(1);
    });
  });
});
