import { describe, expect, it } from "vitest";
import { MODEL_TAGS_MAX_BYTES, MODEL_TEST_MAX_BYTES, probeLocalModel, runModelTest } from "../services/model-health.ts";

const redirecting = (seen: RequestInit[]) =>
  (async (_url: unknown, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  }) as typeof fetch;

describe("model health hardening (DUR-4529)", () => {
  it("probe does not follow redirects and treats one as unreachable", async () => {
    const seen: RequestInit[] = [];
    const r = await probeLocalModel("http://pc:11434/v1", "m", redirecting(seen));
    expect(seen[0]?.redirect).toBe("manual");
    expect(r.status).toBe("unreachable");
  });

  it("probe refuses an oversized /api/tags body", async () => {
    const big = JSON.stringify({ models: [{ name: "m:latest", pad: "x".repeat(MODEL_TAGS_MAX_BYTES) }] });
    const r = await probeLocalModel("http://pc:11434", "m", (async () => new Response(big)) as typeof fetch);
    expect(r.status).toBe("unreachable");
  });

  it("probe still accepts a normal body", async () => {
    const r = await probeLocalModel("http://pc:11434", "m", (async () => new Response(JSON.stringify({ models: [{ name: "m:latest" }] }))) as typeof fetch);
    expect(r.status).toBe("ready");
  });

  it("test call does not follow redirects and reports a failure", async () => {
    const seen: RequestInit[] = [];
    const r = await runModelTest(redirecting(seen), "http://pc:11434/v1", "m", "default");
    expect(seen[0]?.redirect).toBe("manual");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redirect/i);
  });

  it("test call refuses an oversized streamed answer", async () => {
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(1000) } }] })}\n`;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new TextEncoder().encode(chunk)); },
      cancel() { cancelled = true; },
    });
    const r = await runModelTest((async () => new Response(stream)) as typeof fetch, "http://pc:11434/v1", "m", "default");
    expect(r.ok).toBe(false);
    expect(r.answer).toBeNull();
    expect(cancelled).toBe(true);
    expect(MODEL_TEST_MAX_BYTES).toBe(65_536);
  });
});
