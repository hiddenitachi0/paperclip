import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock3, ExternalLink, Moon, Settings } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@paperclipai/shared";
import { QUIET_MODE_STALE_AFTER_MS } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";

function QuietModeCard() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.quietMode,
    queryFn: () => instanceSettingsApi.getQuietMode(),
    refetchInterval: 10_000,
  });

  const invalidateAfterToggle = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.quietMode }),
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
    ]);

  const activateMutation = useMutation({
    mutationFn: () => instanceSettingsApi.activateQuietMode(),
    onSuccess: async () => {
      setError(null);
      await invalidateAfterToggle();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to turn on quiet mode."),
  });

  const deactivateMutation = useMutation({
    mutationFn: () => instanceSettingsApi.deactivateQuietMode(),
    onSuccess: async () => {
      setError(null);
      await invalidateAfterToggle();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to turn off quiet mode."),
  });

  const status = statusQuery.data;
  const isStale = Boolean(
    status?.active && status.activatedAt && Date.now() - new Date(status.activatedAt).getTime() > QUIET_MODE_STALE_AFTER_MS,
  );
  const pending = activateMutation.isPending || deactivateMutation.isPending;

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Moon className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Quiet mode</h2>
              <p className="text-sm text-muted-foreground">
                Stops every agent in every company from starting new work -- both scheduled timer wakes and
                event-driven wakes. Work already running is left alone to finish; this is not Pause, which cancels
                active runs. Turning it back off restores exactly the agents that were active before, not more.
              </p>
            </div>
          </div>
          {!statusQuery.isLoading && status && (
            <Button
              variant={status.active ? "default" : "secondary"}
              size="sm"
              className="shrink-0"
              disabled={pending || statusQuery.isLoading}
              onClick={() => {
                if (status.active) {
                  deactivateMutation.mutate();
                  return;
                }
                if (!window.confirm("Turn on quiet mode? No new work will start in any company until you turn it back off.")) {
                  return;
                }
                activateMutation.mutate();
              }}
            >
              {pending ? "..." : status.active ? "Turn off" : "Turn on"}
            </Button>
          )}
        </div>

        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading quiet mode status...</p>
        ) : status ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {status.active ? (
              status.activeRunCount > 0 ? (
                <Badge variant="outline">Winding down -- {status.activeRunCount} {status.activeRunCount === 1 ? "run" : "runs"} finishing</Badge>
              ) : (
                <Badge variant="outline">Quiet -- nothing is running</Badge>
              )
            ) : (
              <Badge variant="outline">Off -- agents run normally</Badge>
            )}
            {status.active && status.activatedAt && (
              <span className="text-muted-foreground" title={formatDateTime(status.activatedAt)}>
                on since {relativeTime(status.activatedAt)}
              </span>
            )}
          </div>
        ) : null}

        {isStale && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Quiet mode has been on for more than a day. If this wasn't intentional, turn it back off so agents can
              pick up work they're sitting on.
            </span>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function buildAgentHref(agent: InstanceSchedulerHeartbeatAgent) {
  return `/${agent.companyIssuePrefix}/agents/${encodeURIComponent(agent.agentUrlKey)}`;
}

export function InstanceSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Heartbeats" },
    ]);
  }, [setBreadcrumbs]);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instance.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
  });

  const toggleMutation = useMutation({
    mutationFn: async (agentRow: InstanceSchedulerHeartbeatAgent) => {
      const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
      const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
      const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

      return agentsApi.update(
        agentRow.id,
        {
          runtimeConfig: {
            ...runtimeConfig,
            heartbeat: {
              ...heartbeat,
              enabled: !agentRow.heartbeatEnabled,
            },
          },
        },
        agentRow.companyId,
      );
    },
    onSuccess: async (_, agentRow) => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agentRow.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update heartbeat.");
    },
  });

  const disableAllMutation = useMutation({
    mutationFn: async (agentRows: InstanceSchedulerHeartbeatAgent[]) => {
      const enabled = agentRows.filter((a) => a.heartbeatEnabled);
      if (enabled.length === 0) return enabled;

      const results = await Promise.allSettled(
        enabled.map(async (agentRow) => {
          const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
          const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
          const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};
          await agentsApi.update(
            agentRow.id,
            {
              runtimeConfig: {
                ...runtimeConfig,
                heartbeat: { ...heartbeat, enabled: false },
              },
            },
            agentRow.companyId,
          );
        }),
      );

      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        const firstError = failures[0]?.reason;
        const detail = firstError instanceof Error ? firstError.message : "Unknown error";
        throw new Error(
          failures.length === 1
            ? `Failed to disable 1 timer heartbeat: ${detail}`
            : `Failed to disable ${failures.length} of ${enabled.length} timer heartbeats. First error: ${detail}`,
        );
      }
      return enabled;
    },
    onSuccess: async (updatedRows) => {
      setActionError(null);
      const companies = new Set(updatedRows.map((row) => row.companyId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        ...Array.from(companies, (companyId) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        ),
        ...updatedRows.map((row) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(row.id) }),
        ),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to disable all heartbeats.");
    },
  });

  const agents = heartbeatsQuery.data ?? [];
  const activeCount = agents.filter((agent) => agent.schedulerActive).length;
  const disabledCount = agents.length - activeCount;
  const enabledCount = agents.filter((agent) => agent.heartbeatEnabled).length;
  const anyEnabled = enabledCount > 0;

  const grouped = useMemo(() => {
    const map = new Map<string, { companyName: string; agents: InstanceSchedulerHeartbeatAgent[] }>();
    for (const agent of agents) {
      let group = map.get(agent.companyId);
      if (!group) {
        group = { companyName: agent.companyName, agents: [] };
        map.set(agent.companyId, group);
      }
      group.agents.push(agent);
    }
    return [...map.values()];
  }, [agents]);

  if (heartbeatsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading scheduler heartbeats...</div>;
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : "Failed to load scheduler heartbeats."}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Scheduler Heartbeats</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Agents with a timer heartbeat enabled across all of your companies.
        </p>
      </div>

      <QuietModeCard />

      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground">{activeCount}</span> active</span>
        <span><span className="font-semibold text-foreground">{disabledCount}</span> disabled</span>
        <span><span className="font-semibold text-foreground">{grouped.length}</span> {grouped.length === 1 ? "company" : "companies"}</span>
        {anyEnabled && (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto h-7 text-xs"
            disabled={disableAllMutation.isPending}
            onClick={() => {
              const noun = enabledCount === 1 ? "agent" : "agents";
              if (!window.confirm(`Disable timer heartbeats for all ${enabledCount} enabled ${noun}?`)) {
                return;
              }
              disableAllMutation.mutate(agents);
            }}
          >
            {disableAllMutation.isPending ? "Disabling..." : "Disable All"}
          </Button>
        )}
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message="No scheduler heartbeats match the current criteria."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <Card key={group.companyName}>
              <CardContent className="p-0">
                <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.companyName}
                </div>
                <div className="divide-y">
                  {group.agents.map((agent) => {
                    const saving = toggleMutation.isPending && toggleMutation.variables?.id === agent.id;
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-3 px-3 py-2 text-sm"
                      >
                        <Badge
                          variant={agent.schedulerActive ? "default" : "outline"}
                          className="shrink-0 text-[10px] px-1.5 py-0"
                        >
                          {agent.schedulerActive ? "On" : "Off"}
                        </Badge>
                        <Link
                          to={buildAgentHref(agent)}
                          className="font-medium truncate hover:underline"
                        >
                          {agent.agentName}
                        </Link>
                        <span className="hidden sm:inline text-muted-foreground truncate">
                          {humanize(agent.title ?? agent.role)}
                        </span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {agent.intervalSec}s
                        </span>
                        <span
                          className="hidden md:inline text-muted-foreground truncate"
                          title={agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : undefined}
                        >
                          {agent.lastHeartbeatAt
                            ? relativeTime(agent.lastHeartbeatAt)
                            : "never"}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5 shrink-0">
                          <Link
                            to={buildAgentHref(agent)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Full agent config"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={saving}
                            onClick={() => toggleMutation.mutate(agent)}
                          >
                            {saving ? "..." : agent.heartbeatEnabled ? "Disable Timer Heartbeat" : "Enable Timer Heartbeat"}
                          </Button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
