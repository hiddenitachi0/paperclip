import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Plug } from "lucide-react";
import { mcpToolLibraryApi, type AgentMcpToolListItem } from "../api/mcpToolLibrary";
import { queryKeys } from "../lib/queryKeys";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./EmptyState";

// DUR-184 item 13 + item 15: the same picture-tools picker shown twice --
// editable during persona setup ("which image tools does she get?") and
// read-only on her detail page ("what can she actually use?"). Both reuse
// the agent-level MCP tool library toggle (mcpToolLibrary.ts) that already
// exists on AgentDetail's Tools tab, since a persona's tools ARE her
// underlying agent's tools -- there is no separate persona-level tool list.
export function PersonaMcpToolsPanel({
  agentId,
  readOnly = false,
}: {
  agentId: string;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [pendingToolId, setPendingToolId] = useState<string | null>(null);

  const { data: tools, isLoading, error } = useQuery({
    queryKey: queryKeys.mcpTools.forAgent(agentId),
    queryFn: () => mcpToolLibraryApi.listForAgent(agentId),
  });

  const syncTools = useMutation({
    mutationFn: (desiredToolIds: string[]) => mcpToolLibraryApi.syncAgentSelection(agentId, desiredToolIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcpTools.forAgent(agentId) });
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

  const enabledTools = (tools ?? []).filter((tool) => tool.enabled);

  if (isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">Could not load picture tools.</p>;
  }

  if (!tools || tools.length === 0) {
    return (
      <EmptyState
        icon={Plug}
        message="No tools in the library yet. Add an image tool (like an image generator) in Tools, then come back here to give it to her."
        action={readOnly ? undefined : "Go to Tools"}
        onAction={readOnly ? undefined : () => window.location.assign("/tools")}
      />
    );
  }

  if (readOnly) {
    return enabledTools.length === 0 ? (
      <p className="text-sm text-muted-foreground">
        She doesn't have any picture tools yet. Give her one from{" "}
        <Link to="/tools" className="underline underline-offset-2">
          Tools
        </Link>
        .
      </p>
    ) : (
      <ul className="divide-y divide-border border border-border rounded-lg">
        {enabledTools.map((tool) => (
          <li key={tool.id} className="px-4 py-3">
            <div className="font-medium">{tool.name}</div>
            <p className="text-sm text-muted-foreground">{tool.description}</p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tick a tool to give her access to it -- connected once in{" "}
        <Link to="/tools" className="underline underline-offset-2">
          Tools
        </Link>
        , picked here for this persona. Untick to take it away.
      </p>
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
      {syncTools.isError && (
        <p className="text-xs text-destructive">
          {syncTools.error instanceof Error ? syncTools.error.message : "Couldn't save her tools."}
        </p>
      )}
    </div>
  );
}
