import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeCiStatus, registerCiCommands } from "../commands/client/ci.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SHA = "abc1234def5678901234567890abcdef12345678";

async function run(extra: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCiCommands(program);
  await program.parseAsync(
    [
      "ci", "status", "--project", PROJECT_ID, "--sha", SHA, "-C", COMPANY_ID,
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
      ...extra,
    ],
    { from: "user" },
  );
}

function stubStatus(body: Record<string, unknown>) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ failedChecks: [], pendingChecks: [], sha: SHA, repo: "acme/widgets", ...body }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("paperclipai ci status", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("asks the project's ci-status route for the sha and prints green with exit code 0", async () => {
    const fetchMock = stubStatus({ state: "green" });
    await run();
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/projects/${PROJECT_ID}/ci-status?sha=${SHA}`],
    ]);
    expect(logSpy).toHaveBeenCalledWith("green");
    expect(process.exitCode).toBe(0);
  });

  it("prints the running checks and exits 2 while pending", async () => {
    stubStatus({ state: "pending", pendingChecks: ["build", "unit tests"] });
    await run();
    expect(logSpy).toHaveBeenCalledWith("pending (2 checks still running: build, unit tests)");
    expect(process.exitCode).toBe(2);
  });

  it("prints the failed checks and exits 1", async () => {
    stubStatus({ state: "failed", failedChecks: ["unit tests"] });
    await run();
    expect(logSpy).toHaveBeenCalledWith("failed: unit tests");
    expect(process.exitCode).toBe(1);
  });

  it("prints raw JSON with --json and still sets the exit code", async () => {
    stubStatus({ state: "pending", pendingChecks: ["build"] });
    await run(["--json"]);
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toMatchObject({ state: "pending", pendingChecks: ["build"] });
    expect(process.exitCode).toBe(2);
  });

  it("exits 4, not 1, when the request itself fails (a 502 during a restart is not 'checks failed')", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Bad gateway" }), { status: 502 })),
      ),
    );
    await run();
    expect(process.exitCode).toBe(4);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/Could not read the checks/);
  });

  it("exits 4 when the server cannot be reached at all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await run();
    expect(process.exitCode).toBe(4);
  });

  it("exits 4 for a project the server does not know (404), distinct from failed checks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404 }))),
    );
    await run();
    expect(process.exitCode).toBe(4);
  });

  it("describeCiStatus: no checks counts as green; unknown is its own exit code", () => {
    expect(describeCiStatus({ state: "none", failedChecks: [], pendingChecks: [], sha: SHA, repo: "a/b" }).exitCode).toBe(0);
    expect(describeCiStatus({ state: "unknown", failedChecks: [], pendingChecks: [], sha: SHA, repo: "a/b" }).exitCode).toBe(3);
    expect(describeCiStatus({ state: "pending", failedChecks: [], pendingChecks: ["x"], sha: SHA, repo: "a/b" }).text).toBe(
      "pending (1 check still running: x)",
    );
  });
});
