// DUR-3997: the per-provider probes behind the Test button. Every value here
// is a random decoy ("canary"); assertions compare booleans so a failure never
// prints a key. No test touches the network: fetch is a fake.
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PROBE_TIMEOUT_MS,
  describeFetchProbeError,
  describeHttpProbeStatus,
  parseLocalModelEndpoint,
  probeSecretKind,
  scrubSecretValue,
  type ProbeFetch,
} from "../services/secret-kind-probes.js";

const canary = (prefix: string) => `${prefix}${randomBytes(20).toString("hex")}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): ProbeFetch & {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as ProbeFetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

function authHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)?.authorization;
}

describe("scrubSecretValue", () => {
  it("removes the literal value and every well-known key shape", () => {
    const keys = [
      canary("sk-ant-api03-"),
      canary("sk-proj-"),
      canary("sk-or-v1-"),
      canary("AIza"),
      canary("ghp_"),
      canary("github_pat_"),
      "plain-canary-value-9f8e7d",
    ];
    const text = `a ${keys.join(" and ")} b Bearer ${keys[6]} c`;
    const out = scrubSecretValue(text, keys[6]);
    for (const key of keys) expect(out.includes(key)).toBe(false);
    expect(out).toContain("[key]");
    expect(out.startsWith("a ")).toBe(true);
  });

  it("scrubs each part of a 'url key' local endpoint value separately", () => {
    const key = canary("local-");
    const out = scrubSecretValue(`failed for ${key} at http://host:11434`, `http://host:11434 ${key}`);
    expect(out.includes(key)).toBe(false);
  });

  it("leaves ordinary text alone", () => {
    expect(scrubSecretValue("OpenAI answered. This key works.", "x")).toBe("OpenAI answered. This key works.");
  });
});

describe("parseLocalModelEndpoint", () => {
  it("reads an address and an optional key", () => {
    expect(parseLocalModelEndpoint("http://localhost:11434")).toEqual({ baseUrl: "http://localhost:11434", apiKey: null });
    expect(parseLocalModelEndpoint("http://localhost:11434/ abc-def")).toEqual({
      baseUrl: "http://localhost:11434",
      apiKey: "abc-def",
    });
    expect(parseLocalModelEndpoint("https://models.example.com/v1")).toEqual({
      baseUrl: "https://models.example.com/v1",
      apiKey: null,
    });
  });

  it("refuses anything that is not a plain http(s) address", () => {
    expect(parseLocalModelEndpoint("localhost:11434")).toBe(null);
    expect(parseLocalModelEndpoint("ftp://host")).toBe(null);
    expect(parseLocalModelEndpoint("http://user:pw@host")).toBe(null);
    expect(parseLocalModelEndpoint("")).toBe(null);
  });
});

describe("plain-language verdicts", () => {
  it("names the provider and keeps the upstream hint", () => {
    expect(describeHttpProbeStatus("OpenAI", 401, "Incorrect API key provided")).toBe(
      "OpenAI did not accept this key (Incorrect API key provided).",
    );
    expect(describeHttpProbeStatus("OpenAI", 429, "")).toContain("rate limiting");
    expect(describeHttpProbeStatus("Google", 503, "")).toContain("having trouble");
    expect(describeHttpProbeStatus("Google", 418, "")).toBe("Google returned HTTP 418.");
  });

  it("explains a timeout and a connection failure", () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    expect(describeFetchProbeError("OpenAI", timeout)).toContain(`${Math.round(PROBE_TIMEOUT_MS / 1000)} seconds`);
    const refused = new TypeError("fetch failed");
    (refused as any).cause = { code: "ECONNREFUSED" };
    expect(describeFetchProbeError("The model server", refused)).toBe("Could not reach The model server: ECONNREFUSED");
    expect(describeFetchProbeError("OpenAI", "boom")).toBe("Could not reach OpenAI.");
  });
});

describe("probeSecretKind", () => {
  it("sends the OpenAI key as a bearer to the models list and reads a 200 as accepted", async () => {
    const key = canary("sk-proj-");
    const fetchImpl = fakeFetch(() => jsonResponse(200, { data: [] }));
    const result = await probeSecretKind("openai_api_key", key, { fetchImpl });
    expect(result).toEqual({ ok: true, message: "OpenAI answered. This key works." });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(authHeader(fetchImpl.calls[0].init) === `Bearer ${key}`).toBe(true);
    expect(fetchImpl.calls[0].init.redirect).toBe("manual");
    expect(fetchImpl.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads a 401 as refused, says why, does not retry, and never echoes the key", async () => {
    const key = canary("sk-or-v1-");
    const fetchImpl = fakeFetch(() =>
      jsonResponse(401, { error: { message: `Incorrect API key provided: ${key}` } }),
    );
    const result = await probeSecretKind("openrouter_api_key", key, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OpenRouter did not accept this key");
    expect(result.message.includes(key)).toBe(false);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe("https://openrouter.ai/api/v1/models");
  });

  it("retries once on a 5xx and on a network failure, then reports the last outcome", async () => {
    let attempt = 0;
    const flaky = fakeFetch(() => (attempt++ === 0 ? jsonResponse(502, {}) : jsonResponse(200, { data: [] })));
    expect((await probeSecretKind("openai_api_key", canary("sk-"), { fetchImpl: flaky })).ok).toBe(true);
    expect(flaky.calls).toHaveLength(2);

    const down = fakeFetch(() => {
      const err = new TypeError("fetch failed");
      (err as any).cause = { code: "ENOTFOUND" };
      throw err;
    });
    const result = await probeSecretKind("openai_api_key", canary("sk-"), { fetchImpl: down });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Could not reach OpenAI: ENOTFOUND");
    expect(down.calls).toHaveLength(2);
  });

  it("sends the Google key as a header, never in the URL", async () => {
    const key = canary("AIza");
    const fetchImpl = fakeFetch(() => jsonResponse(200, { models: [] }));
    const result = await probeSecretKind("google_api_key", key, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl.calls[0].url.includes(key)).toBe(false);
    expect(fetchImpl.calls[0].url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")).toBe(true);
    expect((fetchImpl.calls[0].init.headers as Record<string, string>)["x-goog-api-key"] === key).toBe(true);
  });

  it("probes a local server at <base>/v1/models, with a bearer only when a key is stored", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, { data: [] }));
    expect((await probeSecretKind("local_model_endpoint", "http://localhost:11434/", { fetchImpl })).ok).toBe(true);
    expect(fetchImpl.calls[0].url).toBe("http://localhost:11434/v1/models");
    expect(authHeader(fetchImpl.calls[0].init)).toBeUndefined();

    const key = canary("lm-");
    await probeSecretKind("local_model_endpoint", `http://localhost:11434 ${key}`, { fetchImpl });
    expect(authHeader(fetchImpl.calls[1].init) === `Bearer ${key}`).toBe(true);

    const bad = await probeSecretKind("local_model_endpoint", "not a url", { fetchImpl });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("server's address");
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("uses the injected Claude call and scrubs whatever it says", async () => {
    const key = canary("sk-ant-api03-");
    const probeAnthropicImpl = vi.fn(async () => ({ ok: false, message: `Claude did not accept this key (${key}).` }));
    const result = await probeSecretKind("anthropic_api_key", key, { probeAnthropicImpl });
    expect(probeAnthropicImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.message.includes(key)).toBe(false);
    expect(result.message).toContain("[key]");
  });

  it("never throws: an exploding fetch becomes a verdict, still without the key", async () => {
    const key = canary("sk-");
    const fetchImpl = fakeFetch(() => {
      throw new Error(`socket hang up while sending Bearer ${key}`);
    });
    const result = await probeSecretKind("openai_api_key", key, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message.includes(key)).toBe(false);
  });

  it("refuses kinds it cannot test and empty values without calling anyone", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, {}));
    expect((await probeSecretKind("github_token", canary("ghp_"), { fetchImpl })).ok).toBe(false);
    expect((await probeSecretKind("openai_api_key", "   ", { fetchImpl })).message).toBe("The stored value is empty.");
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
