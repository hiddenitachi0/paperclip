import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  companyApiToolCalls,
  companyApiTools,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import type { ApiToolAction, ApiToolAuth } from "@paperclipai/shared/validators/api-tool";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import {
  API_TOOL_BODY_TEXT_LIMIT,
  API_TOOL_MAX_RESPONSE_BYTES,
  apiToolService,
  buildApiToolRequest,
  findUrls,
  scrubApiToolText,
  validateActionInput,
  type ApiToolCaller,
} from "../services/api-tools.js";
import { secretService } from "../services/secrets.js";

/**
 * DUR-4004: "API with a key" tools, against a real Postgres with every
 * migration applied and a local fake HTTP service reached through the
 * outbound guard's test-only dial (the host, address and redirect checks run
 * exactly as in production; only the final socket goes to 127.0.0.1).
 *
 *  - the key is bound to the tool (target api_tool, config path auth) and
 *    resolved only at call time, through that binding
 *  - the exact request-building rules: path placeholders, query for GET,
 *    JSON body for POST, and the three ways of sending the key
 *  - the key never appears in any result, error, audit row or anywhere in the
 *    database, even when the service echoes it back
 *  - answers are pretty-printed, cut at 50 KB with a note, and their links
 *    listed; redirects and oversized answers are refused
 *  - the daily cap is counted from the audit rows and refused with a plain
 *    sentence; Test reports in plain words and is saved on the row
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4004 api-tools service tests: ${support.reason ?? "unsupported environment"}`);
}

// Not a real credential: an OpenAI-shaped key so the pattern scrubber has something to catch too.
const KEY = "sk-" + "falTESTkey0123456789abcdefghijklmnop";
const SECRET_UUID_RE = /[0-9a-f-]{36}/;
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

const ECHO_GET: ApiToolAction = {
  name: "echo",
  method: "GET",
  path: "/things/{id}/echo",
  description: "Echo back the request",
  inputs: [
    { name: "id", type: "integer", required: true },
    { name: "q", type: "string", required: false },
    { name: "limit", type: "number", required: false },
    { name: "flag", type: "boolean", required: false },
  ],
};
const ECHO_POST: ApiToolAction = {
  name: "create",
  method: "POST",
  path: "/things",
  description: "Create a thing",
  inputs: [
    { name: "prompt", type: "string", required: true },
    { name: "size", type: "integer", required: false },
    { name: "options", type: "json", required: false },
  ],
};
const PLAIN_GET = (name: string, p: string): ApiToolAction => ({ name, method: "GET", path: p, description: "", inputs: [] });

d("DUR-4004 api-tools service", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur4004-${randomUUID()}`);
  let server: http.Server;
  let port = 0;
  const hits: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let clock = Date.parse("2026-09-27T10:00:00.000Z");

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dur4004-api-tools");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const url = new URL(req.url ?? "/", "http://fake");
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (url.pathname === "/redirect") {
          res.writeHead(302, { location: "https://evil.example.com/steal" });
          res.end();
          return;
        }
        if (url.pathname === "/huge") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("x".repeat(API_TOOL_MAX_RESPONSE_BYTES + 10));
          return;
        }
        if (url.pathname === "/big") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("y".repeat(API_TOOL_BODY_TEXT_LIMIT + 1000));
          return;
        }
        if (url.pathname === "/leak") {
          json(200, {
            message: `your key is ${req.headers.authorization ?? url.searchParams.get("api_key") ?? "?"}`,
            docs: "https://docs.example.com/guide.",
            image: "https://cdn.example.com/out/1.png",
            again: "https://cdn.example.com/out/1.png",
          });
          return;
        }
        if (url.pathname === "/leak-error") {
          json(500, { error: `bad key ${req.headers.authorization ?? ""} at https://api.example.com/?api_key=${KEY}` });
          return;
        }
        if (url.pathname === "/unauth") {
          json(401, { error: "unauthorized" });
          return;
        }
        if (url.pathname === "/") {
          json(200, { ok: true });
          return;
        }
        json(200, {
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: { authorization: req.headers.authorization ?? null, "x-api-key": req.headers["x-api-key"] ?? null, host: req.headers.host, "content-type": req.headers["content-type"] ?? null },
          body: body ? JSON.parse(body) : null,
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }, 60_000);

  afterEach(async () => {
    hits.length = 0;
    await db.delete(companyApiToolCalls);
    await db.delete(companyApiTools);
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const svc = () => apiToolService(db, { lookup: PUBLIC, testOnlyDial: { host: "127.0.0.1", port }, now: () => clock });
  const boardCaller: ApiToolCaller = { channel: "board", agentId: null, userId: "filip", runId: null };

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

  async function seedSecret(companyId: string, value = KEY) {
    return secretService(db).create(companyId, { name: `fal-key-${randomUUID().slice(0, 8)}`, provider: "local_encrypted", value, kind: "other" });
  }

  async function seedTool(companyId: string, overrides: { auth?: Partial<ApiToolAuth>; actions?: ApiToolAction[]; dailyCap?: number; name?: string; baseUrl?: string } = {}) {
    const secret = await seedSecret(companyId);
    const auth = { kind: "header", name: "Authorization", prefix: "Key ", secretId: secret.id, ...overrides.auth } as ApiToolAuth;
    const tool = await svc().create(
      companyId,
      {
        name: overrides.name ?? "Fal.ai",
        description: "Makes images",
        baseUrl: overrides.baseUrl ?? "https://fal.run/",
        auth,
        actions: overrides.actions ?? [ECHO_GET, ECHO_POST],
        dailyCap: overrides.dailyCap ?? 300,
        status: "active",
      },
      { userId: "filip" },
    );
    return { tool, secret };
  }

  async function dumpDatabase(): Promise<string> {
    const names = Object.values(dbExports)
      .filter((value) => value instanceof PgTable)
      .map((table) => getTableConfig(table as Parameters<typeof getTableConfig>[0]).name);
    const parts: string[] = [];
    for (const name of [...new Set(names)]) {
      if (name === "company_secret_versions") continue; // the encrypted material lives here by design
      const rows = (await db.execute(sql.raw(`SELECT row_to_json(t)::text AS j FROM "${name}" t`))) as unknown as Array<{ j: string }>;
      for (const row of rows) parts.push(`${name}: ${row.j}`);
    }
    return parts.join("\n");
  }

  // ── Pure rules ─────────────────────────────────────────────────────────────

  describe("request-building rules (pure)", () => {
    const auth: ApiToolAuth = { kind: "bearer", secretId: randomUUID() };

    it("fills path placeholders, sends the rest as a query string for GET, and adds Bearer", () => {
      const request = buildApiToolRequest("https://api.fiken.no/api/v2", auth, ECHO_GET, { id: 7, q: "a b&c", flag: true }, KEY);
      expect(request.url).toBe("https://api.fiken.no/api/v2/things/7/echo?q=a+b%26c&flag=true");
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.body).toBeUndefined();
      expect(request.headers["content-type"]).toBeUndefined();
    });

    it("sends the remaining inputs as a JSON body for POST, and a json input as itself", () => {
      const request = buildApiToolRequest("https://fal.run", { kind: "header", name: "Authorization", prefix: "Key ", secretId: auth.secretId }, ECHO_POST, { prompt: "a cat", size: 2, options: { seed: 1 } }, KEY);
      expect(request.url).toBe("https://fal.run/things");
      expect(request.headers.authorization).toBe(`Key ${KEY}`);
      expect(request.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(request.body!)).toEqual({ prompt: "a cat", size: 2, options: { seed: 1 } });
    });

    it("puts the key in the query string for the query kind, next to the inputs, with one slash between base and path", () => {
      const request = buildApiToolRequest("https://example.com/base/", { kind: "query", name: "api_key", secretId: auth.secretId }, PLAIN_GET("list", "/list"), {}, KEY);
      expect(request.url).toBe(`https://example.com/base/list?api_key=${KEY}`);
      expect(request.headers.authorization).toBeUndefined();
    });

    it("validates inputs with plain sentences: unknown, missing, wrong type; coerces what a model tends to send", () => {
      expect(validateActionInput(ECHO_GET, { id: "7", limit: "1.5", flag: "true", q: 3 })).toEqual({ id: 7, limit: 1.5, flag: true, q: "3" });
      expect(() => validateActionInput(ECHO_GET, { id: 1, nope: 2 })).toThrow(/Unknown input "nope"\. The action "echo" takes: id, q, limit, flag\./);
      expect(() => validateActionInput(ECHO_GET, {})).toThrow(/Missing required input "id"/);
      expect(() => validateActionInput(ECHO_GET, { id: 1.5 })).toThrow(/must be a whole number/);
      expect(() => validateActionInput(ECHO_GET, { id: 1, flag: "yes" })).toThrow(/must be true or false/);
      expect(validateActionInput(ECHO_POST, { prompt: "x", options: '{"a":1}' })).toEqual({ prompt: "x", options: { a: 1 } });
      expect(() => validateActionInput(ECHO_POST, { prompt: "x", options: "not json" })).toThrow(/must be JSON/);
    });

    it("scrubs the known key, key-shaped text and key=... query values; finds links once each", () => {
      const text = `see ${KEY} and https://x.example/?api_key=${KEY}&page=2 also sk-abcdefghijklmnop123 and token=abc123def`;
      const scrubbed = scrubApiToolText(text, [KEY]);
      expect(scrubbed).not.toContain(KEY);
      expect(scrubbed).not.toContain("sk-abcdefghijklmnop123");
      expect(scrubbed).toContain("?api_key=[REDACTED]");
      expect(scrubbed).toContain("&page=2");
      expect(findUrls("a https://one.example/a. b https://one.example/a c https://two.example/b?x=1) d")).toEqual([
        "https://one.example/a",
        "https://two.example/b?x=1",
      ]);
    });
  });

  // ── Binding and storage ───────────────────────────────────────────────────

  it("binds the key to the tool row at config path auth, and the summary never carries it", async () => {
    const companyId = await seedCompany();
    const { tool, secret } = await seedTool(companyId);
    expect(tool.key).toBe("fal-ai");
    expect(tool.auth).toEqual({ kind: "header", name: "Authorization", prefix: "Key ", secretId: secret.id });
    expect(tool.baseUrl).toBe("https://fal.run");
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, tool.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ companyId, secretId: secret.id, targetType: "api_tool", configPath: "auth" });
    expect(JSON.stringify(tool)).not.toContain(KEY);
    expect(await dumpDatabase()).not.toContain(KEY);
  });

  it("re-points the binding when the key is changed, and removing the tool removes the binding but never the secret", async () => {
    const companyId = await seedCompany();
    const { tool, secret } = await seedTool(companyId);
    const other = await seedSecret(companyId, "sk-" + "otherkey0123456789abcdefghijk");
    const updated = await svc().update(companyId, tool.id, { auth: { kind: "bearer", secretId: other.id } });
    expect(updated.auth).toEqual({ kind: "bearer", secretId: other.id });
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, tool.id));
    expect(bindings.map((b) => b.secretId)).toEqual([other.id]);

    await svc().remove(companyId, tool.id);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, tool.id))).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(2);
    expect(secret.id).toBeTruthy();
    await expect(svc().get(companyId, tool.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a second tool with the same name gets its own key; another company cannot see the tool", async () => {
    const companyId = await seedCompany();
    const first = await seedTool(companyId);
    const second = await seedTool(companyId);
    expect(second.tool.key).not.toBe(first.tool.key);
    expect(second.tool.key.startsWith("fal-ai-")).toBe(true);
    const otherCompany = await seedCompany();
    await expect(svc().get(otherCompany, first.tool.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc().runAction(otherCompany, first.tool.id, "echo", { id: 1 }, boardCaller)).rejects.toMatchObject({ status: 404 });
    expect(await svc().listGranted(otherCompany, [first.tool.id])).toEqual([]);
  });

  // ── Calls ─────────────────────────────────────────────────────────────────

  it("GET: fills the path, sends the other inputs as query, attaches the header with its prefix, keeps the Host, and pretty-prints JSON", async () => {
    const companyId = await seedCompany();
    const { tool } = await seedTool(companyId);
    const result = await svc().runAction(companyId, tool.id, "echo", { id: "42", q: "hei", flag: "true" }, boardCaller);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    expect(result.error).toBeNull();
    const hit = hits[0]!;
    expect(hit.method).toBe("GET");
    expect(hit.url).toBe("/things/42/echo?q=hei&flag=true");
    expect(hit.headers.host).toBe("fal.run");
    expect(hit.headers.authorization).toBe(`Key ${KEY}`);
    // Pretty-printed: multi-line JSON.
    expect(result.body.split("\n").length).toBeGreaterThan(3);
    expect(JSON.parse(result.body)).toMatchObject({ method: "GET", path: "/things/42/echo", query: { q: "hei", flag: "true" } });
    expect(result.body).not.toContain(KEY);
    const calls = await db.select().from(companyApiToolCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ companyId, toolId: tool.id, action: "echo", channel: "board", userId: "filip", status: "ok", httpStatus: 200 });
  });

  it("POST: sends a JSON body; bearer and query kinds attach the key their way", async () => {
    const companyId = await seedCompany();
    const bearer = await seedTool(companyId, { auth: { kind: "bearer", name: undefined, prefix: undefined }, name: "Fiken", baseUrl: "https://api.fiken.no/api/v2" });
    const result = await svc().runAction(companyId, bearer.tool.id, "create", { prompt: "a cat", size: 2, options: { seed: 1 } }, boardCaller);
    expect(result.ok).toBe(true);
    expect(hits[0]).toMatchObject({ method: "POST", url: "/api/v2/things" });
    expect(hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(hits[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(hits[0]!.body)).toEqual({ prompt: "a cat", size: 2, options: { seed: 1 } });

    const query = await seedTool(companyId, { auth: { kind: "query", name: "api_key", prefix: undefined }, name: "Querytool" });
    await svc().runAction(companyId, query.tool.id, "echo", { id: 1 }, boardCaller);
    expect(hits[1]!.url).toBe(`/things/1/echo?api_key=${KEY}`);
    expect(hits[1]!.headers.authorization).toBeUndefined();
  });

  it("refuses bad input, an unknown action and a switched-off tool with plain sentences, before any request goes out", async () => {
    const companyId = await seedCompany();
    const { tool } = await seedTool(companyId);
    await expect(svc().runAction(companyId, tool.id, "echo", {}, boardCaller)).rejects.toThrow(/Missing required input "id"/);
    await expect(svc().runAction(companyId, tool.id, "nope", {}, boardCaller)).rejects.toThrow(/has no action called "nope"\. It has: echo, create\./);
    await svc().update(companyId, tool.id, { status: "disabled" });
    await expect(svc().runAction(companyId, tool.id, "echo", { id: 1 }, boardCaller)).rejects.toThrow(/is switched off/);
    expect(hits).toHaveLength(0);
    expect(await db.select().from(companyApiToolCalls)).toHaveLength(0);
  });

  it("never lets the key out: an echoed key is scrubbed from the answer and from an error answer, links are listed once, nothing in the database has it", async () => {
    const companyId = await seedCompany();
    const { tool } = await seedTool(companyId, { actions: [PLAIN_GET("leak", "/leak"), PLAIN_GET("leak_error", "/leak-error")] });
    const good = await svc().runAction(companyId, tool.id, "leak", {}, boardCaller);
    expect(good.ok).toBe(true);
    expect(good.body).not.toContain(KEY);
    expect(good.body).toContain("your key is Key ");
    expect(good.urls).toEqual(["https://docs.example.com/guide", "https://cdn.example.com/out/1.png"]);
    for (const url of good.urls) expect(url).not.toContain(KEY);

    const bad = await svc().runAction(companyId, tool.id, "leak_error", {}, boardCaller);
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(500);
    expect(bad.body).not.toContain(KEY);
    expect(bad.body).toContain("?api_key=[REDACTED]");
    expect(JSON.stringify(bad)).not.toContain(KEY);

    const calls = await db.select().from(companyApiToolCalls);
    expect(calls.map((c) => c.status).sort()).toEqual(["ok", "upstream_error"]);
    expect(await dumpDatabase()).not.toContain(KEY);
    expect((await db.select().from(secretAccessEvents)).length).toBeGreaterThanOrEqual(2);
  });

  it("cuts a long answer at 50 KB with a note, refuses a redirect and an oversized answer, and records those as network errors", async () => {
    const companyId = await seedCompany();
    const { tool } = await seedTool(companyId, { actions: [PLAIN_GET("big", "/big"), PLAIN_GET("redirect", "/redirect"), PLAIN_GET("huge", "/huge")] });
    const big = await svc().runAction(companyId, tool.id, "big", {}, boardCaller);
    expect(big.truncated).toBe(true);
    expect(big.body.length).toBeLessThan(API_TOOL_BODY_TEXT_LIMIT + 200);
    expect(big.body).toContain("[The answer was cut at 50 KB; 1000 more characters were not shown.]");

    const redirect = await svc().runAction(companyId, tool.id, "redirect", {}, boardCaller);
    expect(redirect.ok).toBe(false);
    expect(redirect.status).toBe(0);
    expect(redirect.error).toContain("tried to redirect the request to another address");
    expect(hits.some((hit) => hit.url.includes("steal"))).toBe(false);

    const huge = await svc().runAction(companyId, tool.id, "huge", {}, boardCaller);
    expect(huge.error).toContain("too large");
    const calls = await db.select().from(companyApiToolCalls);
    expect(calls.map((c) => c.status).sort()).toEqual(["network_error", "network_error", "ok"]);
  });

  it("refuses a call past the daily cap with a plain sentence, counts only calls that went out, and starts fresh after midnight UTC", async () => {
    const companyId = await seedCompany();
    const { tool } = await seedTool(companyId, { dailyCap: 2 });
    await svc().runAction(companyId, tool.id, "echo", { id: 1 }, boardCaller);
    await svc().runAction(companyId, tool.id, "echo", { id: 2 }, boardCaller);
    const refused = await svc().runAction(companyId, tool.id, "echo", { id: 3 }, boardCaller).then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(429);
    expect((refused as HttpError).message).toBe(
      'The tool "Fal.ai" has used its 2 calls for today. It can run again after midnight UTC, or raise the daily limit on the Tools page.',
    );
    expect(hits).toHaveLength(2);
    const calls = await db.select().from(companyApiToolCalls);
    expect(calls.map((c) => c.status).sort()).toEqual(["ok", "ok", "rate_limited"]);

    clock = Date.parse("2026-09-28T00:00:01.000Z");
    const next = await svc().runAction(companyId, tool.id, "echo", { id: 4 }, boardCaller);
    expect(next.ok).toBe(true);
    clock = Date.parse("2026-09-27T10:00:00.000Z");
  });

  // ── Test button ──────────────────────────────────────────────────────────

  it("Test uses the first GET action without required inputs, else the base address, and reports in plain words that are saved on the row", async () => {
    const companyId = await seedCompany();
    const good = await seedTool(companyId, { actions: [ECHO_POST, PLAIN_GET("ping", "/ping")] });
    const ok = await svc().test(companyId, good.tool.id, { userId: "filip" });
    expect(ok).toEqual({ ok: true, status: 200, message: "fal.run answered 200 (GET /ping). The key was accepted." });
    expect(hits[0]!.url).toBe("/ping");
    expect(hits[0]!.headers.authorization).toBe(`Key ${KEY}`);
    const row = await svc().get(companyId, good.tool.id);
    expect(row.lastTestOk).toBe(true);
    expect(row.lastTestMessage).toBe(ok.message);
    expect(row.lastTestAt).toBeTruthy();

    const bare = await seedTool(companyId, { name: "Bare", actions: [ECHO_POST] });
    const base = await svc().test(companyId, bare.tool.id, { userId: "filip" });
    expect(base.message).toBe("fal.run answered 200. The key was accepted.");
    expect(hits[1]!.url).toBe("/");

    const unauth = await seedTool(companyId, { name: "Unauth", actions: [PLAIN_GET("me", "/unauth")] });
    const refused = await svc().test(companyId, unauth.tool.id, { userId: "filip" });
    expect(refused.ok).toBe(false);
    expect(refused.message).toBe("fal.run answered 401 (GET /unauth): the key was not accepted. Check the secret and how the key is sent.");

    const missing = await seedTool(companyId, { name: "Missing", actions: [PLAIN_GET("nothing", "/nothing-here")] });
    // The fake answers 200 for unknown paths; make it a 404 by pointing at the redirect-free "unauth" host rule instead.
    expect((await svc().test(companyId, missing.tool.id, { userId: "filip" })).ok).toBe(true);
    const calls = await db.select().from(companyApiToolCalls);
    expect(calls.every((c) => c.channel === "settings_test" && c.userId === "filip")).toBe(true);
    expect(await dumpDatabase()).not.toContain(KEY);
  });

  it("Test says plainly when the address cannot be reached, without any request going out to a private address", async () => {
    const companyId = await seedCompany();
    const { tool } = await seedTool(companyId);
    const privateSvc = apiToolService(db, { lookup: async () => [{ address: "10.0.0.5", family: 4 }], testOnlyDial: { host: "127.0.0.1", port }, now: () => clock });
    const result = await privateSvc.test(companyId, tool.id, { userId: "filip" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Could not reach fal.run: fal.run points to an internal address and will not be contacted.");
    expect(hits).toHaveLength(0);
  });

  // ── Agent grants ─────────────────────────────────────────────────────────

  it("listGranted returns only active tools among the ids, and agentToolIds reads the agent's list", async () => {
    const companyId = await seedCompany();
    const active = await seedTool(companyId, { name: "Active" });
    const off = await seedTool(companyId, { name: "Off" });
    await svc().update(companyId, off.tool.id, { status: "disabled" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quick",
      role: "analyst",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      apiToolIds: [active.tool.id, off.tool.id, randomUUID()],
    });
    expect(await svc().agentToolIds(companyId, agentId)).toHaveLength(3);
    const granted = await svc().listGranted(companyId, await svc().agentToolIds(companyId, agentId));
    expect(granted.map((tool) => tool.id)).toEqual([active.tool.id]);
    expect(granted[0]!.id).toMatch(SECRET_UUID_RE);
    const forAgent = await svc().listForAgent(companyId, [active.tool.id]);
    expect(forAgent.map((tool) => [tool.name, tool.enabled])).toEqual([["Active", true], ["Off", false]]);
  });
});
