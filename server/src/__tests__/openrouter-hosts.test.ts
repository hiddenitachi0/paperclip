import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import {
  openRouterEndpointsUrl,
  openRouterHostsForModel,
  parseOpenRouterEndpoints,
  resetOpenRouterHostsCacheForTests,
} from "../services/openrouter-hosts.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * OpenRouter hosts per model: the live endpoint list, normalised (tool
 * support is per model AND per host), fetched only from openrouter.ai with no
 * key, cached ~10 minutes; the route is owner/admin only. Fetch stubbed.
 */

vi.mock("../services/model-directory.js", () => ({ modelDirectoryService: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const companyId = "22222222-2222-4222-8222-222222222222";

const endpointsPayload = {
  data: {
    id: "qwen/qwen3.8-27b",
    architecture: { input_modalities: ["text", "image"] },
    endpoints: [
      {
        provider_name: "DeepInfra",
        tag: "deepinfra/fp8",
        quantization: "fp8",
        context_length: 262144,
        max_completion_tokens: 16384,
        pricing: { prompt: "0.00000015", completion: "0.00000188" },
        supported_parameters: ["tools", "tool_choice", "reasoning", "response_format"],
        status: 0,
        uptime_last_30m: 99.5,
      },
      {
        provider_name: "Venice",
        tag: "venice/fp8",
        quantization: "fp8",
        context_length: 32768,
        max_completion_tokens: null,
        pricing: { prompt: "0.0000002", completion: "0.0000008" },
        supported_parameters: ["temperature", "max_tokens"],
        status: -2,
      },
      { provider_name: "Broken", tag: "Not A Slug!", supported_parameters: ["tools"] },
      "nonsense",
    ],
  },
};

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("OpenRouter hosts service", () => {
  beforeEach(() => resetOpenRouterHostsCacheForTests());

  it("normalises the endpoint list per host and skips rows that are not hosts", () => {
    const parsed = parseOpenRouterEndpoints(endpointsPayload)!;
    expect(parsed.hosts).toEqual([
      {
        slug: "deepinfra",
        name: "DeepInfra",
        quantization: "fp8",
        contextTokens: 262144,
        maxOutputTokens: 16384,
        priceInPerM: 0.15,
        priceOutPerM: 1.88,
        supportsTools: true,
        supportsToolChoice: true,
        supportsReasoning: true,
        supportsImages: true,
        status: "ok",
        uptimeLast30m: 99.5,
      },
      {
        slug: "venice",
        name: "Venice",
        quantization: "fp8",
        contextTokens: 32768,
        maxOutputTokens: null,
        priceInPerM: 0.2,
        priceOutPerM: 0.8,
        supportsTools: false,
        supportsToolChoice: false,
        supportsReasoning: false,
        supportsImages: true,
        status: "degraded",
        uptimeLast30m: null,
      },
    ]);
    expect(parseOpenRouterEndpoints({ data: [] })).toBeNull();
    expect(parseOpenRouterEndpoints(null)).toBeNull();
  });

  it("only ever builds an openrouter.ai URL, and refuses ids that are not maker/model", () => {
    expect(openRouterEndpointsUrl("qwen/qwen3.8-27b")).toBe("https://openrouter.ai/api/v1/models/qwen/qwen3.8-27b/endpoints");
    expect(openRouterEndpointsUrl("openai/gpt-oss-20b:free")).toBe(
      "https://openrouter.ai/api/v1/models/openai/gpt-oss-20b:free/endpoints",
    );
    for (const bad of ["qwen", "../x", "../../evil.com", "a/b/c", "a/..", "@evil.com/x", "a b/c", "http://x/y", ""]) {
      expect(openRouterEndpointsUrl(bad)).toBeNull();
    }
  });

  it("fetches without a key or redirects, caches per model, and refresh skips a cache older than 30 seconds", async () => {
    const fetchImpl = vi.fn(async () => ok(endpointsPayload));
    const t0 = Date.parse("2026-10-08T12:00:00Z");
    const first = await openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: fetchImpl as never, now: t0 });
    expect(first.hosts).toHaveLength(2);
    expect(first.fetchedAt).toBe("2026-10-08T12:00:00.000Z");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/models/qwen/qwen3.8-27b/endpoints");
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    // Cached for ten minutes, also for a refresh within 30 seconds.
    await openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: fetchImpl as never, now: t0 + 9 * 60_000 });
    await openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: fetchImpl as never, now: t0 + 20_000, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: fetchImpl as never, now: t0 + 60_000, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: fetchImpl as never, now: t0 + 60_000 + 11 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("says plainly when OpenRouter does not know the model or cannot be read, and does not cache a failure", async () => {
    const notFound = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(openRouterHostsForModel("nobody/nothing", { fetchImpl: notFound as never })).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("does not know the model"),
    });
    const down = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: down as never })).rejects.toMatchObject({ status: 502 });
    const garbage = vi.fn(async () => ok({ data: "nope" }));
    await expect(openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: garbage as never })).rejects.toMatchObject({ status: 502 });
    const fine = vi.fn(async () => ok(endpointsPayload));
    expect((await openRouterHostsForModel("qwen/qwen3.8-27b", { fetchImpl: fine as never })).hosts).toHaveLength(2);
    await expect(openRouterHostsForModel("not an id", { fetchImpl: fine as never })).rejects.toMatchObject({ status: 422 });
  });
});

type Actor = Record<string, unknown>;
const board = (role: string): Actor => ({
  type: "board",
  source: "session",
  userId: "owner-1",
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: role }],
});

async function buildApp(actor: Actor, fetchImpl: typeof fetch) {
  const { modelDirectoryRoutes } = await import("../routes/model-directory.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", modelDirectoryRoutes(withFakeCompanyScopeReserve({}) as never, { fetchImpl }));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/model-directory/openrouter-hosts", () => {
  const url = `/api/companies/${companyId}/model-directory/openrouter-hosts`;
  beforeEach(() => resetOpenRouterHostsCacheForTests());

  it("returns the host list to an owner or admin", async () => {
    const fetchImpl = vi.fn(async () => ok(endpointsPayload));
    for (const role of ["owner", "admin"]) {
      resetOpenRouterHostsCacheForTests();
      const res = await request(await buildApp(board(role), fetchImpl as never)).get(url).query({ model: "qwen/qwen3.8-27b" });
      expect(res.status).toBe(200);
      expect(res.body.model).toBe("qwen/qwen3.8-27b");
      expect(res.body.hosts.map((h: { slug: string; supportsTools: boolean }) => [h.slug, h.supportsTools])).toEqual([
        ["deepinfra", true],
        ["venice", false],
      ]);
    }
  });

  it("refuses a member, a viewer and an agent, and never calls OpenRouter for them", async () => {
    const fetchImpl = vi.fn(async () => ok(endpointsPayload));
    for (const actor of [board("member"), board("viewer"), { type: "agent", agentId: "a1", companyId, source: "agent_key", runId: "r" }]) {
      const res = await request(await buildApp(actor, fetchImpl as never)).get(url).query({ model: "qwen/qwen3.8-27b" });
      expect(res.status).toBe(403);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a model id that is not maker/model with 422 and never calls out", async () => {
    const fetchImpl = vi.fn(async () => ok(endpointsPayload));
    for (const model of ["../../x", "evil.com", "a/b/c", ""]) {
      const res = await request(await buildApp(board("owner"), fetchImpl as never)).get(url).query({ model });
      expect(res.status).toBe(422);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
