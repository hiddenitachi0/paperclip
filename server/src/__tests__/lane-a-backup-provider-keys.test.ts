import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
  secretAccessEvents,
} from "@paperclipai/db";
import { laneAProviderKeyConfigPath, type LaneABackupModelConfig } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";

// A quick agent's backup on a DIFFERENT provider than its main model uses the
// agent's own key for that provider (adapterConfig.laneA.apiKeyByProvider.
// <provider>), resolved through the same binding gate and audit trail as the
// main key. The case this exists for: a local model as the main model, an
// OpenRouter model as the backup for when the computer running the local
// model is switched off.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Lane A backup-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const LOCAL_URL = "http://filips-pc.tailnet.example:11434/v1";
const OPENROUTER_BACKUP: LaneABackupModelConfig = {
  id: "bk_or",
  provider: "openrouter",
  model: "meta-llama/llama-3.3-70b-instruct",
};

function completionResponse(text: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function secretRef(secretId: string) {
  return { type: "secret_ref" as const, secretId, version: "latest" as const };
}

describeEmbeddedPostgres("lane A backups use the key for their own provider", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-lane-a-backup-keys-${randomUUID()}`);

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("lane-a-backup-keys");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    await import("../services/lane-a.ts");
  }, 90_000);

  afterEach(async () => {
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Nordstrand") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedSecret(companyId: string, value: string) {
    return secretService(db).create(companyId, {
      name: `key-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  /** A quick agent on a local model with the given backups and the given laneA adapter config. */
  async function seedLocalQuickAgent(
    companyId: string,
    input: { laneA?: Record<string, unknown>; backups: LaneABackupModelConfig[]; noAnswerChain: string[] },
  ) {
    const created = await agentService(db).create(companyId, {
      name: "Front desk",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: input.laneA ? { laneA: input.laneA } : {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db
      .update(agents)
      .set({
        laneAEnabled: true,
        laneAProvider: "local",
        laneAModel: "llama3.1",
        laneABaseUrl: LOCAL_URL,
        laneABackupModels: input.backups,
        laneANoAnswerChainIds: input.noAnswerChain,
      })
      .where(eq(agents.id, created.id));
    return {
      id: created.id,
      companyId,
      name: created.name,
      laneAEnabled: true,
      laneAProvider: "local",
      laneAModel: "llama3.1",
      laneABaseUrl: LOCAL_URL,
    };
  }

  /**
   * The local model's computer is off: every request to it fails the way a
   * switched-off machine does. Every other request is answered and recorded.
   */
  function stubProviders() {
    const localAttempts: string[] = [];
    const calls: Array<{ url: string; authorization: string | undefined; model: unknown }> = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://filips-pc.tailnet.example")) {
        localAttempts.push(url);
        throw new TypeError("fetch failed: connect ECONNREFUSED");
      }
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({
        url,
        authorization: headers.authorization ?? headers.Authorization,
        model: (JSON.parse(String(init?.body)) as { model?: unknown }).model,
      });
      return completionResponse("Hei fra OpenRouter");
    }) as unknown as typeof fetch;
    return { providerFetch, localAttempts, calls };
  }

  it("falls from an unreachable local model to the OpenRouter backup, with the agent's OpenRouter key", async () => {
    const companyId = await seedCompany();
    const orValue = `sk-or-v1-${randomUUID()}`;
    const orSecret = await seedSecret(companyId, orValue);
    const target = await seedLocalQuickAgent(companyId, {
      laneA: { apiKeyByProvider: { openrouter: secretRef(orSecret.id) } },
      backups: [OPENROUTER_BACKUP],
      noAnswerChain: ["bk_or"],
    });
    const { providerFetch, localAttempts, calls } = stubProviders();
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { providerFetch }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hi",
    });

    // The person is told once that the local model is off, and who answered.
    expect(result.response).toBe(
      "Front desk's local model is offline, answered with meta-llama/llama-3.3-70b-instruct.\n\nHei fra OpenRouter",
    );
    expect(localAttempts.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      authorization: `Bearer ${orValue}`,
      model: "meta-llama/llama-3.3-70b-instruct",
    });
    // Read through the binding gate at the per-provider path, and audited.
    const audit = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, orSecret.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      consumerId: target.id,
      configPath: laneAProviderKeyConfigPath("openrouter"),
      outcome: "success",
    });

    // The transform path takes the same route.
    calls.length = 0;
    const transformed = await laneAService(db, { providerFetch }).transform({
      companyId,
      targetAgent: target,
      input: "Gammel tekst.",
    });
    expect(transformed).toMatchObject({ text: "Hei fra OpenRouter", provider: "openrouter" });
    expect(calls[0]!.authorization).toBe(`Bearer ${orValue}`);
  });

  it("never sends the main model's key to a backup on another provider", async () => {
    const companyId = await seedCompany();
    const localValue = `local-${randomUUID()}`;
    const orValue = `sk-or-v1-${randomUUID()}`;
    const localSecret = await seedSecret(companyId, localValue);
    const orSecret = await seedSecret(companyId, orValue);
    const target = await seedLocalQuickAgent(companyId, {
      laneA: { apiKey: secretRef(localSecret.id), apiKeyByProvider: { openrouter: secretRef(orSecret.id) } },
      backups: [OPENROUTER_BACKUP],
      noAnswerChain: ["bk_or"],
    });
    const { providerFetch, calls } = stubProviders();
    const { laneAService } = await import("../services/lane-a.ts");

    await laneAService(db, { providerFetch }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hi",
    });
    expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${orValue}`]);
  });

  it("skips a backup that has no key for its provider, with a plain reason, and moves on", async () => {
    const companyId = await seedCompany();
    const { providerFetch, calls } = stubProviders();
    const { laneAService } = await import("../services/lane-a.ts");

    // Alone: the turn ends with the plain reason the backup could not run.
    const alone = await seedLocalQuickAgent(companyId, {
      backups: [OPENROUTER_BACKUP],
      noAnswerChain: ["bk_or"],
    });
    await expect(
      laneAService(db, { providerFetch }).sendMessage({
        companyId,
        targetAgent: alone,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining(
        "The OpenRouter backup was skipped: this quick agent has no OpenRouter key. Pick one on the backup under the quick agent's backup models.",
      ),
      details: { code: "LANE_A_KEY_MISSING", provider: "openrouter" },
    });
    expect(calls).toHaveLength(0);

    // Followed by a backup that has a key: the keyless one is skipped, never called.
    const orValue = `sk-or-v1-${randomUUID()}`;
    const orSecret = await seedSecret(companyId, orValue);
    const withNext = await seedLocalQuickAgent(companyId, {
      laneA: { apiKeyByProvider: { openrouter: secretRef(orSecret.id) } },
      backups: [{ id: "bk_openai", provider: "openai", model: "gpt-4.1-mini" }, OPENROUTER_BACKUP],
      noAnswerChain: ["bk_openai", "bk_or"],
    });
    const result = await laneAService(db, { providerFetch }).sendMessage({
      companyId,
      targetAgent: withNext,
      requester: { userId: "filip", agentId: null },
      message: "hi",
    });
    expect(result.response).toContain("Hei fra OpenRouter");
    expect(calls.map((c) => c.url)).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });

  it("does not send the agent's OpenRouter key to a backup at another OpenRouter address", async () => {
    const companyId = await seedCompany();
    const orSecret = await seedSecret(companyId, `sk-or-v1-${randomUUID()}`);
    const target = await seedLocalQuickAgent(companyId, {
      laneA: { apiKeyByProvider: { openrouter: secretRef(orSecret.id) } },
      backups: [{ ...OPENROUTER_BACKUP, baseUrl: "https://collector.example/v1" }],
      noAnswerChain: ["bk_or"],
    });
    const { providerFetch, calls } = stubProviders();
    const { laneAService } = await import("../services/lane-a.ts");
    await expect(
      laneAService(db, { providerFetch }).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503, details: { code: "LANE_A_KEY_MISSING" } });
    expect(calls).toHaveLength(0);
  });

  it("refuses another company's secret as a backup key, on save and at call time", async () => {
    const companyId = await seedCompany("Nordstrand");
    const otherCompanyId = await seedCompany("Someone else");
    const foreignValue = `sk-or-v1-${randomUUID()}`;
    const foreignSecret = await seedSecret(otherCompanyId, foreignValue);

    // On save: the binding cannot be made.
    const target = await seedLocalQuickAgent(companyId, { backups: [OPENROUTER_BACKUP], noAnswerChain: ["bk_or"] });
    await expect(
      agentService(db).update(target.id, {
        adapterConfig: { laneA: { apiKeyByProvider: { openrouter: secretRef(foreignSecret.id) } } },
      }),
    ).rejects.toThrow(/same company/i);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, foreignSecret.id))).toHaveLength(0);

    // Planted straight into the row anyway: the call refuses it and the
    // backup is skipped; the foreign key is never read or sent.
    await db
      .update(agents)
      .set({ adapterConfig: { laneA: { apiKeyByProvider: { openrouter: secretRef(foreignSecret.id) } } } })
      .where(eq(agents.id, target.id));
    const { providerFetch, calls } = stubProviders();
    const { laneAService } = await import("../services/lane-a.ts");
    await expect(
      laneAService(db, { providerFetch }).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503, details: { code: "LANE_A_KEY_UNRESOLVED", provider: "openrouter" } });
    expect(calls).toHaveLength(0);
    const audit = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, foreignSecret.id));
    expect(audit.filter((row) => row.outcome === "success")).toHaveLength(0);
  });
});
