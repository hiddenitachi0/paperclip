import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  personaAccounts,
  personas,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { personaAccountsService } from "../services/persona-accounts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping persona account schedule tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-4016 (DUR-134 item 4, review follow-up): the operator-set cadence a
// persona account writes on, wired through routines/routine_triggers so the
// feature is autonomous end to end rather than relying on a human clicking a
// manual trigger every time.
describeEmbeddedPostgres("persona-accounts setSchedule/clearSchedule", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("persona-account-schedule-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(personaAccounts);
    await db.delete(personas);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedPersonaWithAgent(companyId: string) {
    const agentId = randomUUID();
    const [persona] = await db
      .insert(personas)
      .values({ id: randomUUID(), companyId, displayName: "Maja", handle: "@maja" })
      .returning();
    await db.insert(agents).values({ id: agentId, companyId, name: "Maja's job", role: "persona", personaId: persona!.id });
    return { persona: persona!, agentId };
  }

  async function seedAccount(companyId: string, personaId: string) {
    const [account] = await db
      .insert(personaAccounts)
      .values({
        id: randomUUID(),
        companyId,
        personaId,
        platform: "fanvue",
        accountLabel: "Maja — Fanvue",
        externalAccountId: `ext-${randomUUID()}`,
        aiDisclosureEnabled: true,
        autonomyMode: "autonomous",
        dailyPostCap: 5,
        warmupPostsRequired: 0,
      })
      .returning();
    return account!;
  }

  it("creates a routine + schedule trigger and links it to the account", async () => {
    const companyId = await seedCompany();
    const { persona, agentId } = await seedPersonaWithAgent(companyId);
    const account = await seedAccount(companyId, persona.id);

    const updated = await personaAccountsService(db).setSchedule(
      account.id,
      { assigneeAgentId: agentId, cronExpression: "0 8 * * *", timezone: "UTC" },
      { agentId: null, userId: "board" },
    );

    expect(updated.scheduleRoutineId).toBeTruthy();

    const [routine] = await db.select().from(routines).where(eq(routines.id, updated.scheduleRoutineId!));
    expect(routine!.assigneeAgentId).toBe(agentId);
    expect(routine!.description).toContain(account.id);

    const [trigger] = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, updated.scheduleRoutineId!));
    expect(trigger!.kind).toBe("schedule");
    expect(trigger!.cronExpression).toBe("0 8 * * *");
    expect(trigger!.enabled).toBe(true);
  });

  it("rejects a schedule assignee that is not one of this persona's own agents", async () => {
    const companyId = await seedCompany();
    const { persona } = await seedPersonaWithAgent(companyId);
    const account = await seedAccount(companyId, persona.id);
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Someone else", role: "engineer" });

    await expect(
      personaAccountsService(db).setSchedule(
        account.id,
        { assigneeAgentId: otherAgentId, cronExpression: "0 8 * * *" },
        { agentId: null, userId: "board" },
      ),
    ).rejects.toThrow();
  });

  it("reuses the same routine on a second setSchedule call instead of creating a duplicate", async () => {
    const companyId = await seedCompany();
    const { persona, agentId } = await seedPersonaWithAgent(companyId);
    const account = await seedAccount(companyId, persona.id);

    const first = await personaAccountsService(db).setSchedule(
      account.id,
      { assigneeAgentId: agentId, cronExpression: "0 8 * * *" },
      { agentId: null, userId: "board" },
    );
    const second = await personaAccountsService(db).setSchedule(
      account.id,
      { assigneeAgentId: agentId, cronExpression: "0 20 * * *" },
      { agentId: null, userId: "board" },
    );

    expect(second.scheduleRoutineId).toBe(first.scheduleRoutineId);
    const triggerRows = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, first.scheduleRoutineId!));
    expect(triggerRows).toHaveLength(1);
    expect(triggerRows[0]!.cronExpression).toBe("0 20 * * *");
  });

  it("clearSchedule disables the trigger and unlinks the account without deleting the routine", async () => {
    const companyId = await seedCompany();
    const { persona, agentId } = await seedPersonaWithAgent(companyId);
    const account = await seedAccount(companyId, persona.id);

    const withSchedule = await personaAccountsService(db).setSchedule(
      account.id,
      { assigneeAgentId: agentId, cronExpression: "0 8 * * *" },
      { agentId: null, userId: "board" },
    );
    const routineId = withSchedule.scheduleRoutineId!;

    const cleared = await personaAccountsService(db).clearSchedule(account.id, { agentId: null, userId: "board" });
    expect(cleared.scheduleRoutineId).toBeNull();

    const [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine).toBeTruthy();
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routineId));
    expect(trigger!.enabled).toBe(false);
  });
});
