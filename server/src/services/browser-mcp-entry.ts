/**
 * DUR-4013 step 3: whether to fold the `paperclip-browser` MCP server into
 * an agent's adapterConfig.mcpServers this dispatch, next to the DUR-143
 * tool-library block in heartbeat.ts. Not a Tools-library row -- a quick
 * agent (which never gets an `agent` actor, see routes/browser.ts) never
 * sees this regardless of `agents.browser_access`, and this only ever adds
 * the entry for a value other than "off".
 *
 * The subprocess is `node <mcp-server dist>/browser-stdio.js`, spawned by
 * the same CLI process as every other MCP server the agent has configured,
 * so it inherits `PAPERCLIP_API_URL`/`PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID`
 * from the agent's own run environment -- no separate credential to mint or
 * leak (`packages/mcp-server/src/config.ts` reads those same names).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { logger } from "../middleware/logger.js";

const require = createRequire(import.meta.url);

let cachedDistPath: string | null | undefined;

/** Resolved once per process; a missing build (dev/CI without `pnpm build`) degrades to "no browser tool offered" rather than a crash. */
function resolveBrowserMcpDistPath(): string | null {
  if (cachedDistPath !== undefined) return cachedDistPath;
  try {
    const packageJsonPath = require.resolve("@paperclipai/mcp-server/package.json");
    cachedDistPath = path.join(path.dirname(packageJsonPath), "dist/browser-stdio.js");
  } catch (error) {
    logger.warn({ err: error }, "Could not resolve @paperclipai/mcp-server; browser MCP tool will not be offered");
    cachedDistPath = null;
  }
  return cachedDistPath;
}

export interface BrowserAccessAgentInfo {
  browserAccess?: string | null;
}

/** `null` when the switch is off (the default) or the server package isn't built -- either way, add nothing. */
export function resolveBrowserMcpServerEntry(agent: BrowserAccessAgentInfo): Record<string, unknown> | null {
  if (!agent.browserAccess || agent.browserAccess === "off") return null;
  const distPath = resolveBrowserMcpDistPath();
  if (!distPath) return null;
  return {
    name: "paperclip-browser",
    transport: "stdio",
    command: "node",
    args: [distPath],
  };
}

/** Test-only: clears the cached dist-path resolution between test cases. */
export function _resetBrowserMcpEntryCacheForTests(): void {
  cachedDistPath = undefined;
}
