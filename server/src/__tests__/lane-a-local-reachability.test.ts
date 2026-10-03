import { describe, expect, it } from "vitest";
import { createLaneAProviderClient, LaneAProviderError } from "../services/lane-a-providers.js";

const completion = {
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

function fakeFetch(handlers: { models: () => Promise<Response>; chat: () => Promise<Response> }) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    return u.endsWith("/models") ? handlers.models() : handlers.chat();
  }) as typeof fetch;
  return { impl, calls };
}

const request = { model: "qwen3:8b", maxTokens: 64, system: "s", messages: [{ role: "user" as const, content: "hi" }] };

describe("local quick-agent model: reachability check, then the normal answer limit", () => {
  it("fails fast without calling the model when the box cannot be reached", async () => {
    const { impl, calls } = fakeFetch({
      models: () => Promise.reject(new TypeError("fetch failed")),
      chat: () => Promise.resolve(new Response(JSON.stringify(completion))),
    });
    const client = createLaneAProviderClient({ provider: "local", apiKey: null, baseUrl: "http://10.0.0.9:11434/v1", fetch: impl });
    await expect(client.complete(request as never)).rejects.toBeInstanceOf(LaneAProviderError);
    expect(calls).toEqual(["http://10.0.0.9:11434/v1/models"]);
  });

  it("answers when the box is reachable, even if the models list itself is an error page", async () => {
    const { impl, calls } = fakeFetch({
      models: () => Promise.resolve(new Response("not found", { status: 404 })),
      chat: () => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(completion))), 50)),
    });
    const client = createLaneAProviderClient({ provider: "local", apiKey: null, baseUrl: "http://10.0.0.9:11434/v1/", fetch: impl });
    const result = await client.complete(request as never);
    expect(result.text).toBe("hi");
    expect(calls).toEqual(["http://10.0.0.9:11434/v1/models", "http://10.0.0.9:11434/v1/chat/completions"]);
  });

  it("does not run the reachability check for hosted providers", async () => {
    const { impl, calls } = fakeFetch({
      models: () => Promise.reject(new Error("should not be called")),
      chat: () => Promise.resolve(new Response(JSON.stringify(completion))),
    });
    const client = createLaneAProviderClient({ provider: "openrouter", apiKey: "k", fetch: impl });
    await client.complete(request as never);
    expect(calls.some((c) => c.endsWith("/models"))).toBe(false);
  });
});
