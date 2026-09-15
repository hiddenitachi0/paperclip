import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatCommands } from "../commands/client/chat.js";

// DUR-3978: the Telegram bridge talks to agents through these two commands.

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_A = "44444444-4444-4444-8444-444444444444";
const ISSUE_B = "55555555-5555-4555-8555-555555555555";

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

describe("chat commands", () => {
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
  });

  it("sends one message through the chat router for the given company", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ lane: "a", result: { conversationId: CONVERSATION_ID, response: "Two." }, taskRef: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "chat", "send", AGENT_ID,
      "-C", COMPANY_ID,
      "--message", "how many agents?",
      "--conversation-id", CONVERSATION_ID,
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/chat/${AGENT_ID}/messages`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      companyId: COMPANY_ID,
      message: "how many agents?",
      conversationId: CONVERSATION_ID,
    });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({
      ok: true,
      lane: "a",
      result: { conversationId: CONVERSATION_ID, response: "Two." },
    });
  });

  it("passes a forced lane as the router hint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ lane: "b", result: null, taskRef: { issueId: ISSUE_A, identifier: "DUR-9" } }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["chat", "send", AGENT_ID, "-C", COMPANY_ID, "--message", "do the thing", "--lane", "b", "--json"]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      companyId: COMPANY_ID,
      message: "do the thing",
      laneHint: "b",
    });
  });

  it("prints a refusal as data with its code instead of exiting, so the bridge can react", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: "Conversation has been idle too long — start a new one",
            code: "LANE_A_CONVERSATION_EXPIRED",
            details: { code: "LANE_A_CONVERSATION_EXPIRED" },
          },
          409,
        ),
      ),
    );

    await run(["chat", "send", AGENT_ID, "-C", COMPANY_ID, "--message", "and then?", "--json"]);

    expect(process.exit).not.toHaveBeenCalled();
    expect(JSON.parse(printed.join("\n"))).toEqual({
      ok: false,
      status: 409,
      code: "LANE_A_CONVERSATION_EXPIRED",
      error: "Conversation has been idle too long — start a new one",
    });
  });

  it("still exits with an error for a refusal when not asked for JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Agent not found" }, 404)));

    await expect(run(["chat", "send", AGENT_ID, "-C", COMPANY_ID, "--message", "hi"])).rejects.toThrow(
      "process.exit(1)",
    );
  });

  it("refuses an unknown lane without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      run(["chat", "send", AGENT_ID, "-C", COMPANY_ID, "--message", "hi", "--lane", "c", "--json"]),
    ).rejects.toThrow("process.exit(1)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the answers of several tasks in one company in one call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["chat", "answers", ISSUE_A, ISSUE_B, "-C", COMPANY_ID, "--json"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/companies/${COMPANY_ID}/issue-answers`);
    expect(url.searchParams.get("ids")).toBe(`${ISSUE_A},${ISSUE_B}`);
    expect(JSON.parse(printed.join("\n"))).toEqual({ issues: [] });
  });
});
