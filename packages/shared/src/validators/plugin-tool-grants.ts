import { z } from "zod";

// DUR-189: a plugin tool's namespaced identifier is "<pluginId>:<toolName>"
// (see TOOL_NAMESPACE_SEPARATOR in server/src/services/plugin-tool-registry.ts).
// Grants are stored as plain strings in this format, not tool-library UUIDs —
// plugin-registered tools (agent.tools.register) have no company_mcp_tools row.
const NAMESPACED_TOOL_NAME_RE = /^[^:\s]+:[^:\s]+$/;

export const agentPluginToolGrantSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(NAMESPACED_TOOL_NAME_RE, 'Expected a namespaced tool name, e.g. "acme.linear:search-issues"');

export const agentPluginToolSelectionSchema = z
  .object({
    desiredToolNames: z.array(agentPluginToolGrantSchema).max(200),
  })
  .strict();

export type AgentPluginToolSelection = z.infer<typeof agentPluginToolSelectionSchema>;
