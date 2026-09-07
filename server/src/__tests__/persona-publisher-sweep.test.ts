import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  createRequestScopedDb,
  runInPooledScope,
  personaAccountPublishCounters,
  personaAccounts,
  personaPosts,
  personaPublishingCompanySettings,
  personas,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { personaPublisherSweepService } from "../services/persona-publisher-sweep.js";
import { PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH } from "../services/persona-accounts.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping persona publisher sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-134 review follow-up: the scheduler pass that makes autonomous
// publishing actually autonomous. See persona-publisher-sweep.ts.
describeEmbeddedPostgres("persona-publisher-sweep tick", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-persona-sweep-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("persona-publisher-sweep-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(activityLog);
    await db.delete(personaAccountPublishCounters);
    await db.delete(personaPosts);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(personaAccounts);
    await db.delete(personaPublishingCompanySettings);
    await db.delete(approvals);
    await db.delete(personas);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
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

  async function seedPersona(companyId: string, overrides: Partial<typeof personas.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Maja", role: "persona" });
    const [persona] = await db
      .insert(personas)
      .values({ id: randomUUID(), companyId, agentId, handle: `@maja-${agentId.slice(0, 6)}`, ...overrides })
      .returning();
    return persona!;
  }

  async function seedAccount(
    companyId: string,
    personaId: string,
    overrides: Partial<typeof personaAccounts.$inferInsert> = {},
  ) {
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
        dailyPostCap: 10,
        warmupPostsRequired: 0,
        ...overrides,
      })
      .returning();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `fanvue-${randomUUID()}`,
      provider: "local_encrypted",
      value: "fanvue-token",
    });
    await secrets.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "persona_account",
      targetId: account!.id,
      configPath: PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH,
    });
    return account!;
  }

  async function seedPost(
    companyId: string,
    personaId: string,
    personaAccountId: string,
    overrides: Partial<typeof personaPosts.$inferInsert> = {},
  ) {
    const [post] = await db
      .insert(personaPosts)
      .values({ id: randomUUID(), companyId, personaId, personaAccountId, caption: "hello", ...overrides })
      .returning();
    return post!;
  }

  function stubFanvue() {
    let n = 0;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: `fv_${++n}` }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("publishes at most one post per account per tick, oldest first, and skips paused accounts and personas", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id);
    const first = await seedPost(companyId, persona.id, account.id, {
      caption: "first",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    const second = await seedPost(companyId, persona.id, account.id, {
      caption: "second",
      createdAt: new Date("2026-09-01T11:00:00Z"),
    });

    const pausedAccount = await seedAccount(companyId, persona.id, { publishingPaused: true });
    const pausedAccountPost = await seedPost(companyId, persona.id, pausedAccount.id);

    const pausedPersona = await seedPersona(companyId, { publishingPaused: true });
    const pausedPersonaAccount = await seedAccount(companyId, pausedPersona.id);
    const pausedPersonaPost = await seedPost(companyId, pausedPersona.id, pausedPersonaAccount.id);

    const fetchMock = stubFanvue();
    const sweep = personaPublisherSweepService(db);

    const tick1 = await sweep.tick();
    expect(tick1).toMatchObject({ considered: 1, published: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const statusOf = async (id: string) =>
      (await db.select().from(personaPosts).where(eq(personaPosts.id, id)))[0]!.status;
    expect(await statusOf(first.id)).toBe("published");
    expect(await statusOf(second.id)).toBe("queued");
    expect(await statusOf(pausedAccountPost.id)).toBe("queued");
    expect(await statusOf(pausedPersonaPost.id)).toBe("queued");

    const tick2 = await sweep.tick();
    expect(tick2).toMatchObject({ considered: 1, published: 1 });
    expect(await statusOf(second.id)).toBe("published");

    const tick3 = await sweep.tick();
    expect(tick3).toMatchObject({ considered: 0, published: 0 });
  });

  it("moves a board-approved post out the door and files an approval for a warming-up one", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const approvedAccount = await seedAccount(companyId, persona.id, { autonomyMode: "requires_approval" });
    const approvedPost = await seedPost(companyId, persona.id, approvedAccount.id, { status: "approved" });
    const warmupAccount = await seedAccount(companyId, persona.id, { warmupPostsRequired: 5 });
    const warmupPost = await seedPost(companyId, persona.id, warmupAccount.id);
    stubFanvue();

    const result = await personaPublisherSweepService(db).tick();
    expect(result).toMatchObject({ considered: 2, published: 1, pendingApproval: 1 });

    const [approvedReloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, approvedPost.id));
    expect(approvedReloaded!.status).toBe("published");
    const [warmupReloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, warmupPost.id));
    expect(warmupReloaded!.status).toBe("pending_approval");

    // Second tick: the pending post is not eligible any more, nothing is re-filed.
    const again = await personaPublisherSweepService(db).tick();
    expect(again).toMatchObject({ considered: 0 });
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("leaves a capped account's post queued and keeps going for other accounts", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const cappedAccount = await seedAccount(companyId, persona.id, { dailyPostCap: 1 });
    await db.insert(personaAccountPublishCounters).values({
      companyId,
      personaAccountId: cappedAccount.id,
      day: new Date().toISOString().slice(0, 10),
      count: 1,
    });
    const cappedPost = await seedPost(companyId, persona.id, cappedAccount.id);
    const otherAccount = await seedAccount(companyId, persona.id);
    const otherPost = await seedPost(companyId, persona.id, otherAccount.id);
    stubFanvue();

    const result = await personaPublisherSweepService(db).tick();
    expect(result).toMatchObject({ considered: 2, published: 1, capped: 1 });
    const [cappedReloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, cappedPost.id));
    expect(cappedReloaded!.status).toBe("queued");
    const [otherReloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, otherPost.id));
    expect(otherReloaded!.status).toBe("published");
  });

  it("runs through the request-scoped db proxy the scheduler hands it", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id);
    const post = await seedPost(companyId, persona.id, account.id);
    stubFanvue();

    const scoped = createRequestScopedDb(db);
    const result = await runInPooledScope(db, () => personaPublisherSweepService(scoped).tick());
    expect(result).toMatchObject({ considered: 1, published: 1 });
    const [reloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, post.id));
    expect(reloaded!.status).toBe("published");
  });
});
