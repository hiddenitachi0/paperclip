import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { apiToolsApi, type AgentApiToolListItem } from "../api/apiTools";
import { queryKeys } from "../lib/queryKeys";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "./SettingsSection";

/**
 * DUR-4004: the "API with a key" half of an agent's Tools tab. Tick a tool
 * and every action it lists becomes something this agent can call (a quick
 * agent gets it as a chat tool, a full agent is told about it in its prompt
 * and calls it over HTTP); untick to take it away. The key never leaves the
 * server either way. Shown as a foldable "Tools with a key" section whose
 * closed heading says how many are on.
 */
export function AgentApiToolsSection({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const queryClient = useQueryClient();
  const [pendingToolId, setPendingToolId] = useState<string | null>(null);

  const { data: tools, isLoading, error } = useQuery({
    queryKey: queryKeys.apiTools.forAgent(agentId),
    queryFn: () => apiToolsApi.listForAgent(agentId),
    enabled: Boolean(companyId),
  });

  const sync = useMutation({
    mutationFn: (desiredToolIds: string[]) => apiToolsApi.syncAgentSelection(agentId, desiredToolIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiTools.forAgent(agentId) });
    },
    onSettled: () => setPendingToolId(null),
  });

  function toggle(tool: AgentApiToolListItem, checked: boolean) {
    if (!tools) return;
    const current = tools.filter((entry) => entry.enabled).map((entry) => entry.id);
    const next = checked ? [...current, tool.id] : current.filter((id) => id !== tool.id);
    setPendingToolId(tool.id);
    sync.mutate(next);
  }

  const enabledCount = tools?.filter((tool) => tool.enabled).length ?? 0;

  return (
    <SettingsSection
      title="Tools with a key"
      description={
        <>
          Services with an API key, added under{" "}
          <Link to="/tools" className="underline underline-offset-2">
            Tools
          </Link>{" "}
          as "API with a key". Tick one and this agent can call its actions; the key stays on the server.
        </>
      }
      summary={tools && tools.length > 0 ? `${enabledCount} of ${tools.length} on` : undefined}
      storageKey="agent.tools.withKey"
      data-testid="agent-api-tools"
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <p className="text-sm text-destructive">Could not load the API tools.</p>
      ) : !tools || tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No API tools yet. Add one on the Tools page ("Add tool", then "API with a key") and it will show up here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {tools.map((tool) => (
            <li key={tool.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <Checkbox
                checked={tool.enabled}
                disabled={sync.isPending && pendingToolId === tool.id}
                onCheckedChange={(checked) => toggle(tool, checked === true)}
                className="mt-0.5"
                aria-label={`Give this agent ${tool.name}`}
              />
              <div className="min-w-0">
                <div className="font-medium">
                  {tool.name}
                  {tool.status === "disabled" ? (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">switched off</span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {tool.description || "No description."}{" "}
                  {tool.actions.length === 0
                    ? "No actions yet."
                    : `${tool.actions.length} action${tool.actions.length === 1 ? "" : "s"}: ${tool.actions.map((action) => action.name).join(", ")}.`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sync.isError ? (
        <p className="text-xs text-destructive">{sync.error instanceof Error ? sync.error.message : "Could not update the tools."}</p>
      ) : null}
    </SettingsSection>
  );
}
