import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApprovalCommands } from "../commands/client/approval.js";

const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerApprovalCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("approval subresource commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps the linked-issues endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    await run(["approval", "issues", APPROVAL_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/approvals/${APPROVAL_ID}/issues`],
    ]);
  });

  it("adds items to an open deploy card, resolving each task and pairing it with its item", async () => {
    const issueA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "NOR-123" };
    const issueB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", identifier: "NOR-124" };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/issues/NOR-123")) return Promise.resolve(jsonResponse(issueA));
      if (url.endsWith("/api/issues/NOR-124")) return Promise.resolve(jsonResponse(issueB));
      return Promise.resolve(jsonResponse({ id: APPROVAL_ID }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "approval", "deploy-add", APPROVAL_ID,
      "--commit", "c".repeat(40),
      "--item", "Fixes the sign-in error",
      "--issue", "NOR-123",
      "--item", "Adds the weekly report email",
      "--issue", "NOR-124",
    ]);

    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]]);
    expect(calls).toEqual([
      ["GET", "http://localhost:3100/api/issues/NOR-123"],
      ["GET", "http://localhost:3100/api/issues/NOR-124"],
      ["POST", `http://localhost:3100/api/approvals/${APPROVAL_ID}/deploy-items`],
    ]);
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body).toEqual({
      commit: "c".repeat(40),
      items: [
        { summary: "Fixes the sign-in error", issueId: "NOR-123" },
        { summary: "Adds the weekly report email", issueId: "NOR-124" },
      ],
      issueIds: [issueA.id, issueB.id],
    });
  });

  it("adds items without tasks when none are given", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: APPROVAL_ID })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["approval", "deploy-add", APPROVAL_ID, "--commit", "c".repeat(40), "--item", "Fixes the sign-in error"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      commit: "c".repeat(40),
      items: [{ summary: "Fixes the sign-in error" }],
      issueIds: [],
    });
  });

  it("refuses uneven --issue and --item counts before calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      run([
        "approval", "deploy-add", APPROVAL_ID,
        "--commit", "c".repeat(40),
        "--item", "One",
        "--item", "Two",
        "--issue", "NOR-1",
      ]),
    ).rejects.toThrow("exit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
