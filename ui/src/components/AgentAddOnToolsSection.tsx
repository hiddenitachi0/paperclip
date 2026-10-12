import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { pluginsApi, type AgentPluginToolOption } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "../lib/instance-settings";
import { groupAddOnTools, selectionWithGroup, splitFirstSentence } from "../lib/add-on-tool-groups";
import { SettingsSection, SettingsSubsection } from "./SettingsSection";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

export const INSTANCE_PLUGINS_PATH = `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`;

/**
 * "Tools from add-ons" on an agent's Tools tab: every tool the installed
 * add-ons (plugins) offer this company, with a tick per tool that writes
 * `agents.plugin_tool_grants` through the existing sync route.
 *
 * Tools are grouped by the label their add-on gives them ("Pictures",
 * "Picture editing", "Video and sound"; see lib/add-on-tool-groups.ts), each
 * group foldable with a "Turn all on/off" button that sends the whole new
 * ticked list in one sync call. On a full agent the button reads "Allow only
 * these" while nothing is ticked, and "Allow all add-on tools" when unticking
 * the group would empty the list. All ticks wait while a change is saving. Only a description's first sentence shows
 * until "More" is pressed.
 *
 * The tick means two different things, and the text says so: a quick agent
 * only gets what is ticked here (nothing ticked = no add-on tools); a full
 * agent gets every add-on tool while nothing is ticked, and only the ticked
 * ones once something is.
 */
export function AgentAddOnToolsSection({ agentId, quickAgent }: { agentId: string; quickAgent: boolean }) {
  const queryClient = useQueryClient();

  const grantsQuery = useQuery({
    queryKey: queryKeys.plugins.agentToolGrants(agentId),
    queryFn: () => pluginsApi.agentToolGrants(agentId),
  });

  const syncGrants = useMutation({
    mutationFn: (desiredToolNames: string[]) => pluginsApi.syncAgentToolGrants(agentId, desiredToolNames),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.plugins.agentToolGrants(agentId) });
    },
  });

  function toggleTool(tool: AgentPluginToolOption, checked: boolean) {
    if (!grantsQuery.data) return;
    const current = grantsQuery.data.grantedToolNames;
    const next = checked ? [...current, tool.name] : current.filter((name) => name !== tool.name);
    syncGrants.mutate([...new Set(next)]);
  }

  function toggleGroup(groupTools: AgentPluginToolOption[], turnOn: boolean) {
    if (!grantsQuery.data) return;
    const names = groupTools.map((tool) => tool.name);
    syncGrants.mutate(selectionWithGroup(grantsQuery.data.grantedToolNames, names, turnOn));
  }

  const tools = grantsQuery.data?.availableTools ?? [];
  const granted = new Set(grantsQuery.data?.grantedToolNames ?? []);
  const groups = groupAddOnTools(tools);
  // A full agent with nothing ticked may use every add-on tool (see the text below).
  const fullAgentUnrestricted = !quickAgent && granted.size === 0;
  const tickedCount = tools.filter((tool) => granted.has(tool.name)).length;

  const sectionSummary =
    tools.length === 0
      ? undefined
      : fullAgentUnrestricted
        ? `None ticked, so all ${tools.length} allowed`
        : `${tickedCount} of ${tools.length} on`;

  return (
    <SettingsSection
      title="Tools from add-ons"
      description={
        <>
          Add-ons installed in Paperclip can bring their own tools — Media Studio, for example, adds one that makes an
          image. Tick a tool to let this agent use it.{" "}
          {quickAgent
            ? "A quick agent only gets the tools ticked here; nothing ticked means no add-on tools."
            : "While nothing is ticked, a full agent may use every add-on tool; tick some to allow only those. A quick agent only ever gets the ticked ones."}
        </>
      }
      summary={sectionSummary}
      storageKey="agent.tools.addOns"
      data-testid="add-on-tools"
    >
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
        <div className="space-y-4">
          {groups.map((group) => {
            const onCount = group.tools.filter((tool) => granted.has(tool.name)).length;
            const allOn = onCount === group.tools.length;
            // While a full agent has nothing ticked it may use every add-on tool, so
            // ticking this group narrows it to just these. And unticking the only
            // ticked group empties the list, which gives a full agent every tool again.
            const turnOn = fullAgentUnrestricted || !allOn;
            const toggleLabel = fullAgentUnrestricted
              ? "Allow only these"
              : !allOn
                ? "Turn all on"
                : !quickAgent && onCount === granted.size
                  ? "Allow all add-on tools"
                  : "Turn all off";
            return (
              <SettingsSubsection
                key={group.key}
                title={group.title}
                summary={
                  fullAgentUnrestricted
                    ? `None ticked, so all ${group.tools.length} allowed`
                    : `${onCount} of ${group.tools.length} on`
                }
                storageKey={`agent.tools.addOns.${group.key}`}
                data-testid="add-on-tools-group"
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={syncGrants.isPending}
                    onClick={() => toggleGroup(group.tools, turnOn)}
                    aria-label={`${toggleLabel}: ${group.title}`}
                    data-testid="add-on-tools-group-toggle"
                  >
                    {toggleLabel}
                  </Button>
                }
              >
                <ul className="divide-y divide-border">
                  {group.tools.map((tool) => (
                    <AddOnToolRow
                      key={tool.name}
                      tool={tool}
                      checked={granted.has(tool.name)}
                      disabled={syncGrants.isPending}
                      onCheckedChange={(checked) => toggleTool(tool, checked)}
                    />
                  ))}
                </ul>
              </SettingsSubsection>
            );
          })}
        </div>
      )}

      {syncGrants.isError && (
        <p className="text-xs text-destructive">
          {syncGrants.error instanceof Error ? syncGrants.error.message : "Could not update the add-on tools."}
        </p>
      )}
    </SettingsSection>
  );
}

function AddOnToolRow({
  tool,
  checked,
  disabled,
  onCheckedChange,
}: {
  tool: AgentPluginToolOption;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { first, rest } = splitFirstSentence(tool.description ?? "");
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0" data-testid="add-on-tool">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={`${tool.displayName} from ${tool.pluginDisplayName}`}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <div className="font-medium">
          {tool.displayName}{" "}
          <span className="text-xs font-normal text-muted-foreground">from {tool.pluginDisplayName}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {first}
          {rest && expanded ? ` ${rest}` : null}
          {rest ? (
            <>
              {" "}
              <button
                type="button"
                className="text-xs font-medium text-foreground underline underline-offset-2 hover:no-underline"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                data-testid="add-on-tool-more"
              >
                {expanded ? "Less" : "More"}
              </button>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}
