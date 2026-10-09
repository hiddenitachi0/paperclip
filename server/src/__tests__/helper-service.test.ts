import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyHelperSettings,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  costEvents,
  createDb,
  modelDirectoryEntries,
  secretAccessEvents,
} from "@paperclipai/db";
import { HELPER_BILLING_CODE, HELPER_BINDING_TARGET_TYPE } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.ts";
import { helperService } from "../services/helper.ts";

/**
 * "Ask Paperclip" helper, Phase 1, against a real database:
 *   - no tools are ever offered to the model;
 *   - the saved model must belong to the company (and not be archived);
 *   - a provider the helper has no key for is refused in plain words before
 *     anything is called or billed;
 *   - a picked key is read through the binding gate (secret_access_events,
 *     consumer 'helper') and used as the bearer token;
 *   - each answer is one cost_events row with the helper billing code and no agent;
 *   - page context is masked again on the server.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function completion(text: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0012 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describeDb("helper service (Ask Paperclip, Phase 1)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-helper-${randomUUID()}`);
  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("helper-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(secretAccessEvents);
    await db.delete(companyHelperSettings);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(modelDirectoryEntries);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seedCompany(status: "active" | "paused" = "active") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Acme",
      issuePrefix: `H${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
    });
    return id;
  }

  async function seedEntry(companyId: string, input: Partial<typeof modelDirectoryEntries.$inferInsert> = {}) {
    const [row] = await db
      .insert(modelDirectoryEntries)
      .values({
        companyId,
        name: `Model ${randomUUID().slice(0, 6)}`,
        provider: "openrouter",
        model: "vendor/small-model",
        baseUrl: null,
        ...input,
      })
      .returning();
    return row!;
  }

  function fakeClaude() {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "1. Open the page.\n2. Fill the field." }],
      usage: { input_tokens: 300, output_tokens: 40 },
      stop_reason: "end_turn",
    });
    return { create, createModelClient: () => ({ messages: { create } }) as never };
  }

  it("answers with the built-in default, offers no tools, masks context, and records one cost row with no agent", async () => {
    const companyId = await seedCompany();
    const claude = fakeClaude();
    const result = await helperService(db, { createModelClient: claude.createModelClient }).ask({
      companyId,
      userId: "filip",
      message: "What do I put here?",
      context: "Field: API key\nValue: sk-abcdefghijklmnopqrstuv\nLabel: Instructions",
      pageRoute: "/ACM/agents/front-desk/configuration",
    });

    expect(result.answer).toContain("Open the page");
    expect(result.directoryEntryId).toBeNull();
    expect(result.provider).toBe("anthropic");
    expect(claude.create).toHaveBeenCalledTimes(1);
    const request = claude.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(serialized).toContain("[hidden]");
    expect(serialized).toContain("/ACM/agents/front-desk/configuration");
    expect(String(request.system)).toMatch(/Never say or imply that you did/);

    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ agentId: null, billingCode: HELPER_BILLING_CODE, provider: "anthropic" });
  });

  it("refuses a saved model of another company, and an archived one, before calling anything", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreign = await seedEntry(otherCompanyId, { provider: "local", baseUrl: "http://localhost:11434/v1", model: "llama3" });
    const archived = await seedEntry(companyId, { provider: "local", baseUrl: "http://localhost:11434/v1", model: "llama3", archivedAt: new Date() });
    const providerFetch = vi.fn();
    const svc = helperService(db, { providerFetch: providerFetch as never });

    await expect(svc.ask({ companyId, userId: "filip", message: "hi", directoryEntryId: foreign.id })).rejects.toMatchObject({ status: 404 });
    await expect(svc.ask({ companyId, userId: "filip", message: "hi", directoryEntryId: archived.id })).rejects.toMatchObject({ status: 422 });
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(svc.updateSettings(companyId, { defaultDirectoryEntryId: foreign.id }, { userId: "filip" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("says plainly where to set a key when the helper has none for the saved model's provider", async () => {
    const companyId = await seedCompany();
    const entry = await seedEntry(companyId, { name: "Cheap OpenRouter" });
    const providerFetch = vi.fn();
    const err = await helperService(db, { providerFetch: providerFetch as never })
      .ask({ companyId, userId: "filip", message: "hi", directoryEntryId: entry.id })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, details: { code: "HELPER_KEY_MISSING" } });
    expect(String((err as Error).message)).toContain("Company settings → General → Helper");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.select().from(costEvents)).toHaveLength(0);

    const view = await helperService(db).getSettings(companyId, { canEdit: true });
    expect(view.models.find((m) => m.id === entry.id)).toMatchObject({ keyReady: false });
  });

  it("uses the picked key through the binding gate, for the default saved model", async () => {
    const companyId = await seedCompany();
    const entry = await seedEntry(companyId, { name: "Cheap OpenRouter" });
    const keyValue = `sk-or-${randomUUID()}`;
    const secret = await secretService(db).create(companyId, { name: "OpenRouter key", provider: "local_encrypted", value: keyValue });
    const providerFetch = vi.fn().mockResolvedValue(completion("Here is the text."));
    const svc = helperService(db, { providerFetch: providerFetch as never });

    await svc.updateSettings(companyId, { defaultDirectoryEntryId: entry.id, keys: { openrouter: secret.id } }, { userId: "filip" });
    const view = await svc.getSettings(companyId, { canEdit: true });
    expect(view.defaultDirectoryEntryId).toBe(entry.id);
    expect(view.keys.find((k) => k.provider === "openrouter")).toMatchObject({ secretId: secret.id, status: "ok" });
    expect(JSON.stringify(view)).not.toContain(keyValue);

    const result = await svc.ask({ companyId, userId: "filip", message: "Write it" });
    expect(result).toMatchObject({ directoryEntryId: entry.id, provider: "openrouter", model: "vendor/small-model" });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [, init] = providerFetch.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization ?? (init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${keyValue}`,
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();

    const audit = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ consumerType: HELPER_BINDING_TARGET_TYPE, consumerId: companyId, configPath: "helper.apiKey.openrouter", outcome: "success" });
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(cost).toMatchObject({ provider: "openrouter", billingCode: HELPER_BILLING_CODE, agentId: null });

    // Removing the pick removes the binding.
    await svc.updateSettings(companyId, { keys: { openrouter: null } }, { userId: "filip" });
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toHaveLength(0);
  });

  it("refuses to answer for a paused company", async () => {
    const companyId = await seedCompany("paused");
    const claude = fakeClaude();
    await expect(
      helperService(db, { createModelClient: claude.createModelClient }).ask({ companyId, userId: "filip", message: "hi" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(claude.create).not.toHaveBeenCalled();
  });
});
