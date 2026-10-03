import type { Db } from "@paperclipai/db";
import type { ApiToolAction } from "@paperclipai/shared/validators/api-tool";
import { apiToolService, type ApiToolAgentView } from "./api-tools.js";

/**
 * DUR-4004: how a FULL agent learns about its "API with a key" tools.
 *
 * An MCP server from the tool library needs no announcement: it is folded
 * into adapterConfig.mcpServers and the CLI sees its tools natively. An API
 * tool has no MCP surface, so the heartbeat puts this markdown into the run
 * context (context.paperclipApiToolsMarkdown) and the adapter renders it as
 * one prompt section. The agent calls an action over HTTP with its own run
 * token; the server attaches the key, guards the call and counts it. The
 * agent never sees the key.
 *
 * Kept short on purpose: the prompt is re-sent on every turn.
 */

function describeInput(input: ApiToolAction["inputs"][number]): string {
  const bits: string[] = [input.type];
  if (input.required) bits.push("required");
  return `${input.name} (${bits.join(", ")})${input.description ? `: ${input.description}` : ""}`;
}

export function renderApiToolsAnnouncement(companyId: string, tools: ApiToolAgentView[]): string {
  const withActions = tools.filter((tool) => tool.actions.length > 0);
  if (withActions.length === 0) return "";
  const lines: string[] = [
    "## Tools with a key (API tools)",
    "",
    "You may call these web APIs. Paperclip adds the key for you; you never see it, so do not ask for it and do not try to call the service directly.",
    "Call one action with a POST to your Paperclip API, using your own run token:",
    "",
    "```",
    `curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/${companyId}/api-tools/<toolId>/actions/<action>/run" \\`,
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \\',
    "  -d '{\"input\": { ... }}'",
    "```",
    "",
    "The answer is JSON: { ok, status, contentType, body (text, cut at 50 KB), urls (links found in the answer), error }.",
    "Each tool has a daily call limit; a refusal comes back as a plain sentence. Inputs marked required must be given.",
  ];
  for (const tool of withActions) {
    lines.push("", `### ${tool.name} (toolId ${tool.id})${tool.description ? ` - ${tool.description}` : ""}`);
    for (const action of tool.actions) {
      const inputs = action.inputs.length === 0 ? "no inputs" : action.inputs.map(describeInput).join("; ");
      lines.push(`- ${action.name}: ${action.method} ${action.path}${action.description ? ` - ${action.description}` : ""}. Inputs: ${inputs}.`);
    }
  }
  return lines.join("\n");
}

/** Empty string when the agent has no active API tool with at least one action. */
export async function buildApiToolsAnnouncement(db: Db, companyId: string, agentId: string): Promise<string> {
  const svc = apiToolService(db);
  const toolIds = await svc.agentToolIds(companyId, agentId);
  if (toolIds.length === 0) return "";
  const tools = await svc.listGranted(companyId, toolIds);
  return renderApiToolsAnnouncement(companyId, tools);
}
