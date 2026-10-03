import type { Db } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PluginStatus } from "@paperclipai/shared";
import { isLaneATrustLimited } from "@paperclipai/shared";
import type { AgentToolDescriptor, PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import type { ToolExecutionResult } from "./plugin-tool-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";

/**
 * The one path every plugin (add-on) tool call takes, whoever asks for it:
 *
 * - a full agent over HTTP (POST /api/plugins/tools/execute, routes/plugins.ts)
 * - a quick agent from its chat turn (services/lane-a.ts)
 *
 * Same checks in the same order: the tool is registered (its plugin is
 * `ready`, or the dispatcher would have dropped it), the plugin is switched on
 * for the company, the agent is granted the tool, then the plugin worker runs
 * it. The route and the quick agent only differ in how they read the grant
 * list (see `PluginToolGrantPolicy`).
 */

/**
 * How `agents.plugin_tool_grants` is read. Decided here, from the agent row,
 * never by the caller — so an agent that is both a quick agent and runs
 * heartbeats gets one rule on every path, and the Tools tab text stays true.
 *
 * - `empty_means_all`: a full agent (`agents.lane_a_enabled` false). An
 *   empty list means unrestricted, which is what every agent had before the
 *   column existed (DUR-189), so treating "nothing set" as "no restriction"
 *   was not a regression there.
 * - `ticked_only`: a quick agent (`agents.lane_a_enabled` true). It only
 *   gets the tools that are explicitly ticked on its Tools tab; an empty
 *   list means none. A quick agent runs with no approval card and no
 *   workspace, so it never inherits a tool by accident.
 */
export type PluginToolGrantPolicy = "empty_means_all" | "ticked_only";

/** The fields of the agent row the grant decision needs. */
export interface PluginToolGrantAgent {
  laneAEnabled?: boolean | null;
  pluginToolGrants?: string[] | null;
  /**
   * DUR-4070: checked before the grant policy below, on every caller
   * (full-agent route and quick-agent chat alike). "limited" refuses every
   * plugin tool call outright, regardless of pluginToolGrants -- this is
   * also what keeps a "limited" full agent (laneAEnabled false, so it would
   * otherwise hit the empty_means_all policy) from getting an unrestricted
   * tool set.
   */
  laneATrustLevel?: string | null;
}

export function grantPolicyForAgent(agent: PluginToolGrantAgent): PluginToolGrantPolicy {
  return agent.laneAEnabled === true ? "ticked_only" : "empty_means_all";
}

export interface PluginToolExecutionRefusal {
  ok: false;
  /** The HTTP status the route answers with; the quick agent turns it into a sentence. */
  status: 403 | 404 | 500 | 502;
  error: string;
}

export type PluginToolExecutionOutcome =
  | { ok: true; result: ToolExecutionResult }
  | PluginToolExecutionRefusal;

export interface ExecutePluginToolInput {
  /** Fully namespaced tool name, e.g. `paperclip.media-studio:generate-image`. */
  tool: string;
  parameters: unknown;
  runContext: ToolRunContext;
  /** The agent row of `runContext.agentId`: `lane_a_enabled` picks the grant rule, `plugin_tool_grants` is the list. */
  agent: PluginToolGrantAgent;
}

/** A tool a company can tick for an agent: the registry entry plus the plugin it belongs to, in words. */
export interface CompanyPluginTool extends AgentToolDescriptor {
  /** The bare tool name inside its plugin. */
  toolName: string;
  pluginKey: string;
  pluginDisplayName: string;
}

export function checkPluginToolGrant(
  pluginToolGrants: string[],
  namespacedToolName: string,
  policy: PluginToolGrantPolicy,
): string | null {
  if (pluginToolGrants.includes(namespacedToolName)) return null;
  if (policy === "empty_means_all" && pluginToolGrants.length === 0) return null;
  return `Agent is not granted the "${namespacedToolName}" plugin tool`;
}

export function pluginToolExecutionService(db: Db, toolDispatcher: PluginToolDispatcher) {
  const registry = pluginRegistryService(db);

  /**
   * DUR-195: a company can disable a plugin for itself via
   * `plugin_company_settings.enabled` while the plugin stays `ready`
   * instance-wide. No settings row means the plugin has never been toggled
   * for that company and defaults to enabled (matches the column's
   * `DEFAULT true` and `upsertCompanySettings`' own default).
   */
  async function isPluginEnabledForCompany(pluginDbId: string, companyId: string): Promise<boolean> {
    const settings = await registry.getCompanySettings(pluginDbId, companyId);
    return settings ? settings.enabled : true;
  }

  /**
   * Every registered tool whose plugin is `ready` instance-wide and switched
   * on for this company, with the plugin's name for the screen. The tool
   * registry only holds tools of ready plugins, but the status is read again
   * here so a plugin that fell into `error` without an unload event is not
   * offered either.
   */
  async function listToolsForCompany(companyId: string): Promise<CompanyPluginTool[]> {
    const tools = toolDispatcher.listToolsForAgent();
    const pluginDbIds = [...new Set(tools.map((tool) => tool.pluginId))];
    const pluginsById = new Map<
      string,
      { pluginKey: string; displayName: string; status: PluginStatus; enabled: boolean } | null
    >();
    await Promise.all(
      pluginDbIds.map(async (pluginDbId) => {
        const [record, enabled] = await Promise.all([
          registry.getById(pluginDbId),
          isPluginEnabledForCompany(pluginDbId, companyId),
        ]);
        pluginsById.set(
          pluginDbId,
          record
            ? {
                pluginKey: record.pluginKey,
                displayName: record.manifestJson?.displayName ?? record.pluginKey,
                status: record.status,
                enabled,
              }
            : null,
        );
      }),
    );
    const out: CompanyPluginTool[] = [];
    for (const tool of tools) {
      const plugin = pluginsById.get(tool.pluginId);
      if (!plugin || plugin.status !== "ready" || !plugin.enabled) continue;
      const registered = toolDispatcher.getTool(tool.name);
      out.push({
        ...tool,
        toolName: registered?.name ?? tool.name,
        pluginKey: plugin.pluginKey,
        pluginDisplayName: plugin.displayName,
      });
    }
    return out;
  }

  async function execute(input: ExecutePluginToolInput): Promise<PluginToolExecutionOutcome> {
    const registeredTool = toolDispatcher.getTool(input.tool);
    if (!registeredTool) {
      return { ok: false, status: 404, error: `Tool "${input.tool}" not found` };
    }

    // DUR-195: the target company may have disabled this tool's plugin
    // (`plugin_company_settings.enabled = false`) even though the plugin is
    // `ready` instance-wide. Enforce that gate here, not just at listing.
    const pluginEnabled = await isPluginEnabledForCompany(registeredTool.pluginDbId, input.runContext.companyId);
    if (!pluginEnabled) {
      return { ok: false, status: 403, error: `Plugin "${registeredTool.pluginId}" is disabled for this company` };
    }

    // DUR-4070: a "limited"-trust agent never reaches the grant policy below
    // -- not even the empty_means_all policy a full agent would otherwise
    // get -- so there is no code path left where "limited" plus an empty
    // pluginToolGrants ever resolves to "allowed".
    if (isLaneATrustLimited(input.agent.laneATrustLevel)) {
      return { ok: false, status: 403, error: "This agent's trust level (Limited) does not allow add-on tools." };
    }

    const grantError = checkPluginToolGrant(
      input.agent.pluginToolGrants ?? [],
      input.tool,
      grantPolicyForAgent(input.agent),
    );
    if (grantError) {
      return { ok: false, status: 403, error: grantError };
    }

    try {
      const result = await toolDispatcher.executeTool(input.tool, input.parameters ?? {}, input.runContext);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish between "worker not running" (502) and other errors (500)
      const status = message.includes("not running") || message.includes("worker") ? 502 : 500;
      return { ok: false, status, error: message };
    }
  }

  return { isPluginEnabledForCompany, listToolsForCompany, execute };
}

export type PluginToolExecutionService = ReturnType<typeof pluginToolExecutionService>;
