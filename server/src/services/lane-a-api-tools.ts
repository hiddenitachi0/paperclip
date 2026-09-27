import type Anthropic from "@anthropic-ai/sdk";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { Db } from "@paperclipai/db";
import { apiToolActionInputJsonSchema } from "@paperclipai/shared/validators/api-tool";
import { HttpError } from "../errors.js";
import { apiToolService, type ApiToolRunResult, type ApiToolServiceDeps } from "./api-tools.js";
import { isLaneABuiltinTool } from "./lane-a-tools.js";

/**
 * DUR-4004: "API with a key" tools for quick agents (Lane A).
 *
 * Each action of each API tool ticked on the agent becomes one Anthropic-style
 * tool named `<toolKey>__<action>`, next to the MCP tool-library tools
 * lane-a.ts already loads. Execution goes through apiToolService.runAction,
 * so the key is attached server-side, the call is guarded and audited, and
 * the tool's daily cap applies; the call also counts against
 * LANE_A_MAX_TOOL_CALLS like any other tool call, because the tool-use loop
 * in lane-a.ts does not know or care that this tool is not an MCP one.
 *
 * The toolset shape mirrors lane-a.ts's LaneAToolset minus `clients`: the
 * "client" here is a tiny object with the one method the loop calls
 * (`callTool`), so the loop needs no branch for this kind of tool.
 */

export type LaneAApiToolClient = Pick<McpClient, "callTool">;

export interface LaneAApiToolset {
  anthropicTools: Anthropic.Tool[];
  toolIndex: Map<string, { client: LaneAApiToolClient; toolName: string }>;
}

const EMPTY: LaneAApiToolset = { anthropicTools: [], toolIndex: new Map() };

// Same rule lane-a.ts applies to MCP tool names: Anthropic tool names must
// match ^[a-zA-Z0-9_-]{1,128}$.
function sanitizeToolNamePart(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "tool";
}

/** How a call's outcome is shown to the model: status line, then the (already scrubbed and cut) answer, then any links. */
export function formatApiToolResultForModel(result: ApiToolRunResult): string {
  if (result.error) return `The call did not get an answer: ${result.error}`;
  const lines = [`HTTP ${result.status}${result.contentType ? ` (${result.contentType})` : ""}${result.ok ? "" : " - the service refused or failed the request"}`];
  if (result.body.trim()) lines.push("", result.body);
  if (result.urls.length > 0) lines.push("", "Links in the answer:", ...result.urls.map((url) => `- ${url}`));
  return lines.join("\n");
}

export async function loadLaneAApiTools(
  db: Db,
  companyId: string,
  agentId: string,
  deps: ApiToolServiceDeps = {},
): Promise<LaneAApiToolset> {
  const svc = apiToolService(db, deps);
  // Same posture as the MCP loader in lane-a.ts: a problem reading the
  // tools must not fail the chat turn; the quick agent degrades to plain chat.
  let tools: Awaited<ReturnType<typeof svc.listGranted>>;
  try {
    const toolIds = await svc.agentToolIds(companyId, agentId);
    if (toolIds.length === 0) return EMPTY;
    tools = await svc.listGranted(companyId, toolIds);
  } catch {
    return EMPTY;
  }
  if (tools.length === 0) return EMPTY;

  const anthropicTools: Anthropic.Tool[] = [];
  const toolIndex: LaneAApiToolset["toolIndex"] = new Map();
  for (const tool of tools) {
    const toolPart = sanitizeToolNamePart(tool.key);
    for (const action of tool.actions) {
      const qualifiedName = `${toolPart}__${sanitizeToolNamePart(action.name)}`.slice(0, 128);
      // Built-in names win, exactly as for MCP library tools.
      if (isLaneABuiltinTool(qualifiedName) || toolIndex.has(qualifiedName)) continue;
      const what = action.description || `${action.method} ${action.path}`;
      anthropicTools.push({
        name: qualifiedName,
        description: `${tool.name}: ${what}`.slice(0, 1024),
        input_schema: apiToolActionInputJsonSchema(action) as Anthropic.Tool["input_schema"],
      });
      const client: LaneAApiToolClient = {
        callTool: async (params) => {
          try {
            const result = await svc.runAction(
              companyId,
              tool.id,
              action.name,
              (params.arguments ?? {}) as Record<string, unknown>,
              { channel: "quick_chat", agentId, userId: null, runId: null },
            );
            return { content: [{ type: "text", text: formatApiToolResultForModel(result) }], isError: !result.ok };
          } catch (error) {
            const text = error instanceof HttpError ? error.message : "The tool could not be called.";
            return { content: [{ type: "text", text }], isError: true };
          }
        },
      };
      toolIndex.set(qualifiedName, { client, toolName: action.name });
    }
  }
  return { anthropicTools, toolIndex };
}
