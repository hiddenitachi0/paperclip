import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_CHAT_CONNECTOR_ALLOWED_TOOL,
  buildBoardChatMcpConfig,
  buildSignedInBoardChatArgs,
} from "../services/board-chat-connector.js";

/**
 * The Paperclip connector is the only tool a signed-in Board chat run has.
 * Runs the real connector script under Node against a stand-in Paperclip
 * server, speaking MCP over stdio the way the CLI does. No model involved.
 */
describe("Board chat Paperclip connector", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it("swaps its one-time code once, then calls only /api paths with the run credential", async () => {
    const seen: Array<{ method: string; url: string; auth: string | undefined; host: string | undefined; body: string }> = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, host: req.headers.host, body: Buffer.concat(chunks).toString() });
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/board/chat/runs/run-1/token") {
          res.end(JSON.stringify({ token: "pcp_bcrun_test" }));
        } else if (req.method === "POST") {
          res.statusCode = 202;
          res.end(JSON.stringify({ held: true, pendingActionId: "a1" }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const config = JSON.parse(
      buildBoardChatMcpConfig({
        nodePath: process.execPath,
        host: "127.0.0.1",
        port,
        hostHeader: `localhost:${port}`,
        runId: "run-1",
        bootstrapCode: "pcp_bcboot_once",
      }),
    ).mcpServers.paperclip;
    const child = spawn(config.command, config.args, { env: { PATH: process.env.PATH, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout! });
    const replies = new Map<number, any>();
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      replies.set(msg.id, msg);
    });
    const ask = async (id: number, method: string, params: unknown) => {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      for (let i = 0; i < 200 && !replies.has(id); i += 1) await new Promise((r) => setTimeout(r, 25));
      return replies.get(id);
    };

    const init = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.capabilities).toEqual({ tools: {} });
    const list = await ask(2, "tools/list", {});
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["api"]);

    const read = await ask(3, "tools/call", { name: "api", arguments: { method: "GET", path: "/api/companies/c1/dashboard" } });
    expect(read.result.isError).toBe(false);
    expect(read.result.content[0].text).toContain("HTTP 200");
    const write = await ask(4, "tools/call", { name: "api", arguments: { method: "POST", path: "/api/companies/c1/issues", body: { title: "x" } } });
    expect(write.result.content[0].text).toContain("held");
    const outside = await ask(5, "tools/call", { name: "api", arguments: { method: "GET", path: "http://evil.example/steal" } });
    expect(outside.result.isError).toBe(true);
    const climb = await ask(6, "tools/call", { name: "api", arguments: { method: "GET", path: "/api/../instance" } });
    expect(climb.result.isError).toBe(true);
    child.kill();

    const exchanges = seen.filter((r) => r.url === "/api/board/chat/runs/run-1/token");
    expect(exchanges).toHaveLength(1);
    expect(JSON.parse(exchanges[0]!.body)).toEqual({ code: "pcp_bcboot_once" });
    expect(exchanges[0]!.auth).toBeUndefined();
    const apiCalls = seen.filter((r) => r.url !== "/api/board/chat/runs/run-1/token");
    expect(apiCalls.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/companies/c1/dashboard", "POST /api/companies/c1/issues"]);
    for (const call of apiCalls) {
      expect(call.auth).toBe("Bearer pcp_bcrun_test");
      expect(call.host).toBe(`localhost:${port}`);
    }
  }, 20_000);

  it("builds CLI arguments with no built-in tools and only the connector allowed", () => {
    const args = buildSignedInBoardChatArgs({ systemPrompt: "x", mcpConfig: "{}" });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(BOARD_CHAT_CONNECTOR_ALLOWED_TOOL);
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true });
    // No settings files or CLAUDE.md notes from the box are read.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });
});
