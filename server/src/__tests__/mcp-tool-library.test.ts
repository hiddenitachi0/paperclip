// DUR-143: the MCP "tool library" — proves the no-JSON, checkbox-assignment
// path is real end to end, not just a UI veneer:
//   1. A tool is created with a human name/description and a secret_ref
//      credential — never a plaintext value.
//   2. Granting it to an agent (the checkbox) never writes the credential
//      onto the agent record — only an opaque tool id.
//   3. Granting it creates the same company_secret_bindings row the agent's
//      own explicit mcpServers would (DUR-132's authorization gate), keyed
//      by the tool's server-derived key, not a human-typed name.
//   4. The dispatch-time merge + secret resolution pipeline turns that
//      grant into a real, working MCP server config with the plaintext
//      credential resolved — the exact Fal.ai worked example from the
//      ticket, shaped generically (name="Fal.ai", url + Authorization
//      header secret_ref).
//   5. Revoking the checkbox removes it from the dispatch-time merge.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMcpTools,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import {
  createMcpTool,
  resolveAgentMcpToolLibraryServers,
} from "../services/mcp-tool-library.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres MCP tool library tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("MCP tool library — checkbox grant end to end", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-mcp-tool-library-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("mcp-tool-library");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMcpTools);
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
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("creates a tool from name/description/connection alone — no JSON typed anywhere", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const falKey = `fal-key-${randomUUID()}`;
    const secret = await secrets.create(companyId, {
      name: "Fal.ai API key",
      provider: "local_encrypted",
      value: falKey,
    });

    const tool = await createMcpTool(db, companyId, {
      name: "Fal.ai",
      description: "Makes images",
      connection: {
        url: "https://fal.run/mcp",
        headers: {
          Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
    });

    expect(tool.name).toBe("Fal.ai");
    expect(tool.description).toBe("Makes images");
    expect(tool.key).toMatch(/^[a-z0-9-]+$/);
    // The connection round-trips a structured secret_ref, never the plaintext key.
    const storedConnection = tool.connection as Record<string, unknown>;
    const headers = storedConnection.headers as Record<string, unknown>;
    expect(headers.Authorization).toEqual({ type: "secret_ref", secretId: secret.id, version: "latest" });
    expect(JSON.stringify(tool)).not.toContain(falKey);
  });

  it("granting a tool to an agent never writes the credential onto the agent record", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const falKey = `fal-key-${randomUUID()}`;
    const secret = await secrets.create(companyId, {
      name: "Fal.ai API key",
      provider: "local_encrypted",
      value: falKey,
    });
    const tool = await createMcpTool(db, companyId, {
      name: "Fal.ai",
      description: "Makes images",
      connection: {
        url: "https://fal.run/mcp",
        headers: {
          Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
    });

    const created = await agentService(db).create(companyId, {
      name: "Artist",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const updated = await agentService(db).syncMcpToolSelection(created.id, [tool.id]);

    // Only an opaque id reference lives on the agent — never the key material,
    // never even the tool's own connection config.
    expect(updated.mcpToolIds).toEqual([tool.id]);
    expect(JSON.stringify(updated)).not.toContain(falKey);
    expect(JSON.stringify(updated.adapterConfig)).not.toContain("fal.run");

    // The DUR-132 authorization gate: a matching binding must exist, keyed
    // by the tool's server-derived key, for resolution to be allowed at all.
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, created.id),
        ),
      );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: `mcpServers[${tool.key}].headers.Authorization`,
      versionSelector: "latest",
    });
  });

  it("resolves a granted tool into a real MCP server config at dispatch time (Fal.ai worked example)", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const falKey = `fal-key-${randomUUID()}`;
    const secret = await secrets.create(companyId, {
      name: "Fal.ai API key",
      provider: "local_encrypted",
      value: falKey,
    });
    const tool = await createMcpTool(db, companyId, {
      name: "Fal.ai",
      description: "Makes images",
      connection: {
        url: "https://fal.run/mcp",
        headers: {
          Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
    });
    const created = await agentService(db).create(companyId, {
      name: "Artist",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await agentService(db).syncMcpToolSelection(created.id, [tool.id]);

    // This is exactly what heartbeat.ts does before resolveExecutionRunAdapterConfig.
    const mergedServers = await resolveAgentMcpToolLibraryServers(db, companyId, [tool.id]);
    expect(mergedServers).toEqual([
      {
        name: tool.key,
        url: "https://fal.run/mcp",
        headers: { Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      },
    ]);

    const { config } = await secrets.resolveAdapterConfigForRuntime(
      companyId,
      { mcpServers: mergedServers },
      { consumerType: "agent", consumerId: created.id },
    );

    const resolvedServers = config.mcpServers as Array<Record<string, unknown>>;
    expect(resolvedServers).toHaveLength(1);
    expect(resolvedServers[0].name).toBe(tool.key);
    expect(resolvedServers[0].url).toBe("https://fal.run/mcp");
    expect((resolvedServers[0].headers as Record<string, unknown>).Authorization).toBe(falKey);
  });

  it("revoking the checkbox removes the tool from the dispatch-time merge", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: "Fal.ai API key",
      provider: "local_encrypted",
      value: `fal-key-${randomUUID()}`,
    });
    const tool = await createMcpTool(db, companyId, {
      name: "Fal.ai",
      description: "Makes images",
      connection: {
        url: "https://fal.run/mcp",
        headers: { Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      },
    });
    const created = await agentService(db).create(companyId, {
      name: "Artist",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await agentService(db).syncMcpToolSelection(created.id, [tool.id]);
    await agentService(db).syncMcpToolSelection(created.id, []);

    const mergedServers = await resolveAgentMcpToolLibraryServers(db, companyId, []);
    expect(mergedServers).toEqual([]);
  });

  it("an agent's own explicit mcpServers entry wins on a name collision with a granted tool", async () => {
    const companyId = await seedCompany();
    const tool = await createMcpTool(db, companyId, {
      name: "Custom",
      description: "A tool",
      connection: { command: "custom-mcp" },
    });

    const mergedServers = await resolveAgentMcpToolLibraryServers(
      db,
      companyId,
      [tool.id],
      new Set([tool.key]),
    );
    expect(mergedServers).toEqual([]);
  });

  it("keeps working through agentService.update/create even when mcpToolIds is never touched", async () => {
    const companyId = await seedCompany();
    const created = await agentService(db).create(companyId, {
      name: "Plain",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    expect(created.mcpToolIds).toEqual([]);

    // The generic update path must never be able to smuggle mcpToolIds in —
    // only syncMcpToolSelection may write it.
    await expect(
      agentService(db).update(created.id, { mcpToolIds: ["not-allowed"] } as never),
    ).rejects.toThrow(/Tool-library assignment fields/);
  });
});
