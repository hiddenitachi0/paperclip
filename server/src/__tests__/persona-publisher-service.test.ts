import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  personaAccountPublishCounters,
  personaAccounts,
  personaPosts,
  personaPublishingCompanySettings,
  personas,
} from "@paperclipai/db";
import { PERSONA_POST_AI_DISCLOSURE_TEXT } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { personaPublisherService } from "../services/persona-publisher.js";
import { personaAccountsService, PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH } from "../services/persona-accounts.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping persona publisher service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("persona-publisher-service attemptPublish", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-persona-publisher-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("persona-publisher-service-");
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

  async function seedPersona(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Maja", role: "persona" });
    const [persona] = await db
      .insert(personas)
      .values({ id: randomUUID(), companyId, agentId, handle: "@maja" })
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
      .values({
        id: randomUUID(),
        companyId,
        personaId,
        personaAccountId,
        caption: "hello world",
        ...overrides,
      })
      .returning();
    return post!;
  }

  async function bindPublishToken(companyId: string, accountId: string, value = "fanvue-token") {
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `fanvue-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
    await secrets.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "persona_account",
      targetId: accountId,
      configPath: PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH,
    });
  }

  function stubSuccessfulFanvueFetch(externalPostId = "fv_123") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: externalPostId }), { status: 201 })),
    );
  }

  it("blocks on the company-wide kill switch before touching the post", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id);
    const post = await seedPost(companyId, persona.id, account.id);
    await db.insert(personaPublishingCompanySettings).values({
      companyId,
      publishingPaused: true,
      pausedAt: new Date(),
    });

    const publisher = personaPublisherService(db);
    const outcome = await publisher.attemptPublish(post.id);
    expect(outcome).toEqual({ outcome: "paused", reason: "company" });

    const [reloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, post.id));
    expect(reloaded!.status).toBe("queued");
  });

  it("blocks on the per-persona kill switch", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    await db.update(personas).set({ publishingPaused: true }).where(eq(personas.id, persona.id));
    const account = await seedAccount(companyId, persona.id);
    const post = await seedPost(companyId, persona.id, account.id);

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome).toEqual({ outcome: "paused", reason: "persona" });
  });

  it("blocks on the per-account kill switch", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, { publishingPaused: true });
    const post = await seedPost(companyId, persona.id, account.id);

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome).toEqual({ outcome: "paused", reason: "account" });
  });

  it("gates an autonomous account still in its warm-up window behind approval", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "autonomous",
      warmupPostsRequired: 5,
      publishedPostCount: 2,
    });
    const post = await seedPost(companyId, persona.id, account.id);

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome.outcome).toBe("pending_approval");

    const [reloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, post.id));
    expect(reloaded!.status).toBe("pending_approval");
    expect(reloaded!.approvalId).toBeTruthy();

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, reloaded!.approvalId!));
    expect((approval!.payload as any).reason).toBe("warmup");
    expect((approval!.payload as any).kind).toBe("persona_publish");
  });

  it("gates a requires_approval channel even past its warm-up window", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "requires_approval",
      warmupPostsRequired: 0,
      publishedPostCount: 50,
    });
    const post = await seedPost(companyId, persona.id, account.id);

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome.outcome).toBe("pending_approval");

    const [reloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, post.id));
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, reloaded!.approvalId!));
    expect((approval!.payload as any).reason).toBe("requires_approval_channel");
  });

  it("publishes directly for an autonomous account past warm-up, appending the disclosure text", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "autonomous",
      warmupPostsRequired: 0,
      aiDisclosureEnabled: true,
    });
    await bindPublishToken(companyId, account.id);
    const post = await seedPost(companyId, persona.id, account.id);

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.caption).toContain(PERSONA_POST_AI_DISCLOSURE_TEXT);
      return new Response(JSON.stringify({ id: "fv_abc" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome).toEqual({ outcome: "published", externalPostId: "fv_abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [reloadedPost] = await db.select().from(personaPosts).where(eq(personaPosts.id, post.id));
    expect(reloadedPost!.status).toBe("published");
    expect(reloadedPost!.externalPostId).toBe("fv_abc");

    const [reloadedAccount] = await db.select().from(personaAccounts).where(eq(personaAccounts.id, account.id));
    expect(reloadedAccount!.publishedPostCount).toBe(1);
  });

  it("publishes a board-approved post without re-checking the channel's autonomy mode", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "requires_approval",
      warmupPostsRequired: 0,
    });
    await bindPublishToken(companyId, account.id);
    const post = await seedPost(companyId, persona.id, account.id, { status: "approved" });
    stubSuccessfulFanvueFetch("fv_approved");

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome).toEqual({ outcome: "published", externalPostId: "fv_approved" });
  });

  it("refuses post N+1 once the daily cap is reserved, leaving the post queued for tomorrow", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "autonomous",
      warmupPostsRequired: 0,
      dailyPostCap: 1,
    });
    await bindPublishToken(companyId, account.id);
    const firstPost = await seedPost(companyId, persona.id, account.id, { caption: "post one" });
    const secondPost = await seedPost(companyId, persona.id, account.id, { caption: "post two" });
    stubSuccessfulFanvueFetch();

    const first = await personaPublisherService(db).attemptPublish(firstPost.id);
    expect(first.outcome).toBe("published");

    const second = await personaPublisherService(db).attemptPublish(secondPost.id);
    expect(second).toEqual({ outcome: "capped" });

    const [reloadedSecond] = await db.select().from(personaPosts).where(eq(personaPosts.id, secondPost.id));
    expect(reloadedSecond!.status).toBe("queued");
  });

  it("never lets two concurrent publish attempts for the same post both win", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "autonomous",
      warmupPostsRequired: 0,
      dailyPostCap: 100,
    });
    await bindPublishToken(companyId, account.id);
    const post = await seedPost(companyId, persona.id, account.id);
    stubSuccessfulFanvueFetch();

    const publisher = personaPublisherService(db);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => publisher.attemptPublish(post.id)),
    );

    const published = results.filter((r) => r.outcome === "published");
    expect(published).toHaveLength(1);

    const [reloadedAccount] = await db.select().from(personaAccounts).where(eq(personaAccounts.id, account.id));
    expect(reloadedAccount!.publishedPostCount).toBe(1);
  });

  it("marks the post failed and records the reason when the platform rejects the token", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id, {
      autonomyMode: "autonomous",
      warmupPostsRequired: 0,
    });
    await bindPublishToken(companyId, account.id);
    const post = await seedPost(companyId, persona.id, account.id);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome.outcome).toBe("failed");

    const [reloaded] = await db.select().from(personaPosts).where(eq(personaPosts.id, post.id));
    expect(reloaded!.status).toBe("failed");
    expect(reloaded!.failureReason).toContain("expired or insufficient scope");
  });

  it("returns not_claimable for a post that is already terminal", async () => {
    const companyId = await seedCompany();
    const persona = await seedPersona(companyId);
    const account = await seedAccount(companyId, persona.id);
    const post = await seedPost(companyId, persona.id, account.id, { status: "published" });

    const outcome = await personaPublisherService(db).attemptPublish(post.id);
    expect(outcome).toEqual({ outcome: "not_claimable" });
  });
});
