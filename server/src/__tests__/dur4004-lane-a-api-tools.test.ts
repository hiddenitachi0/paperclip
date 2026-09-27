import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@paperclipai/db";
import { activityLog, agents, companies, companyApiToolCalls, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { chatRouterRoutes } from "../routes/chat-router.js";
import { agentService } from "../services/agents.js";
import { apiToolService } from "../services/api-tools.js";
import { loadLaneAApiTools } from "../services/lane-a-api-tools.js";
import type { LaneAModelClient } from "../services/lane-a.js";
import { secretService } from "../services/secrets.js";

/**
 * DUR-4004: "API with a key" tools for quick agents (Lane A), end to end
 * through POST /chat/:agentId/messages with a scripted model (no Anthropic
 * key anywhere) and a local fake service behind the outbound guard.
 *
 *  - a ticked-on tool's actions are offered as `<key>__<action>` with the
 *    action's input schema; an unticked or switched-off tool is not offered
 *  - when the model calls one, the request goes out with the key attached
 *    server-side, the answer comes back to the model as text, the reply is
 *    built from it, the call is in activity_log and company_api_tool_calls
 *  - the key is nowhere in the response, the model's view, or the database
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4004 Lane A api-tools tests: ${support.reason ?? "unsupported environment"}`);
}

const KEY = "sk-" + "laneAtestkey0123456789abcdefghijklmn";
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

type ModelStep = (params: { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string; input_schema?: unknown }>; system?: string }) => unknown;

function scriptedModel(steps: ModelStep[]) {
  const calls: Array<{ tools: Array<{ name: string; input_schema?: unknown }>; system: string; messages: Array<{ role: string; content: unknown }> }> = [];
  const create = vi.fn(async (params: Parameters<ModelStep>[0]) => {
    calls.push({ tools: params.tools ?? [], system: String(params.system ?? ""), messages: params.messages });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`model called ${calls.length} times, only ${steps.length} steps scripted`);
    return step(params);
  });
  return { create, calls, client: () => ({ messages: { create } }) as unknown as LaneAModelClient };
}

let callSeq = 0;
function callTool(name: string, input: Record<string, unknown>): ModelStep {
  return () => ({
    content: [{ type: "tool_use", id: `call_${(callSeq += 1)}`, name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "tool_use",
  });
}

function lastToolOutput(params: Parameters<ModelStep>[0]): string {
  const last = params.messages[params.messages.length - 1]!;
  const blocks = last.content as Array<{ type: string; content?: string }>;
  return blocks.find((block) => block.type === "tool_result")?.content ?? "";
}

function reply(text: string | ((toolOutput: string) => string)): ModelStep {
  return (params) => ({
    content: [{ type: "text", text: typeof text === "function" ? text(lastToolOutput(params)) : text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  });
}

d("DUR-4004 Lane A: API tools for quick agents", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur4004-lane-a-${randomUUID()}`);
  let server: http.Server;
  let port = 0;
  const hits: Array<{ url: string; authorization: string | undefined; body: string }> = [];

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    delete process.env.ANTHROPIC_API_KEY;
    const started = await startEmbeddedPostgresTestDatabase("dur4004-lane-a-api-tools");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        hits.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ images: [{ url: "https://cdn.example.com/cat.png" }], echoedKey: req.headers.authorization, prompt: body ? JSON.parse(body).prompt : null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }, 60_000);

  // Every test seeds its own company (Lane A leaves cost rows behind that
  // point at the agent, so rows are not deleted between tests).
  afterEach(() => {
    hits.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const apiToolDeps = () => ({ lookup: PUBLIC, testOnlyDial: { host: "127.0.0.1", port } });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedQuickAgent(companyId: string, apiToolIds: string[] = []) {
    const created = await agentService(db).create(companyId, {
      name: "Picture maker",
      role: "designer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true, apiToolIds }).where(eq(agents.id, created.id));
    return created;
  }

  async function seedTool(companyId: string, name = "Fal.ai") {
    const secret = await secretService(db).create(companyId, { name: `key-${randomUUID().slice(0, 8)}`, provider: "local_encrypted", value: KEY, kind: "other" });
    return apiToolService(db).create(
      companyId,
      {
        name,
        description: "Makes images",
        baseUrl: "https://fal.run",
        auth: { kind: "header", name: "Authorization", prefix: "Key ", secretId: secret.id },
        actions: [
          { name: "make_image", method: "POST", path: "/fal-ai/flux/dev", description: "Make an image from a text prompt", inputs: [{ name: "prompt", type: "string", required: true, description: "What to draw" }] },
          { name: "status", method: "GET", path: "/requests/{id}/status", description: "Check a request", inputs: [{ name: "id", type: "string", required: true }] },
        ],
        dailyCap: 300,
        status: "active",
      },
      { userId: "filip" },
    );
  }

  function boardActor(companyIds: string[]) {
    return {
      type: "board",
      source: "session",
      userId: "filip",
      isInstanceAdmin: false,
      companyIds,
      memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole: "owner" })),
    };
  }

  function chatApp(actor: Record<string, unknown>, model: ReturnType<typeof scriptedModel>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", chatRouterRoutes(db, { laneA: { createModelClient: model.client, apiTools: apiToolDeps() } }));
    app.use(errorHandler);
    return app;
  }

  async function dumpDatabase(): Promise<string> {
    const names = Object.values(dbExports)
      .filter((value) => value instanceof PgTable)
      .map((table) => getTableConfig(table as Parameters<typeof getTableConfig>[0]).name);
    const parts: string[] = [];
    for (const name of [...new Set(names)]) {
      if (name === "company_secret_versions") continue;
      const rows = (await db.execute(sql.raw(`SELECT row_to_json(t)::text AS j FROM "${name}" t`))) as unknown as Array<{ j: string }>;
      for (const row of rows) parts.push(`${name}: ${row.j}`);
    }
    return parts.join("\n");
  }

  it("offers a ticked-on tool's actions as <key>__<action> with the input schema, and runs one end to end", async () => {
    const companyId = await seedCompany();
    const tool = await seedTool(companyId);
    const agent = await seedQuickAgent(companyId, [tool.id]);
    const model = scriptedModel([
      callTool("fal-ai__make_image", { prompt: "a cat on a sofa" }),
      reply((toolOutput) => `Done. ${toolOutput.includes("cdn.example.com/cat.png") ? "Here is your picture: https://cdn.example.com/cat.png" : "No picture came back."}`),
    ]);

    const res = await request(chatApp(boardActor([companyId]), model))
      .post(`/api/chat/${agent.id}/messages`)
      .send({ companyId, message: "Make me a picture of a cat on a sofa", laneHint: "a" });
    expect(res.status).toBe(200);
    expect(res.body.result.response).toBe("Done. Here is your picture: https://cdn.example.com/cat.png");

    // Offered with the action's schema, next to the built-ins.
    const offered = model.calls[0]!.tools;
    const names = offered.map((offer) => offer.name);
    expect(names).toContain("fal-ai__make_image");
    expect(names).toContain("fal-ai__status");
    expect(names).toContain("route_to_agent");
    expect(offered.find((offer) => offer.name === "fal-ai__make_image")!.input_schema).toEqual({
      type: "object",
      properties: { prompt: { type: "string", description: "What to draw" } },
      required: ["prompt"],
      additionalProperties: false,
    });
    expect(model.calls[0]!.system).toContain("Tools library");

    // The request went out with the key attached by the server, as JSON.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe("/fal-ai/flux/dev");
    expect(hits[0]!.authorization).toBe(`Key ${KEY}`);
    expect(JSON.parse(hits[0]!.body)).toEqual({ prompt: "a cat on a sofa" });

    // What the model saw: status line, scrubbed body, the link.
    const toolOutput = lastToolOutput(model.calls[1]! as unknown as Parameters<ModelStep>[0]);
    expect(toolOutput).toMatch(/^HTTP 200 \(application\/json\)/);
    expect(toolOutput).toContain("Links in the answer:\n- https://cdn.example.com/cat.png");
    expect(toolOutput).not.toContain(KEY);

    // Audited twice: the activity log (like every quick-agent tool call) and the tool's own call table.
    const calls = await db.select().from(companyApiToolCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ companyId, toolId: tool.id, action: "make_image", channel: "quick_chat", agentId: agent.id, status: "ok", httpStatus: 200 });
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activity.some((row) => JSON.stringify(row.details ?? {}).includes("fal-ai__make_image"))).toBe(true);

    // The key is nowhere in the reply, the model's transcript, or the database.
    const everything = `${JSON.stringify(res.body)}\n${JSON.stringify(model.calls)}\n${await dumpDatabase()}`;
    expect(everything).not.toContain(KEY);
  });

  it("does not offer an unticked tool or a switched-off one, so plain chat is unchanged", async () => {
    const companyId = await seedCompany();
    const unticked = await seedTool(companyId, "Unticked");
    const off = await seedTool(companyId, "Off");
    await apiToolService(db).update(companyId, off.id, { status: "disabled" });
    const agent = await seedQuickAgent(companyId, [off.id]);
    const model = scriptedModel([reply("Hello!")]);

    const res = await request(chatApp(boardActor([companyId]), model))
      .post(`/api/chat/${agent.id}/messages`)
      .send({ companyId, message: "Hi", laneHint: "a" });
    expect(res.status).toBe(200);
    const names = model.calls[0]!.tools.map((offer) => offer.name);
    expect(names.filter((name) => name.includes("__"))).toEqual([]);
    expect(model.calls[0]!.system).not.toContain("Tools library");
    expect(unticked.id).toBeTruthy();
    expect(hits).toHaveLength(0);
  });

  it("hands the model a plain sentence when the call is refused (missing input), without a request going out", async () => {
    const companyId = await seedCompany();
    const tool = await seedTool(companyId);
    const agent = await seedQuickAgent(companyId, [tool.id]);
    const toolset = await loadLaneAApiTools(db, companyId, agent.id, apiToolDeps());
    const loaded = toolset.toolIndex.get("fal-ai__make_image")!;
    const result = await loaded.client.callTool({ name: "make_image", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe('Missing required input "prompt" for the action "make_image".');
    expect(hits).toHaveLength(0);
    expect(await db.select().from(companyApiToolCalls).where(eq(companyApiToolCalls.companyId, companyId))).toHaveLength(0);
  });
});
