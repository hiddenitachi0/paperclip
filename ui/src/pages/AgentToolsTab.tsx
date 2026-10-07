import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { mcpToolLibraryApi, type AgentMcpToolListItem } from "../api/mcpToolLibrary";
import { AgentApiToolsSection } from "../components/AgentApiToolsSection";
import { queryKeys } from "../lib/queryKeys";
import { AgentAddOnToolsSection } from "../components/AgentAddOnToolsSection";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { type Agent } from "@paperclipai/shared";

export function AgentToolsTab({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const [pendingToolId, setPendingToolId] = useState<string | null>(null);

  const { data: tools, isLoading, error } = useQuery({
    queryKey: queryKeys.mcpTools.forAgent(agent.id),
    queryFn: () => mcpToolLibraryApi.listForAgent(agent.id),
    enabled: Boolean(companyId),
  });

  const syncTools = useMutation({
    mutationFn: (desiredToolIds: string[]) => mcpToolLibraryApi.syncAgentSelection(agent.id, desiredToolIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcpTools.forAgent(agent.id) });
    },
    onSettled: () => setPendingToolId(null),
  });

  function toggleTool(tool: AgentMcpToolListItem, checked: boolean) {
    if (!tools) return;
    const current = tools.filter((t) => t.enabled).map((t) => t.id);
    const next = checked ? [...current, tool.id] : current.filter((id) => id !== tool.id);
    setPendingToolId(tool.id);
    syncTools.mutate(next);
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Tick a tool to give this agent access to it — connected in{" "}
          <Link to="/tools" className="underline underline-offset-2">
            Tools
          </Link>
          , picked here. Untick to remove it.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : error ? (
        <p className="text-sm text-destructive">Could not load tools.</p>
      ) : !tools || tools.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="library-tools-empty">
          No tools in the library yet.{" "}
          <Link to="/tools" className="underline underline-offset-2">
            Add one in Tools
          </Link>
          , then come back here to give it to this agent. Tools from add-ons such as Media Studio are listed below.
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {tools.map((tool) => (
            <li key={tool.id} className="flex items-start gap-3 px-4 py-3">
              <Checkbox
                checked={tool.enabled}
                disabled={syncTools.isPending && pendingToolId === tool.id}
                onCheckedChange={(checked) => toggleTool(tool, checked === true)}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="font-medium">{tool.name}</div>
                <p className="text-sm text-muted-foreground">{tool.description}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {syncTools.isError && (
        <p className="text-xs text-destructive">
          {syncTools.error instanceof Error ? syncTools.error.message : "Failed to update tools"}
        </p>
      )}

      {/* Tools that installed add-ons (plugins) bring; ticks write agents.plugin_tool_grants. */}
      <AgentAddOnToolsSection agentId={agent.id} quickAgent={agent.laneAEnabled === true} />

      {/* DUR-4004: "API with a key" tools, ticked on the same way. */}
      <AgentApiToolsSection agentId={agent.id} companyId={companyId} />
    </div>
  );
}
