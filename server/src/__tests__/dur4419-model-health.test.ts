import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { modelDirectoryService } from "../services/model-directory.ts";
import { classifyLocalFailure, modelHealthService } from "../services/model-health.ts";
import { LaneAProviderError } from "../services/lane-a-providers.ts";
import { localModelOfflineNotice } from "@paperclipai/shared";

/** DUR-4419: health states, once-per-outage reminder, Test button, on a real Postgres. */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const ADDR = "http://100.1.2.3:11434/v1";
const MODEL = "qwen3:8b";

function tagsFetch(state: { mode: "up" | "down" | "no-model" }): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).endsWith("/api/tags")) {
      if (state.mode === "down") throw new TypeError("fetch failed");
      const models = state.mode === "up" ? [{ name: MODEL }, { name: "llama3:latest" }] : [{ name: "llama3:latest" }];
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    // chat/completions (streaming)
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":" there friend"}}]}\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

d("model health", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const co = randomUUID();
  const other = randomUUID();
  const net = { mode: "up" as "up" | "down" | "no-model" };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-health-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values([
      { id: co, name: "A", issuePrefix: "MHA" },
      { id: other, name: "B", issuePrefix: "MHB" },
    ]);
  }, 60_000);
  afterAll(async () => {
    await cleanup?.();
  });

  it("moves between Ready, Can't reach your PC and model missing, with plain-English text", async () => {
    const health = modelHealthService(db, { fetchImpl: tagsFetch(net) });
    const entry = await modelDirectoryService(db).create(co, { name: "Maja local", provider: "local", model: MODEL, baseUrl: ADDR }, { userId: "u" });

    net.mode = "up";
    expect(await health.checkEntry(co, entry.id)).toMatchObject({ applicable: true, status: "ready", message: "Ready", hint: null });
    net.mode = "down";
    const down = await health.checkEntry(co, entry.id);
    expect(down).toMatchObject({ status: "unreachable", message: "Can't reach your PC.", runbookPath: expect.stringContaining("DUR-4357") });
    expect(down.hint).toContain("Ollama");
    expect(down.outageStartedAt).not.toBeNull();
    net.mode = "no-model";
    expect(await health.checkEntry(co, entry.id)).toMatchObject({ status: "model_missing", message: expect.stringContaining(MODEL) });
    net.mode = "up";
    expect(await health.checkEntry(co, entry.id)).toMatchObject({ status: "ready", outageStartedAt: null });
    // Another company never sees or checks this entry.
    await expect(health.checkEntry(other, entry.id)).rejects.toMatchObject({ status: 404 });
    expect((await health.overview(other)).entries).toEqual([]);
  });

  it("a hosted model has nothing to check", async () => {
    const health = modelHealthService(db, { fetchImpl: tagsFetch(net) });
    const e = await modelDirectoryService(db).create(co, { name: "Claude", provider: "anthropic", model: "claude-sonnet-5" }, { userId: "u" });
    expect(await health.checkEntry(co, e.id)).toMatchObject({ applicable: false, status: "not_checked" });
  });

  it("tells the person once per outage, not per message, and again after a fresh outage", async () => {
    const health = modelHealthService(db);
    const attempt = (outcome: "ok" | "unreachable") => health.noteLocalAttempt({ companyId: co, baseUrl: ADDR + "/", model: "other:1b", outcome });
    expect((await attempt("unreachable")).notify).toBe(true);
    expect((await attempt("unreachable")).notify).toBe(false);
    expect((await attempt("unreachable")).notify).toBe(false);
    expect((await attempt("ok")).notify).toBe(false); // recovery
    expect((await attempt("unreachable")).notify).toBe(true); // a new outage
    expect((await attempt("unreachable")).notify).toBe(false);
  });

  it("claims the notice atomically when two messages fail at once", async () => {
    const health = modelHealthService(db);
    await health.record(co, ADDR, "race:1b", "unreachable");
    const results = await Promise.all([1, 2, 3, 4].map(() => health.claimOutageNotice(co, ADDR, "race:1b")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("fires once even when whole failed turns (record + claim) race on a fresh outage", async () => {
    const health = modelHealthService(db);
    const turn = () => health.noteLocalAttempt({ companyId: co, baseUrl: ADDR, model: "race2:1b", outcome: "unreachable" });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => turn()));
    expect(results.filter((r) => r.notify)).toHaveLength(1);
    expect((await turn()).notify).toBe(false);
  });

  it("evening warning needs an hour of outage and goes once per outage", async () => {
    let now = new Date("2026-10-03T18:00:00Z");
    const health = modelHealthService(db, { now: () => now });
    await health.record(co, ADDR, "evening:1b", "unreachable");
    expect(await health.claimEveningWarning(co, ADDR, "evening:1b")).toBe(false); // down for 0 min
    now = new Date("2026-10-03T19:30:00Z");
    expect(await health.claimEveningWarning(co, ADDR, "evening:1b")).toBe(true);
    expect(await health.claimEveningWarning(co, ADDR, "evening:1b")).toBe(false);
  });

  it("the agent banner state comes from the stored health", async () => {
    const { agents } = await import("@paperclipai/db");
    await db.insert(agents).values({ companyId: co, name: "Maja", role: "general", laneAEnabled: true, laneAProvider: "local", laneABaseUrl: ADDR, laneAModel: MODEL } as never);
    const health = modelHealthService(db, { fetchImpl: tagsFetch(net) });
    net.mode = "down";
    await health.checkInUse();
    const o = await health.overview(co);
    expect(o.agents).toHaveLength(1);
    expect(o.agents[0]).toMatchObject({ agentName: "Maja", status: "unreachable", showBanner: true });
    net.mode = "up";
    await health.checkInUse();
    expect((await health.overview(co)).agents[0]).toMatchObject({ status: "ready", showBanner: false });
  });

  it("Test button: runs thinking on and off for a local model and times it", async () => {
    const health = modelHealthService(db, { fetchImpl: tagsFetch(net) });
    const e = await modelDirectoryService(db).create(co, { name: "Runnable", provider: "local", model: MODEL, baseUrl: ADDR }, { userId: "u" });
    const r = await health.testEntry(co, e.id);
    expect(r).toMatchObject({ ran: true, reason: null, prompt: "Say hi in five words" });
    expect(r.runs.map((x) => x.thinking)).toEqual(["on", "off"]);
    expect(r.runs[0]).toMatchObject({ ok: true, answer: "Hi there friend" });
    expect(r.runs[0]!.firstWordMs).not.toBeNull();
    expect(r.runs[0]!.totalMs).toBeGreaterThanOrEqual(r.runs[0]!.firstWordMs!);
  });

  it("Test button: a model that can't run gets a plain-English reason and no call", async () => {
    let called = false;
    const health = modelHealthService(db, { fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
    const dir = modelDirectoryService(db);
    const page = await dir.create(co, { name: "HF page", provider: "local", model: "https://huggingface.co/someone/some-model", baseUrl: ADDR }, { userId: "u" });
    const noGguf = await dir.create(co, { name: "HF no gguf", provider: "local", model: "hf.co/someone/some-model:Q4", baseUrl: ADDR }, { userId: "u" });
    const noAddress = await dir.create(co, { name: "No address", provider: "local", model: "x:1b" }, { userId: "u" }).catch(() => null);
    for (const e of [page, noGguf]) {
      const r = await health.testEntry(co, e.id);
      expect(r.ran).toBe(false);
      expect(r.runs).toEqual([]);
      expect(r.reason).toMatch(/GGUF|Hugging Face/);
    }
    if (noAddress) expect((await health.testEntry(co, noAddress.id)).ran).toBe(false);
    expect(called).toBe(false);
  });
});

describe("local failure classification and notice wording", () => {
  it("only a network failure or missing model counts as 'the PC is off'", () => {
    const mk = (kind: "network" | "upstream" | "auth", message: string) => new LaneAProviderError({ kind, provider: "local", message });
    expect(classifyLocalFailure(mk("network", "fetch failed"))).toBe("unreachable");
    expect(classifyLocalFailure(mk("upstream", "model 'x' not found"))).toBe("model_missing");
    expect(classifyLocalFailure(mk("upstream", "bad request"))).toBeNull();
    expect(classifyLocalFailure(mk("auth", "no"))).toBeNull();
    expect(classifyLocalFailure(new Error("boom"))).toBeNull();
  });
  it("names the backup, or nudges to turn Ollama on", () => {
    expect(localModelOfflineNotice({ agentName: "Maja", backupModel: "mistral-small" })).toBe("Maja's local model is offline, answered with mistral-small.");
    expect(localModelOfflineNotice({ agentName: "Maja" })).toContain("turn on Ollama");
  });
});
