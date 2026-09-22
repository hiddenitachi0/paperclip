/**
 * DUR-3997: kinds and the Test button, end to end against a real database.
 *
 * Covers: migration 0171 gives company_secrets its four new columns, a
 * secret keeps the kind it was saved with, the Test service reads the value
 * back through the ordinary resolution path (so the test is in the audit
 * trail), records the verdict on the row, and never lets the value into the
 * row, the verdict or the access event -- even when the probe echoes it.
 *
 * Every value here is a random decoy ("canary"); assertions compare booleans
 * so a failure never prints a key.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { secretTestService } from "../services/secret-tests.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping DUR-3997 secret test-service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const canaryKey = () => `sk-proj-DUR3997${randomBytes(24).toString("hex")}`;

describeEmbeddedPostgres("DUR-3997 secret kinds and Test", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-dur3997-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur3997-secret-tests");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
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
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("keeps the kind a secret was saved with, and lets it be changed later", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const created = await svc.create(companyId, {
      name: `openai-${randomUUID()}`,
      provider: "local_encrypted",
      value: canaryKey(),
      kind: "openai_api_key",
    });
    expect(created.kind).toBe("openai_api_key");
    expect(created.lastTestAt).toBe(null);
    expect(created.lastTestOk).toBe(null);

    const listed = await svc.list(companyId);
    expect(listed[0]?.kind).toBe("openai_api_key");

    const untagged = await svc.create(companyId, {
      name: `plain-${randomUUID()}`,
      provider: "local_encrypted",
      value: "plain-value-123456",
    });
    expect(untagged.kind).toBe(null);

    const retagged = await svc.update(untagged.id, { kind: "github_token" });
    expect(retagged?.kind).toBe("github_token");
  });

  it("records the verdict on the row and in the access log, never the value", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const key = canaryKey();
    const created = await svc.create(companyId, {
      name: `openai-${randomUUID()}`,
      provider: "local_encrypted",
      value: key,
      kind: "openai_api_key",
    });

    const probe = vi.fn(async (_kind: string, value: string) => ({
      ok: false,
      // A provider that echoes the key back: the worst case for a message.
      message: `OpenAI did not accept this key (Incorrect API key provided: ${value}).`,
    }));
    const tests = secretTestService(db, { secrets: svc, probe: probe as any, now: () => new Date("2026-09-23T10:00:00.000Z") });

    const result = await tests.test(companyId, created.id, { userId: "user-1" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toBe("openai_api_key");
    expect(probe.mock.calls[0][1] === key).toBe(true);

    expect(result.ok).toBe(false);
    expect(result.message.includes(key)).toBe(false);
    expect(result.message).toContain("[key]");
    expect(result.secret.lastTestOk).toBe(false);
    expect(result.secret.lastTestAt?.toISOString()).toBe("2026-09-23T10:00:00.000Z");
    expect(JSON.stringify(result).includes(key)).toBe(false);

    const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, created.id));
    expect(row.lastTestOk).toBe(false);
    expect(row.lastTestMessage?.includes(key)).toBe(false);

    const events = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, created.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      consumerType: "system",
      consumerId: "secret-test",
      actorType: "user",
      actorId: "user-1",
      outcome: "success",
    });
    expect(JSON.stringify(events).includes(key)).toBe(false);

    // A good answer replaces the bad one.
    probe.mockResolvedValueOnce({ ok: true, message: "OpenAI answered. This key works." });
    const again = await tests.test(companyId, created.id, { userId: "user-1" });
    expect(again.ok).toBe(true);
    expect(again.secret.lastTestOk).toBe(true);
    expect(again.secret.lastTestMessage).toBe("OpenAI answered. This key works.");
  });

  it("refuses to test a secret without a testable kind, or one that is not active, or another company's", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = secretService(db);
    const probe = vi.fn(async () => ({ ok: true, message: "should not be called" }));
    const tests = secretTestService(db, { secrets: svc, probe: probe as any });

    const untagged = await svc.create(companyId, {
      name: `plain-${randomUUID()}`,
      provider: "local_encrypted",
      value: "plain-value-123456",
    });
    await expect(tests.test(companyId, untagged.id, { userId: "user-1" })).rejects.toMatchObject({ status: 422 });

    const github = await svc.create(companyId, {
      name: `gh-${randomUUID()}`,
      provider: "local_encrypted",
      value: "ghp_canary0000000000000000000000",
      kind: "github_token",
    });
    await expect(tests.test(companyId, github.id, { userId: "user-1" })).rejects.toMatchObject({ status: 422 });

    const openai = await svc.create(companyId, {
      name: `openai-${randomUUID()}`,
      provider: "local_encrypted",
      value: canaryKey(),
      kind: "openai_api_key",
    });
    await expect(tests.test(otherCompanyId, openai.id, { userId: "user-1" })).rejects.toMatchObject({ status: 404 });

    await svc.update(openai.id, { status: "disabled" });
    await expect(tests.test(companyId, openai.id, { userId: "user-1" })).rejects.toMatchObject({ status: 422 });

    expect(probe).not.toHaveBeenCalled();
    const events = await db.select().from(secretAccessEvents);
    expect(events).toHaveLength(0);
  });

  it("forgets an old verdict when the kind changes", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const created = await svc.create(companyId, {
      name: `openai-${randomUUID()}`,
      provider: "local_encrypted",
      value: canaryKey(),
      kind: "openai_api_key",
    });
    const tests = secretTestService(db, {
      secrets: svc,
      probe: (async () => ({ ok: true, message: "OpenAI answered. This key works." })) as any,
    });
    await tests.test(companyId, created.id, { userId: "user-1" });

    const sameKind = await svc.update(created.id, { description: "still openai" });
    expect(sameKind?.lastTestOk).toBe(true);

    const changed = await svc.update(created.id, { kind: "openrouter_api_key" });
    expect(changed?.kind).toBe("openrouter_api_key");
    expect(changed?.lastTestOk).toBe(null);
    expect(changed?.lastTestMessage).toBe(null);
  });
});
