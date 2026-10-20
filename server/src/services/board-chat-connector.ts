/**
 * The Board chat run's ONLY tool on a signed-in server: a tiny Paperclip
 * connector (a stdio MCP server) that sends one request to this Paperclip's
 * own API and returns the answer.
 *
 * Why it looks like this:
 *   * It is passed to the CLI inline (`node --input-type=module -e <script>`),
 *     so no script file sits in a folder an agent could change before it runs.
 *   * It imports nothing but Node built-ins, and runs with NODE_OPTIONS
 *     cleared, so nothing can be loaded into it from the box.
 *   * It is started with the server's own Node binary. On the Docker image
 *     that binary is unreadable to agents, which makes this process's memory
 *     and environment unreadable to them too: the run credential lives only
 *     here, in memory, after the connector swaps its one-time code for it.
 *   * It can only reach paths under /api/ and /llms/ on this one server. What
 *     those paths allow is decided by the server (board-chat-guard.ts), not
 *     here: this file is a convenience, not the gate.
 */
export const BOARD_CHAT_CONNECTOR_SERVER_NAME = "paperclip";
export const BOARD_CHAT_CONNECTOR_TOOL_NAME = "api";
/** The tool name the CLI sees, for --allowedTools. */
export const BOARD_CHAT_CONNECTOR_ALLOWED_TOOL = `mcp__${BOARD_CHAT_CONNECTOR_SERVER_NAME}__${BOARD_CHAT_CONNECTOR_TOOL_NAME}`;

export const BOARD_CHAT_CONNECTOR_SCRIPT = String.raw`
import http from "node:http";
import readline from "node:readline";

const HOST = process.env.PAPERCLIP_BC_HOST || "127.0.0.1";
const PORT = Number(process.env.PAPERCLIP_BC_PORT || "3100");
const HOST_HEADER = process.env.PAPERCLIP_BC_HOST_HEADER || ("localhost:" + PORT);
const RUN_ID = process.env.PAPERCLIP_BC_RUN_ID || "";
let bootstrap = process.env.PAPERCLIP_BC_BOOTSTRAP || "";
delete process.env.PAPERCLIP_BC_BOOTSTRAP;
let token = null;
let tokenPromise = null;
const MAX_RESULT_CHARS = 100000;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function call(method, path, body, bearer) {
  return new Promise((resolve) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = { host: HOST_HEADER, accept: "application/json" };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (bearer) headers.authorization = "Bearer " + bearer;
    const req = http.request({ host: HOST, port: PORT, method, path, headers, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ status: 0, text: String(err && err.message ? err.message : err) }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function getToken() {
  if (token) return Promise.resolve(token);
  if (!tokenPromise) {
    const code = bootstrap;
    bootstrap = "";
    tokenPromise = call("POST", "/api/board/chat/runs/" + encodeURIComponent(RUN_ID) + "/token", { code }, null).then((res) => {
      if (res.status !== 200) return null;
      try {
        const parsed = JSON.parse(res.text);
        token = typeof parsed.token === "string" ? parsed.token : null;
      } catch {
        token = null;
      }
      return token;
    });
  }
  return tokenPromise;
}

const TOOL = {
  name: "api",
  description:
    "Call this Paperclip's API as the signed-in person, inside the current company only. " +
    "Reading (GET) works straight away. Every change (POST, PATCH, PUT, DELETE) is NOT made: it is held as a card " +
    "the person must approve, and the answer says so (held: true). Never repeat a held change. " +
    "Paths start with /api/ (or /llms/ for reference docs). Use JSON bodies.",
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
      path: { type: "string", description: "For example /api/companies/<companyId>/issues?status=todo" },
      body: { type: "object", description: "JSON body for POST, PATCH and PUT." },
    },
    required: ["method", "path"],
    additionalProperties: false,
  },
};

async function runTool(args) {
  const method = String((args && args.method) || "GET").toUpperCase();
  const path = String((args && args.path) || "");
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    return { isError: true, text: "Unsupported method." };
  }
  if (!(path.startsWith("/api/") || path.startsWith("/llms/")) || path.includes("..") || path.includes("\\")) {
    return { isError: true, text: "Only paths under /api/ or /llms/ on this Paperclip are allowed." };
  }
  const bearer = await getToken();
  if (!bearer) {
    return { isError: true, text: "Board chat could not sign in to Paperclip for this message. Tell the person to try again." };
  }
  const res = await call(method, path, method === "GET" ? undefined : args.body, bearer);
  let text = "HTTP " + res.status + "\n" + res.text;
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + "\n... (cut off)";
  return { isError: res.status === 0 || res.status >= 400, text };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  try {
    if (msg.method === "initialize") {
      getToken();
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "paperclip-board-chat", version: "1.0.0" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    } else if (msg.method === "tools/call") {
      const name = msg.params && msg.params.name;
      if (name !== "api") {
        send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Unknown tool." }] } });
        return;
      }
      const out = await runTool((msg.params && msg.params.arguments) || {});
      send({ jsonrpc: "2.0", id, result: { isError: out.isError, content: [{ type: "text", text: out.text }] } });
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (isRequest) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (err) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err && err.message ? err.message : err) } });
  }
});
rl.on("close", () => process.exit(0));
`;

/** Built-in CLI tools named explicitly as denied, on top of `--tools ""` which removes them all. */
export const BOARD_CHAT_DENIED_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
  "Skill",
  "SlashCommand",
];

/** Added to the board skill on signed-in servers, where the run has no shell. */
export const BOARD_CHAT_SIGNED_IN_PROMPT_ADDENDUM = `

## How you work in this chat (signed-in Paperclip)

- You have NO shell, no files and no web access here. Ignore every instruction above about curl, bash or local files.
- You have exactly one tool, \`api\`, which calls this Paperclip's API as the person you are talking to. Give it a method, a path (starting with /api/) and, for changes, a JSON body. \`$PAPERCLIP_API_URL\` is not needed: paths are on this server.
- You can only see and change the company in PAPERCLIP_COMPANY_ID (given below). Other companies are out of reach.
- Reading is free. EVERY change you send is NOT made: Paperclip holds it as a card in this chat with Approve and Cancel buttons, and answers with \`held: true\`. Then tell the person in one or two plain sentences what you prepared and stop. Never send the same change twice. The person decides.
- Prepare one change at a time unless the person clearly asked for several.
- You can never approve or reject deploy or merge cards, and some other changes are refused. When Paperclip refuses, explain it plainly and point the person to the page where they can do it themselves.
- Speak plainly. The person may not be technical: no ids, no JSON, no HTTP codes in your replies.
`;

export function buildBoardChatMcpConfig(input: {
  nodePath: string;
  host: string;
  port: number;
  hostHeader: string;
  runId: string;
  bootstrapCode: string;
}): string {
  return JSON.stringify({
    mcpServers: {
      [BOARD_CHAT_CONNECTOR_SERVER_NAME]: {
        type: "stdio",
        command: input.nodePath,
        args: ["--input-type=module", "-e", BOARD_CHAT_CONNECTOR_SCRIPT],
        env: {
          NODE_OPTIONS: "",
          PAPERCLIP_BC_HOST: input.host,
          PAPERCLIP_BC_PORT: String(input.port),
          PAPERCLIP_BC_HOST_HEADER: input.hostHeader,
          PAPERCLIP_BC_RUN_ID: input.runId,
          PAPERCLIP_BC_BOOTSTRAP: input.bootstrapCode,
        },
      },
    },
  });
}

/**
 * CLI arguments for a signed-in Board chat run. Compared with the local
 * single-user run, which keeps its old arguments unchanged:
 *   * no --dangerously-skip-permissions;
 *   * --tools "" removes every built-in tool (shell, files, web, sub-agents);
 *   * --strict-mcp-config + --mcp-config: the Paperclip connector is the only
 *     tool server, and --allowedTools pre-approves only its one tool;
 *   * --permission-mode dontAsk: anything not pre-approved is refused, never asked;
 *   * --setting-sources "" + disableAllHooks: no settings files, CLAUDE.md
 *     notes, hooks or plugins from the box (which agents can write to) are
 *     loaded -- only these flags;
 *   * no slash commands or skills, nothing saved to disk.
 */
export function buildSignedInBoardChatArgs(input: { systemPrompt: string; mcpConfig: string; model?: string }): string[] {
  return [
    "-p",
    "-",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--append-system-prompt",
    input.systemPrompt,
    "--model",
    input.model ?? "sonnet",
    "--tools",
    "",
    "--mcp-config",
    input.mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    BOARD_CHAT_CONNECTOR_ALLOWED_TOOL,
    "--disallowedTools",
    BOARD_CHAT_DENIED_BUILTIN_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}
