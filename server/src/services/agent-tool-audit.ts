/**
 * Plain-language helpers shared by the audit-trail surfaces (activity log
 * entries and config revisions) and the tool-connection approval flow, so a
 * tool connection (adapterConfig.mcpServers) is always described to the
 * operator the same way regardless of which code path produced the change --
 * a direct board PATCH, a config-revision rollback, or an approved
 * `tool_grant` request.
 */

export interface McpServerSummary {
  name: string;
  kind: "command" | "web_address";
  target: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a single MCP server definition down to the fields an operator needs. */
export function summarizeMcpServer(raw: unknown): McpServerSummary | null {
  if (!isPlainRecord(raw)) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
  if (!name) return null;
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : null;
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : null;
  if (url) return { name, kind: "web_address", target: url };
  return { name, kind: "command", target: command ?? "" };
}

/** List every MCP server configured on an agent's adapterConfig. */
export function listMcpServers(adapterConfig: unknown): McpServerSummary[] {
  if (!isPlainRecord(adapterConfig)) return [];
  const raw = adapterConfig.mcpServers;
  if (!Array.isArray(raw)) return [];
  const summaries: McpServerSummary[] = [];
  for (const entry of raw) {
    const summary = summarizeMcpServer(entry);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** Diff the tool connections (by name) between two adapterConfig snapshots. */
export function diffMcpServers(
  beforeAdapterConfig: unknown,
  afterAdapterConfig: unknown,
): { added: McpServerSummary[]; removed: McpServerSummary[] } {
  const before = listMcpServers(beforeAdapterConfig);
  const after = listMcpServers(afterAdapterConfig);
  const beforeByName = new Map(before.map((server) => [server.name, server]));
  const afterByName = new Map(after.map((server) => [server.name, server]));

  const added = after.filter((server) => !beforeByName.has(server.name));
  const removed = before.filter((server) => !afterByName.has(server.name));

  return { added, removed };
}

/**
 * Plain-language description of what a tool connection can reach and what it
 * would be allowed to do -- shown to the operator both when a board caller
 * adds one directly and when an agent requests one via a `tool_grant`
 * approval. Always computed from the server definition itself, never trusted
 * from requester-supplied wording.
 */
export function describeToolCapability(server: McpServerSummary): string {
  if (server.kind === "web_address") {
    return `Connects to the web address "${server.target}" — the agent can send it requests and receive data back.`;
  }
  if (server.target) {
    return `Runs the command "${server.target}" on the box the agent's work executes on — the agent can do anything that command can do there.`;
  }
  return `Runs a command on the box the agent's work executes on — the agent can do anything that command can do there.`;
}
