import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.js";

// DUR-3980: an agent could attach any saved password in its company to itself
// and read its value on the next run. These tests prove the gate that stops an
// agent ADDING a secret_ref to any agent record, while every legitimate flow
// (board binds, server flows bind, the agent keeps or removes what it already
// holds, and rollback restores only refs it was once given) still works.

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3980 tests: ${support.reason ?? "unsupported environment"}`);
}

const agentActor = (agentId: string) => ({ actorType: "agent" as const, agentId });
const boardActor = { actorType: "user" as const, agentId: null };
const secretRef = (secretId: string) => ({ type: "secret_ref" as const, secretId, version: "latest" as const });

d("DUR-3980 agent secret self-binding", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur3980-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur3980");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
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

  async function makeSecret(companyId: string, name = `secret-${randomUUID()}`) {
    return secretService(db).create(companyId, { name, provider: "local_encrypted", value: `val-${name}` });
  }

  async function makeAgent(
    companyId: string,
    adapterConfig: Record<string, unknown> = { command: "echo" },
    adapterType = "process",
  ) {
    // Created as a server flow (no actor) so seeding is never blocked.
    return agentService(db).create(companyId, {
      name: `A-${randomUUID().slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig,
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  // A complete config-revision snapshot (configPatchFromSnapshot validates
  // name/role/adapterType/budgetMonthlyCents), with a chosen adapterConfig.
  function snapshotOf(
    agent: { name: string; role: string; adapterType: string },
    adapterConfig: Record<string, unknown>,
  ) {
    return {
      name: agent.name,
      role: agent.role,
      title: null,
      icon: null,
      tone: null,
      personality: null,
      reportsTo: null,
      capabilities: null,
      adapterType: agent.adapterType,
      adapterConfig,
      runtimeConfig: {},
      defaultEnvironmentId: null,
      budgetMonthlyCents: 0,
      metadata: null,
      permissions: {},
    };
  }

  async function bindingsFor(companyId: string, agentId: string) {
    return db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agentId),
      ));
  }

  // ---- The hole, and its closure ------------------------------------------

  it("REFUSES an agent adding a NEW env secret_ref to its own record, and writes no binding", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId);

    await expect(
      agentService(db).update(agent.id, {
        adapterConfig: { command: "echo", env: { STOLEN: secretRef(secret.id) } },
      }, { actor: agentActor(agent.id) }),
    ).rejects.toMatchObject({ status: 403 });

    expect(await bindingsFor(companyId, agent.id)).toHaveLength(0);
  });

  it("REFUSES an agent adding a NEW mcpServers secret_ref to its own record (the DUR-132 self-bind is now closed)", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId, {}, "claude_local");

    await expect(
      agentService(db).update(agent.id, {
        adapterConfig: {
          mcpServers: [{ name: "fs", command: "npx", env: { TOKEN: secretRef(secret.id) } }],
        },
      }, { actor: agentActor(agent.id) }),
    ).rejects.toMatchObject({ status: 403 });

    expect(await bindingsFor(companyId, agent.id)).toHaveLength(0);
  });

  it("REFUSES an agent adding a secret_ref through a runtimeConfig model profile", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId, {}, "claude_local");

    await expect(
      agentService(db).update(agent.id, {
        runtimeConfig: {
          modelProfiles: { cheap: { adapterConfig: { env: { STOLEN: secretRef(secret.id) } } } },
        },
      }, { actor: agentActor(agent.id) }),
    ).rejects.toMatchObject({ status: 403 });

    expect(await bindingsFor(companyId, agent.id)).toHaveLength(0);
  });

  it("REFUSES an agent hiring/creating an agent that carries a secret_ref", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);

    await expect(
      agentService(db).create(companyId, {
        name: "Minted",
        role: "engineer",
        status: "pending_approval",
        adapterType: "claude_local",
        adapterConfig: { env: { STOLEN: secretRef(secret.id) } },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }, { actor: agentActor(randomUUID()) }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("the refusal names the credential_request approval path", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId);
    const err = await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo", env: { STOLEN: secretRef(secret.id) } },
    }, { actor: agentActor(agent.id) }).catch((e) => e);
    expect(String(err.message)).toContain("credential_request");
    expect(String(err.message).toLowerCase()).toContain("board");
  });

  // ---- Legitimate flows still work ----------------------------------------

  it("ALLOWS an agent self-update that keeps its existing env secret_ref while changing an unrelated field", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    // Board attaches the secret first.
    const agent = await makeAgent(companyId, { command: "echo", env: { KEY: secretRef(secret.id) } });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);

    const updated = await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo2", env: { KEY: secretRef(secret.id) } },
      capabilities: "does things",
    }, { actor: agentActor(agent.id) });

    expect(updated?.capabilities).toBe("does things");
    const rows = await bindingsFor(companyId, agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ secretId: secret.id, configPath: "env.KEY" });
  });

  it("ALLOWS an agent removing a secret_ref from itself", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId, { command: "echo", env: { KEY: secretRef(secret.id) } });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);

    await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo", env: {} },
    }, { actor: agentActor(agent.id) });

    expect(await bindingsFor(companyId, agent.id)).toHaveLength(0);
  });

  it("ALLOWS an agent pasting a literal into an adapter secret field on itself (it minted the secret)", async () => {
    const companyId = await seedCompany();
    const agent = await makeAgent(companyId, { apiBaseUrl: "https://h.example" }, "hermes_gateway");

    // Route layer records this agent as the secret's creator.
    const normalized = await secretService(db).normalizeAdapterConfigForPersistence(
      companyId,
      { apiBaseUrl: "https://h.example", apiKey: `literal-${randomUUID()}` },
      { adapterType: "hermes_gateway", actor: { agentId: agent.id } },
    );
    const updated = await agentService(db).update(agent.id, {
      adapterConfig: normalized,
    }, { actor: agentActor(agent.id) });

    expect((updated?.adapterConfig as Record<string, unknown>).apiKey).toMatchObject({ type: "secret_ref" });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);
  });

  it("ALLOWS a board caller to bind a secret to an agent", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId);

    await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo", env: { KEY: secretRef(secret.id) } },
    }, { actor: boardActor });

    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);
  });

  it("ALLOWS a server-side flow (no actor) to bind a secret to an agent", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId);

    await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo", env: { KEY: secretRef(secret.id) } },
    });

    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);
  });

  // ---- Rollback -----------------------------------------------------------

  it("ALLOWS an agent rollback that restores a secret_ref the agent was once given (board-granted), and REFUSES one it never had", async () => {
    const companyId = await seedCompany();
    const granted = await makeSecret(companyId, `granted-${randomUUID()}`);
    const agent = await makeAgent(companyId);

    // Board grants the ref (records a revision), then the agent removes it.
    await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo", env: { KEY: secretRef(granted.id) } },
    }, { actor: boardActor, recordRevision: { createdByUserId: "board", source: "patch" } });
    const withRef = await db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agent.id))
      .then((rows) => rows[rows.length - 1]!);
    await agentService(db).update(agent.id, {
      adapterConfig: { command: "echo", env: {} },
    }, { actor: agentActor(agent.id), recordRevision: { createdByAgentId: agent.id, source: "patch" } });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(0);

    // Rollback to the board-granted revision: allowed, ref restored.
    await agentService(db).rollbackConfigRevision(agent.id, withRef.id, {
      agentId: agent.id,
      actorType: "agent",
    });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);

    // A fabricated agent-authored revision that introduces a never-held ref
    // (the pre-fix hole shape) must NOT be restorable by the agent.
    const never = await makeSecret(companyId, `never-${randomUUID()}`);
    const [fakeRevision] = await db.insert(agentConfigRevisions).values({
      companyId,
      agentId: agent.id,
      createdByAgentId: agent.id,
      source: "patch",
      changedKeys: ["adapterConfig"],
      beforeConfig: snapshotOf(agent, { command: "echo" }),
      afterConfig: snapshotOf(agent, { command: "echo", env: { NEVER: secretRef(never.id) } }),
    }).returning();

    await expect(
      agentService(db).rollbackConfigRevision(agent.id, fakeRevision.id, {
        agentId: agent.id,
        actorType: "agent",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("ALLOWS a board rollback to any revision, even one restoring a never-held ref", async () => {
    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId);
    const [revision] = await db.insert(agentConfigRevisions).values({
      companyId,
      agentId: agent.id,
      createdByAgentId: agent.id,
      source: "patch",
      changedKeys: ["adapterConfig"],
      beforeConfig: snapshotOf(agent, { command: "echo" }),
      afterConfig: snapshotOf(agent, { command: "echo", env: { KEY: secretRef(secret.id) } }),
    }).returning();

    await agentService(db).rollbackConfigRevision(agent.id, revision.id, {
      userId: "board",
      actorType: "user",
    });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);
  });

  // ---- Route-level: the whole path an attacker would take -----------------

  it("route: an agent GETs a secret id off a project but its self-PATCH with it is refused (403) and binds nothing", async () => {
    const { agentRoutes } = await import("../routes/agents.js");
    const { projectRoutes } = await import("../routes/projects.js");
    const { errorHandler } = await import("../middleware/index.js");

    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId);
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Dash",
      env: { DATA_KEY: secretRef(secret.id) },
    } as never);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = {
        type: "agent", agentId: agent.id, companyId, source: "agent_key", runId: null,
      };
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const seen = await request(app).get(`/api/projects/${projectId}`);
    expect(seen.body.env?.DATA_KEY?.secretId).toBe(secret.id);

    const patch = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: { STOLEN: secretRef(secret.id) } } });
    expect(patch.status).toBe(403);
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(0);
  });

  it("route: an agent self-PATCH that omits env does not wipe a board-set binding", async () => {
    const { agentRoutes } = await import("../routes/agents.js");
    const { errorHandler } = await import("../middleware/index.js");

    const companyId = await seedCompany();
    const secret = await makeSecret(companyId);
    const agent = await makeAgent(companyId, { command: "echo", env: { KEY: secretRef(secret.id) } });
    expect(await bindingsFor(companyId, agent.id)).toHaveLength(1);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = {
        type: "agent", agentId: agent.id, companyId, source: "agent_key", runId: null,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const patch = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ capabilities: "unrelated change" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const rows = await bindingsFor(companyId, agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ secretId: secret.id, configPath: "env.KEY" });
  });

  // ---- Rule 3 (recurring bug): a new save path must not slip past ----------

  it("no unreviewed agentService save path exists (enumerate the real surface)", () => {
    // Every function agentService exposes. If a NEW one appears, this fails so
    // the author must classify it: does it persist adapterConfig/runtimeConfig
    // as the agent? If so, route it through updateAgent/create (which run the
    // DUR-3980 gate) and add it below.
    const svc = agentService(db) as Record<string, unknown>;
    const methods = Object.keys(svc).filter((k) => typeof svc[k] === "function").sort();

    // The only functions that persist an agent's adapterConfig/runtimeConfig.
    // update + create carry the gate directly; rollbackConfigRevision funnels
    // through update; syncMcpToolSelection is board-only (route layer) and
    // resyncs bindings from already-granted tools; activatePendingApproval
    // changes only status. Nothing else writes config.
    const CONFIG_SAVE_PATHS = ["create", "rollbackConfigRevision", "syncMcpToolSelection", "update"];
    const GATED = ["create", "rollbackConfigRevision", "update"]; // accept an agent actor

    const REVIEWED_METHODS = [
      "activatePendingApproval", "clearError", "create", "createApiKey", "getById",
      "getChainOfCommand", "getConfigRevision", "getKeyById", "list", "listConfigRevisions",
      "listKeys", "orgForCompany", "pause", "remove", "resolveByReference", "resume",
      "revokeKey", "rollbackConfigRevision", "runningForAgent", "syncMcpToolSelection",
      "syncPluginToolGrants", "terminate", "update", "updatePermissions",
    ].sort();

    expect(methods).toEqual(REVIEWED_METHODS);
    for (const p of [...CONFIG_SAVE_PATHS, ...GATED]) expect(methods).toContain(p);
  });
});
