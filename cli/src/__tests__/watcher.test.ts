import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWatcherCommands } from "../commands/client/watcher.js";

// Watchers: the Telegram bridge reads the outbox and acknowledges each alert
// through these two commands.

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ALERT_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerWatcherCommands(program);
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

describe("watcher commands", () => {
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

  it("reads one company's outbox", async () => {
    const alerts = [{ id: ALERT_ID, agentId: "a", text: "Bitcoin is up 5%", imageFileId: null }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ alerts }));
    vi.stubGlobal("fetch", fetchMock);
    await run(["watcher", "outbox", "-C", COMPANY_ID, "--json"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/watcher-outbox`);
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(JSON.parse(printed.join("\n"))).toEqual({ alerts });
  });

  it("acknowledges one alert as delivered by default, or as failed with a note", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ id: ALERT_ID, status: "delivered" }));
    vi.stubGlobal("fetch", fetchMock);
    await run(["watcher", "outbox:ack", ALERT_ID, "-C", COMPANY_ID, "--json"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/watcher-outbox/${ALERT_ID}/ack`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ outcome: "delivered" });

    await run(["watcher", "outbox:ack", ALERT_ID, "-C", COMPANY_ID, "--outcome", "failed", "--note", "No chat to send it to.", "--json"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ outcome: "failed", note: "No chat to send it to." });
  });

  it("refuses an id that is not an alert id, and an unknown outcome, without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(run(["watcher", "outbox:ack", "not-an-id", "-C", COMPANY_ID, "--json"])).rejects.toThrow("process.exit(1)");
    await expect(run(["watcher", "outbox:ack", ALERT_ID, "-C", COMPANY_ID, "--outcome", "maybe", "--json"])).rejects.toThrow("process.exit(1)");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
