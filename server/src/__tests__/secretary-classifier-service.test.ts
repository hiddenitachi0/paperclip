import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretaryRosterEntry } from "../services/secretary-classifier.ts";

// DUR-251/DUR-335: the secretary classifier is a single cheap LLM call (no
// DB, no conversation state), so these are plain unit tests against a mocked
// Anthropic client — no embedded Postgres needed.

const roster: SecretaryRosterEntry[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "CEO", role: "ceo" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Backend Engineer", role: "engineer" },
];

const previousApiKey = process.env.ANTHROPIC_API_KEY;

function mockAnthropicCreate(impl: (...args: unknown[]) => unknown) {
  const mockCreate = vi.fn(impl);
  vi.doMock("@anthropic-ai/sdk", async () => {
    const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
    const RealDefault = (actual as { default: typeof actual.default }).default;
    class FakeAnthropic {
      static AuthenticationError = RealDefault.AuthenticationError;
      static RateLimitError = RealDefault.RateLimitError;
      static APIError = RealDefault.APIError;
      messages = { create: mockCreate };
      constructor(_opts: unknown) {}
    }
    return { ...actual, default: FakeAnthropic };
  });
  return mockCreate;
}

async function freshService() {
  vi.resetModules();
  const { secretaryClassifierService } = await import("../services/secretary-classifier.ts");
  return secretaryClassifierService();
}

describe("secretary classifier service", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it("returns the parsed lane/targetAgentId/reasoning shape on a clean model response", async () => {
    mockAnthropicCreate(() => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            lane: "b",
            targetAgentId: "22222222-2222-4222-8222-222222222222",
            reasoning: "This asks for a code change, so it goes to the engineer.",
          }),
        },
      ],
      usage: { input_tokens: 120, output_tokens: 40 },
      stop_reason: "end_turn",
    }));
    const service = await freshService();

    const result = await service.classify({ message: "fix the broken build", roster });

    expect(result).toEqual({
      lane: "b",
      targetAgentId: "22222222-2222-4222-8222-222222222222",
      reasoning: "This asks for a code change, so it goes to the engineer.",
    });
  });

  it("tolerates prose wrapped around the JSON object", async () => {
    mockAnthropicCreate(() => ({
      content: [
        {
          type: "text",
          text: `Sure, here's my pick:\n${JSON.stringify({
            lane: "a",
            targetAgentId: "11111111-1111-4111-8111-111111111111",
            reasoning: "Just a quick question, no work needed.",
          })}\nLet me know if that's wrong.`,
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
      stop_reason: "end_turn",
    }));
    const service = await freshService();

    const result = await service.classify({ message: "how many agents do we have?", roster });

    expect(result.lane).toBe("a");
    expect(result.targetAgentId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects a targetAgentId outside the supplied roster (502)", async () => {
    mockAnthropicCreate(() => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            lane: "b",
            targetAgentId: "99999999-9999-4999-8999-999999999999",
            reasoning: "made up",
          }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
      stop_reason: "end_turn",
    }));
    const service = await freshService();

    await expect(service.classify({ message: "hi", roster })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an unparseable response (502)", async () => {
    mockAnthropicCreate(() => ({
      content: [{ type: "text", text: "not json at all" }],
      usage: { input_tokens: 100, output_tokens: 30 },
      stop_reason: "end_turn",
    }));
    const service = await freshService();

    await expect(service.classify({ message: "hi", roster })).rejects.toMatchObject({ status: 502 });
  });

  it("returns 503 without calling the model when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const mockCreate = mockAnthropicCreate(() => {
      throw new Error("should not be called");
    });
    const service = await freshService();

    await expect(service.classify({ message: "hi", roster })).rejects.toMatchObject({ status: 503 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 409 without calling the model when the roster is empty", async () => {
    const mockCreate = mockAnthropicCreate(() => {
      throw new Error("should not be called");
    });
    const service = await freshService();

    await expect(service.classify({ message: "hi", roster: [] })).rejects.toMatchObject({ status: 409 });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
