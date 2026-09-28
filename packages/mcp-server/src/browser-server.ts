import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createBrowserToolDefinitions } from "./browser-tools.js";

/**
 * DUR-4013 step 3: a separate MCP server from the main `paperclip` one
 * (index.ts) -- only offered to an agent when `agents.browser_access` is not
 * "off" (server/src/services/heartbeat.ts's built-in MCP-library injection),
 * so quick agents and agents without the switch never see these tools.
 */
export function createPaperclipBrowserMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip-browser",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createBrowserToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return { server, tools, client };
}

export async function runBrowserServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipBrowserMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
