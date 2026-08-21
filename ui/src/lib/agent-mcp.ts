/**
 * Which adapter types support per-agent MCP (Model Context Protocol) server
 * config today, and the adapterConfig key it's stored under. Single source of
 * truth so the per-agent config form and any future bulk tooling don't drift
 * apart. Extending this to another local/CLI adapter is a small, mechanical
 * change: wire the adapter's own dispatch to read this key (see claude_local's
 * mcp-config.ts / codex_local's runtime-config.ts) and add it here.
 */

export const MCP_SERVERS_ADAPTER_CONFIG_KEY = "mcpServers";

export function supportsMcpServers(adapterType: string): boolean {
  return adapterType === "claude_local" || adapterType === "codex_local";
}
