import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { pluginsApi, type AgentPluginToolOption } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "../lib/instance-settings";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

export const INSTANCE_PLUGINS_PATH = `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`;

/**
 * "Tools from add-ons" on an agent's Tools tab: every tool the installed
 * add-ons (plugins) offer this company, with a tick per tool that writes
 * `agents.plugin_tool_grants` through the existing sync route.
 *
 * The tick means two different things, and the text says so: a quick agent
 * only gets what is ticked here (nothing ticked = no add-on tools); a full
 * agent gets every add-on tool while nothing is ticked, and only the ticked
 * ones once something is.
 */
export function AgentAddOnToolsSection({ agentId, quickAgent }: { agentId: string; quickAgent: boolean }) {
  const queryClient = useQueryClient();
  const [pendingToolName, setPendingToolName] = useState<string | null>(null);

  const grantsQuery = useQuery({
    queryKey: queryKeys.plugins.agentToolGrants(agentId),
    queryFn: () => pluginsApi.agentToolGrants(agentId),
  });

  const syncGrants = useMutation({
    mutationFn: (desiredToolNames: string[]) => pluginsApi.syncAgentToolGrants(agentId, desiredToolNames),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.plugins.agentToolGrants(agentId) });
    },
    onSettled: () => setPendingToolName(null),
  });

  function toggleTool(tool: AgentPluginToolOption, checked: boolean) {
    if (!grantsQuery.data) return;
    const current = grantsQuery.data.grantedToolNames;
    const next = checked ? [...current, tool.name] : current.filter((name) => name !== tool.name);
    setPendingToolName(tool.name);
    syncGrants.mutate([...new Set(next)]);
  }

  const tools = grantsQuery.data?.availableTools ?? [];
  const granted = new Set(grantsQuery.data?.grantedToolNames ?? []);

  return (
    <section className="space-y-3 border-t border-border pt-4" data-testid="add-on-tools">
      <div>
        <h3 className="text-sm font-medium">Tools from add-ons</h3>
        <p className="text-sm text-muted-foreground">
          Add-ons installed in Paperclip can bring their own tools — Media Studio, for example, adds one that makes
          an image. Tick a tool to let this agent use it.{" "}
          {quickAgent
            ? "A quick agent only gets the tools ticked here; nothing ticked means no add-on tools."
            : "While nothing is ticked, a full agent may use every add-on tool; tick some to allow only those. A quick agent only ever gets the ticked ones."}
        </p>
      </div>

      {grantsQuery.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : grantsQuery.error ? (
        <p className="text-sm text-destructive">Could not load the add-on tools.</p>
      ) : tools.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="add-on-tools-empty">
          No add-on tools yet. An instance admin can install an add-on under{" "}
          <Link to={INSTANCE_PLUGINS_PATH} className="underline underline-offset-2">
            Instance settings → Plugins
          </Link>{" "}
          — Media Studio, for example, which makes images.
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-3 px-4 py-3">
              <Checkbox
                checked={granted.has(tool.name)}
                disabled={syncGrants.isPending && pendingToolName === tool.name}
                onCheckedChange={(checked) => toggleTool(tool, checked === true)}
                aria-label={`${tool.displayName} from ${tool.pluginDisplayName}`}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="font-medium">
                  {tool.displayName}{" "}
                  <span className="text-xs font-normal text-muted-foreground">from {tool.pluginDisplayName}</span>
                </div>
                <p className="text-sm text-muted-foreground">{tool.description}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {syncGrants.isError && (
        <p className="text-xs text-destructive">
          {syncGrants.error instanceof Error ? syncGrants.error.message : "Could not update the add-on tools."}
        </p>
      )}
    </section>
  );
}
