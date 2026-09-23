import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { environmentsApi } from "../api/environments";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { AgentStatusBadge, AgentStatusCapsule } from "../components/StatusBadge";
import { AgentActionButtons, AgentActionMenuItem } from "../components/AgentActionButtons";
import { AgentAvatar } from "../components/AgentAvatar";
import { MembershipAction } from "../components/MembershipAction";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Bot, Plus, List, GitBranch, LogIn, LogOut, Pencil, X } from "lucide-react";
import { BulkAgentEditDialog } from "../components/BulkAgentEditDialog";
import {
  AGENT_ROLE_LABELS,
  formatAgentDisplayName,
  type Agent,
  type Environment,
  type EnvironmentCapabilities,
} from "@paperclipai/shared";
import {
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type FilterTab = "all" | "active" | "paused" | "error";

interface EnvironmentDescriptor {
  label: string;
  detail: string;
  title: string;
}

const localEnvironmentDescriptor: EnvironmentDescriptor = {
  label: "Local",
  detail: "Paperclip host",
  title: "Local - Paperclip host",
};

const loadingEnvironmentDescriptor: EnvironmentDescriptor = {
  label: "—",
  detail: "Loading environment",
  title: "Loading environment",
};

// Agents in these states never appear in the agents list — `terminated` is
// hidden like an archived company, and `pending_approval` is a hiring gate that
// lives in the task thread, not an agent run state (PAP-75).
const HIDDEN_AGENT_STATUSES = new Set(["terminated", "pending_approval"]);

function matchesFilter(status: string, tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab): Agent[] {
  return agents
    .filter((a) => !HIDDEN_AGENT_STATUSES.has(a.status) && matchesFilter(a.status, tab))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getConfiguredModel(agent: Agent): string | null {
  const value = agent.adapterConfig?.model;
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length > 0 ? model : null;
}

function formatEnvironmentDriver(driver: Environment["driver"]): string {
  if (driver === "ssh") return "SSH";
  return driver.charAt(0).toUpperCase() + driver.slice(1);
}

function getSandboxProviderLabel(
  environment: Environment,
  capabilities?: EnvironmentCapabilities | null,
): string {
  const provider = typeof environment.config.provider === "string"
    ? environment.config.provider.trim()
    : "";
  if (!provider) return "Sandbox";
  return capabilities?.sandboxProviders?.[provider]?.displayName ?? provider;
}

function describeEnvironment(
  environment: Environment,
  capabilities?: EnvironmentCapabilities | null,
): EnvironmentDescriptor {
  const detail = environment.driver === "sandbox"
    ? `${getSandboxProviderLabel(environment, capabilities)} sandbox provider`
    : environment.driver === "local"
      ? "Paperclip host"
      : formatEnvironmentDriver(environment.driver);

  return {
    label: environment.name,
    detail,
    title: `${environment.name} - ${detail}`,
  };
}

function describeMissingEnvironment(environmentId: string): EnvironmentDescriptor {
  return {
    label: "Unknown environment",
    detail: environmentId.slice(0, 8),
    title: `Unknown environment - ${environmentId}`,
  };
}

function resolveAgentEnvironment(
  agent: Agent,
  environmentsById: Map<string, Environment>,
  instanceDefaultEnvironmentId: string | null,
  capabilities?: EnvironmentCapabilities | null,
): EnvironmentDescriptor {
  const environmentId = agent.defaultEnvironmentId ?? instanceDefaultEnvironmentId;
  if (!environmentId) return localEnvironmentDescriptor;
  const environment = environmentsById.get(environmentId);
  return environment
    ? describeEnvironment(environment, capabilities)
    : describeMissingEnvironment(environmentId);
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab);
      // Hidden agents (terminated / pending_approval) never render as a row, but
      // any visible reports are promoted so the tree doesn't lose live agents.
      if (HIDDEN_AGENT_STATUSES.has(node.status)) {
        acc.push(...filteredReports);
        return acc;
      }
      if (matchesFilter(node.status, tab) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const { data: instanceSettings } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: !!selectedCompanyId,
  });
  const environmentsEnabled = instanceSettings?.experimental.enableEnvironments === true;

  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(selectedCompanyId!),
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const { data: environmentCapabilities } = useQuery({
    queryKey: queryKeys.environments.capabilities(selectedCompanyId!),
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const environmentsById = useMemo(() => {
    const map = new Map<string, Environment>();
    for (const environment of environments ?? []) map.set(environment.id, environment);
    return map;
  }, [environments]);

  const environmentByAgentId = useMemo(() => {
    const map = new Map<string, EnvironmentDescriptor>();
    for (const agent of agents ?? []) {
      map.set(
        agent.id,
        resolveAgentEnvironment(
          agent,
          environmentsById,
          instanceSettings?.defaultEnvironmentId ?? null,
          environmentCapabilities,
        ),
      );
    }
    return map;
  }, [agents, environmentsById, environmentCapabilities, instanceSettings?.defaultEnvironmentId]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab);
  const environmentDataLoading = environmentsEnabled && environments === undefined;
  const showEnvironmentColumn = environmentsEnabled && (environments === undefined || environments.length > 1);
  const resolveRenderedEnvironment = (agentId: string) => (
    environmentDataLoading
      ? loadingEnvironmentDescriptor
      : environmentByAgentId.get(agentId) ?? localEnvironmentDescriptor
  );

  const toggleSelected = (agentId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };
  const selectedAgents = (agents ?? []).filter((a) => selectedIds.has(a.id));
  const clearSelection = () => setSelectedIds(new Set());

  const renderAgentRow = (agent: Agent) => {
    const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
    const membershipPending =
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "agent" &&
      membershipMutation.variables.resourceId === agent.id;
    if (isMobile) {
      return (
        <NarrowAgentRow
          key={agent.id}
          agent={agent}
          tab={tab}
          companyId={selectedCompanyId}
          selected={selectedIds.has(agent.id)}
          onToggleSelected={() => toggleSelected(agent.id)}
          liveRun={liveRunByAgent.get(agent.id)}
          membershipState={resourceMembershipState(membershipsQuery.data, "agent", agent.id)}
          membershipPending={membershipPending}
          membershipPendingState={membershipPending ? membershipMutation.variables?.state ?? null : null}
          onJoin={() => membershipMutation.mutate({
            resourceType: "agent",
            resourceId: agent.id,
            resourceName: agent.name,
            state: "joined",
          })}
          onLeave={() => membershipMutation.mutate({
            resourceType: "agent",
            resourceId: agent.id,
            resourceName: agent.name,
            state: "left",
          })}
        />
      );
    }
    return (
      <EntityRow
        key={agent.id}
        // DUR-4000: "Sales agent 1 (Maja)" -- the job name with the person in brackets.
        title={formatAgentDisplayName(agent, agent.persona)}
        // Fixed (truncating) title width so the `meta` group starts at a
        // constant x on every row — that's what makes the model + timestamp
        // columns line up vertically. Agent names vary in width, so
        // a content-sized title (`min-w-[7rem]`) shifted meta's start per row.
        titleClassName="w-56"
        subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
        to={agentUrl(agent)}
        className={cn(
          "group",
          agent.pausedAt && tab !== "paused" ? "opacity-50" : "",
          resourceMembershipState(membershipsQuery.data, "agent", agent.id) === "left" ? "text-foreground/55" : "",
        )}
        leading={
          <div className="flex items-center gap-2">
            {/* Stop propagation so checking the box doesn't also navigate via the row's Link. */}
            <div
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <Checkbox
                checked={selectedIds.has(agent.id)}
                onCheckedChange={() => toggleSelected(agent.id)}
                aria-label={`Select ${agent.name}`}
              />
            </div>
            {hasInvalidOrgChain ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Invalid reporting chain" />
            ) : (
              <AgentStatusCapsule status={agent.status} />
            )}
          </div>
        }
        meta={
          <div className="hidden xl:flex items-center gap-3">
            <AgentMetaColumns
              agent={agent}
              environment={resolveRenderedEnvironment(agent.id)}
              showEnvironment={showEnvironmentColumn}
            />
          </div>
        }
        trailing={
          <div className="flex items-center gap-3">
            <span className="sm:hidden">
              {liveRunByAgent.has(agent.id) ? (
                <LiveRunIndicator
                  agentRef={agentRouteRef(agent)}
                  runId={liveRunByAgent.get(agent.id)!.runId}
                  liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                />
              ) : (
                <AgentStatusBadge status={agent.status} />
              )}
            </span>
            <div className="hidden sm:flex items-center gap-3">
              {liveRunByAgent.has(agent.id) && (
                <LiveRunIndicator
                  agentRef={agentRouteRef(agent)}
                  runId={liveRunByAgent.get(agent.id)!.runId}
                  liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                />
              )}
              <span className="w-20 flex justify-end">
                <AgentStatusBadge status={agent.status} />
              </span>
            </div>
            {/* Row actions mirror the agent detail page; stop the click
                from bubbling to the row link so buttons don't navigate. */}
            <div
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <AgentActionButtons
                agent={agent}
                companyId={selectedCompanyId}
                runLabel="Run Heartbeat"
                showStatus={false}
              />
            </div>
            <MembershipAction
              state={resourceMembershipState(membershipsQuery.data, "agent", agent.id)}
              pending={
                membershipMutation.isPending &&
                membershipMutation.variables?.resourceType === "agent" &&
                membershipMutation.variables.resourceId === agent.id
              }
              pendingState={
                membershipMutation.isPending &&
                membershipMutation.variables?.resourceType === "agent" &&
                membershipMutation.variables.resourceId === agent.id
                  ? membershipMutation.variables.state
                  : null
              }
              resourceName={agent.name}
              onJoin={() => membershipMutation.mutate({
                resourceType: "agent",
                resourceId: agent.id,
                resourceName: agent.name,
                state: "joined",
              })}
              onLeave={() => membershipMutation.mutate({
                resourceType: "agent",
                resourceId: agent.id,
                resourceName: agent.name,
                state: "left",
              })}
            />
          </div>
        }
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      {effectiveView === "list" && selectedAgents.length > 0 && (
        <div className="flex items-center justify-between gap-3 border border-border bg-accent/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {selectedAgents.length} agent{selectedAgents.length === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setBulkEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Bulk edit
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              <X className="h-3.5 w-3.5 mr-1.5" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map(renderAgentRow)}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected status.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              environmentByAgentId={environmentByAgentId}
              environmentDataLoading={environmentDataLoading}
              showEnvironment={showEnvironmentColumn}
              tab={tab}
              memberships={membershipsQuery.data}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected status.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}

      <BulkAgentEditDialog
        open={bulkEditOpen}
        onOpenChange={(next) => {
          setBulkEditOpen(next);
          if (!next) clearSelection();
        }}
        companyId={selectedCompanyId}
        agentIds={selectedAgents.map((a) => a.id)}
      />
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  environmentByAgentId,
  environmentDataLoading,
  showEnvironment,
  tab,
  memberships,
  membershipMutation,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  environmentByAgentId: Map<string, EnvironmentDescriptor>;
  environmentDataLoading: boolean;
  showEnvironment: boolean;
  tab: FilterTab;
  memberships: ReturnType<typeof useResourceMemberships>["data"];
  membershipMutation: ReturnType<typeof useResourceMembershipMutation>;
}) {
  const agent = agentMap.get(node.id);
  const hasInvalidOrgChain = Boolean(agent && agent.orgChainHealth?.status === "invalid_org_chain");
  const membershipState = resourceMembershipState(memberships, "agent", node.id);
  const pending = membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "agent" &&
    membershipMutation.variables.resourceId === node.id;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className={cn(
          "group flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit",
          agent?.pausedAt && tab !== "paused" && "opacity-50",
          membershipState === "left" && "text-foreground/55",
        )}
      >
        {hasInvalidOrgChain ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Invalid reporting chain" />
        ) : (
          <AgentStatusCapsule status={node.status} />
        )}
        <div className="flex-1 min-w-[7rem]">
          <span className="text-sm font-medium">{formatAgentDisplayName(node, agent?.persona)}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {roleLabels[node.role] ?? node.role}
            {agent?.title ? ` - ${agent.title}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            ) : (
              <AgentStatusBadge status={node.status} />
            )}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {agent && (
              <div className="hidden xl:flex items-center gap-3">
                <AgentMetaColumns
                  agent={agent}
                  environment={
                    environmentDataLoading
                      ? loadingEnvironmentDescriptor
                      : environmentByAgentId.get(agent.id) ?? localEnvironmentDescriptor
                  }
                  showEnvironment={showEnvironment}
                />
              </div>
            )}
            <span className="w-20 flex justify-end">
              <AgentStatusBadge status={node.status} />
            </span>
          </div>
          <MembershipAction
            state={membershipState}
            pending={pending}
            pendingState={pending ? membershipMutation.variables?.state : null}
            resourceName={node.name}
            onJoin={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: node.id,
              resourceName: node.name,
              state: "joined",
            })}
            onLeave={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: node.id,
              resourceName: node.name,
              state: "left",
            })}
          />
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              environmentByAgentId={environmentByAgentId}
              environmentDataLoading={environmentDataLoading}
              showEnvironment={showEnvironment}
              tab={tab}
              memberships={memberships}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * DUR-4001: the list row on a phone. The desktop row (EntityRow with a fixed
 * 14rem title, meta columns and five inline buttons) has no room at 360px:
 * the name cell shrank to nothing and every row was six identical buttons
 * with no name, no title and no avatar. Here the name owns the width, the
 * status pill stays, and every action lives in the one "..." menu. The row
 * links to the agent page; the checkbox and the menu sit outside that link.
 */
function NarrowAgentRow({
  agent,
  tab,
  companyId,
  selected,
  onToggleSelected,
  liveRun,
  membershipState,
  membershipPending,
  membershipPendingState,
  onJoin,
  onLeave,
}: {
  agent: Agent;
  tab: FilterTab;
  companyId: string;
  selected: boolean;
  onToggleSelected: () => void;
  liveRun: { runId: string; liveCount: number } | undefined;
  membershipState: ReturnType<typeof resourceMembershipState>;
  membershipPending: boolean;
  membershipPendingState: ReturnType<typeof resourceMembershipState> | null;
  onJoin: () => void;
  onLeave: () => void;
}) {
  const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
  // "Sales agent 1 (Maja)": the job name with the person in brackets (DUR-4000).
  const displayName = formatAgentDisplayName(agent, agent.persona);
  const subtitle = `${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`;
  const isLeft = membershipState === "left";
  const membershipLabel = membershipPending
    ? membershipPendingState === "left" ? "Leaving..." : "Joining..."
    : isLeft ? "Join" : "Leave";

  return (
    <div
      data-testid="agent-row-narrow"
      className={cn(
        "flex items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0",
        agent.pausedAt && tab !== "paused" ? "opacity-50" : "",
        isLeft ? "text-foreground/55" : "",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggleSelected}
        aria-label={`Select ${agent.name}`}
        className="shrink-0"
      />
      <Link
        to={agentUrl(agent)}
        className="flex min-w-0 flex-1 items-center gap-2.5 no-underline text-inherit"
        title={displayName}
      >
        <AgentAvatar agent={agent} size="sm" className="shrink-0" iconClassName="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {hasInvalidOrgChain ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Invalid reporting chain" />
            ) : null}
            <span className="truncate text-sm font-medium">{displayName}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </span>
      </Link>
      {liveRun ? (
        <LiveRunIndicator agentRef={agentRouteRef(agent)} runId={liveRun.runId} liveCount={liveRun.liveCount} />
      ) : (
        <AgentStatusBadge status={agent.status} />
      )}
      <AgentActionButtons
        variant="menu"
        agent={agent}
        companyId={companyId}
        runLabel="Run Heartbeat"
        showStatus={false}
        menuExtra={
          <AgentActionMenuItem
            icon={isLeft ? LogIn : LogOut}
            label={membershipLabel}
            busy={membershipPending}
            onClick={isLeft ? onJoin : onLeave}
          />
        }
      />
    </div>
  );
}

/**
 * Provider/model + heartbeat columns shared by the list and org views. The
 * model and adapter label share one fixed-width cell, each line truncating with
 * an ellipsis so a long model id can never overlap the heartbeat column. The
 * heartbeat is single-line (`whitespace-nowrap`) and wide enough for a full
 * date like "Apr 30, 2026".
 */
function AgentMetaColumns({
  agent,
  environment,
  showEnvironment,
}: {
  agent: Agent;
  environment: EnvironmentDescriptor;
  showEnvironment: boolean;
}) {
  const model = getConfiguredModel(agent);
  const adapterLabel = getAdapterLabel(agent.adapterType);
  return (
    <>
      <div className="w-44 min-w-0 leading-tight">
        <div
          className="truncate font-mono text-xs text-muted-foreground"
          title={model ?? undefined}
        >
          {model ?? "—"}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground/70" title={adapterLabel}>
          {adapterLabel}
        </div>
      </div>
      {showEnvironment && (
        <div className="w-44 min-w-0 leading-tight">
          <div className="truncate text-xs text-muted-foreground" title={environment.title}>
            {environment.label}
          </div>
          <div className="truncate text-[11px] text-muted-foreground/70">
            {environment.detail}
          </div>
        </div>
      )}
      <span className="w-24 whitespace-nowrap text-right text-xs text-muted-foreground">
        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
      </span>
    </>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
