import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatCommands } from "../commands/client/chat.js";

// Telegram /cont, /memory and /looks go through these three commands.

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerChatCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("chat continue / memory / looks", () => {
  let printed: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("continue posts the company and the spec as data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ conversationId: CONVERSATION_ID, mode: "time", recap: "the last 45 minutes (2 messages)." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["chat", "continue", AGENT_ID, "-C", COMPANY_ID, "--spec", "last 45 minutes", "--json"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/lane-a/${AGENT_ID}/continue`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      companyId: COMPANY_ID,
      spec: "last 45 minutes",
    });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ ok: true, conversationId: CONVERSATION_ID, mode: "time" });
  });

  it("continue without --spec sends no spec (the last conversation)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ conversationId: CONVERSATION_ID, mode: "last", recap: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["chat", "continue", AGENT_ID, "-C", COMPANY_ID, "--json"]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ companyId: COMPANY_ID });
  });

  it("a refusal is printed as data with its code and exits 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: "I found no messages with Maja from the last 30 minutes, so there is nothing to continue.", details: { code: "LANE_A_CONTINUE_NOTHING_FOUND" } },
          422,
        ),
      ),
    );

    await run(["chat", "continue", AGENT_ID, "-C", COMPANY_ID, "--spec", "last 30 minutes", "--json"]);

    expect(JSON.parse(printed.join("\n"))).toEqual({
      ok: false,
      status: 422,
      code: "LANE_A_CONTINUE_NOTHING_FOUND",
      error: "I found no messages with Maja from the last 30 minutes, so there is nothing to continue.",
    });
  });

  it("memory reads the agent's notebook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ notes: [{ id: "n1", text: "Coffee black." }] }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["chat", "memory", AGENT_ID, "-C", COMPANY_ID, "--json"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}/memories`);
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ ok: true, notes: [{ text: "Coffee black." }] });
  });

  it("looks asks for the company's looks through the agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ available: true, text: "Saved looks:" }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["chat", "looks", AGENT_ID, "-C", COMPANY_ID, "--json"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/lane-a/${AGENT_ID}/looks?companyId=${COMPANY_ID}`,
    );
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ ok: true, available: true, text: "Saved looks:" });
  });
});
