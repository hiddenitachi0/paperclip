import { useEffect } from "react";
import { Link, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { personasApi } from "../api/personas";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "../components/PageSkeleton";
import { PersonaAvatar } from "../components/PersonaAvatar";
import { PersonaMcpToolsPanel } from "../components/PersonaMcpToolsPanel";
import { ApprovalCard } from "../components/ApprovalCard";

// DUR-184: item 15 (capability panel -- what image tools she has) and items
// 16-17 (plain-language approval UI for her image flows) on one page. Reuses
// the generic company-wide approvals list, filtered to requests her
// underlying agent filed, and the generic ApprovalCard -- there is no
// separate "persona approval" system, just approvals scoped to her agent.
export function PersonaDetail() {
  const { personaId } = useParams<{ personaId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const personaQuery = useQuery({
    queryKey: personaId ? queryKeys.personas.detail(personaId) : ["personas", "detail", "__none__"],
    queryFn: () => personasApi.get(personaId!),
    enabled: Boolean(personaId),
  });
  const persona = personaQuery.data;

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__none__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const agent = agentsQuery.data?.find((a) => a.id === persona?.agentId) ?? null;

  const approvalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId) : ["approvals", "__none__"],
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && Boolean(persona),
  });
  const personaApprovals = (approvalsQuery.data ?? [])
    .filter((approval) => approval.requestedByAgentId === persona?.agentId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const pendingApprovals = personaApprovals.filter(
    (approval) => approval.status === "pending" || approval.status === "revision_requested",
  );

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
      }
    },
  });
  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
      }
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Personas", href: "/personas" },
      { label: persona?.displayName ?? "Persona" },
    ]);
  }, [setBreadcrumbs, persona?.displayName]);

  if (personaQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (personaQuery.error || !persona) {
    return <p className="py-6 text-sm text-destructive">Could not load this persona.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex items-center gap-4">
        <PersonaAvatar persona={persona} size="lg" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{persona.displayName}</h1>
            {persona.status === "paused" ? <Badge variant="secondary">Paused</Badge> : null}
          </div>
          {persona.handle ? <p className="text-sm text-muted-foreground">@{persona.handle}</p> : null}
          {agent ? (
            <p className="text-xs text-muted-foreground">
              Runs on{" "}
              <Link to={`/agents/${agent.id}`} className="underline underline-offset-2">
                {agent.name}
              </Link>
            </p>
          ) : null}
        </div>
      </div>

      {persona.bio ? (
        <section className="space-y-1.5">
          <h2 className="text-sm font-semibold">Who she is</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{persona.bio}</p>
        </section>
      ) : null}

      {persona.voice ? (
        <section className="space-y-1.5">
          <h2 className="text-sm font-semibold">How she writes</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{persona.voice}</p>
        </section>
      ) : null}

      <section className="space-y-1.5">
        <h2 className="text-sm font-semibold">Picture tools</h2>
        <p className="text-sm text-muted-foreground">What she can use to make an image.</p>
        {agent ? <PersonaMcpToolsPanel agentId={agent.id} readOnly /> : null}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Before anything goes out</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Every picture she makes waits for your OK before it's used anywhere. Nothing she generates posts or
          publishes itself.
        </p>
        {approvalsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : pendingApprovals.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting on you right now.</p>
        ) : (
          <div className="space-y-3">
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                requesterAgent={agent}
                onApprove={() => approveMutation.mutate(approval.id)}
                onReject={() => rejectMutation.mutate(approval.id)}
                isPending={
                  (approveMutation.isPending || rejectMutation.isPending) &&
                  approveMutation.variables === approval.id
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <h2 className="text-sm font-semibold">Daily picture limit</h2>
        <p className="text-sm text-muted-foreground">
          {persona.dailyGenerationCap != null
            ? `Up to ${persona.dailyGenerationCap} picture${persona.dailyGenerationCap === 1 ? "" : "s"} a day.`
            : "No limit set -- she can make as many pictures as her tools allow."}
        </p>
      </section>
    </div>
  );
}
