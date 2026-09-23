import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Pencil, ShieldCheck } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { personasApi } from "../api/personas";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "../components/PageSkeleton";
import { PersonaAvatar } from "../components/PersonaAvatar";
import { AgentAvatar } from "../components/AgentAvatar";
import { ApprovalCard } from "../components/ApprovalCard";
import { PersonaPublishingPanel } from "../components/PersonaPublishingPanel";
import {
  PersonaFormDialog,
  draftFromPersona,
  updateInputFromDraft,
  type PersonaDraft,
} from "../components/PersonaFormDialog";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** "Up to 3 pictures a day" / "No picture limit" -- the job's own enforced limit. */
function describePictureLimit(agent: Agent): string {
  const limit = agent.limits?.dailyImageGenerations;
  if (limit == null) return "No picture limit";
  return `Up to ${limit} picture${limit === 1 ? "" : "s"} a day`;
}

// DUR-184 items 15-17 / DUR-4000: one page per persona -- who they are, the
// jobs they hold, the approvals filed by any of those jobs, and publishing.
// Reuses the generic company-wide approvals list filtered to the attached
// agents and the generic ApprovalCard: there is no separate "persona
// approval" system. Picture tools stay agent-level (each job has its own
// Tools tab); the job rows link there.
export function PersonaDetail() {
  const { personaId } = useParams<{ personaId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [attachAgentId, setAttachAgentId] = useState("");

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
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);
  const attachedIds = useMemo(() => new Set(persona?.agentIds ?? []), [persona?.agentIds]);
  // One row per attached id. The company list never carries terminated
  // agents, so an id it cannot resolve is a terminated job (kept visible so
  // the operator can detach it); an agent that does come back as terminated
  // is badged the same way.
  const attachedJobs = useMemo(
    () =>
      (persona?.agentIds ?? []).map((id) => {
        const agent = agentById.get(id) ?? null;
        return { id, agent, terminated: agent === null || agent.status === "terminated" };
      }),
    [persona?.agentIds, agentById],
  );
  const liveJobCount = attachedJobs.filter((job) => !job.terminated).length;
  const attachableAgents = useMemo(
    () =>
      (agentsQuery.data ?? []).filter(
        (agent) => !attachedIds.has(agent.id) && agent.status !== "terminated" && !agent.personaId,
      ),
    [agentsQuery.data, attachedIds],
  );

  const approvalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId) : ["approvals", "__none__"],
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && Boolean(persona),
  });
  const personaApprovals = (approvalsQuery.data ?? [])
    .filter((approval) => approval.requestedByAgentId != null && attachedIds.has(approval.requestedByAgentId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const pendingApprovals = personaApprovals.filter(
    (approval) => approval.status === "pending" || approval.status === "revision_requested",
  );

  const invalidate = () => {
    if (personaId) queryClient.invalidateQueries({ queryKey: queryKeys.personas.detail(personaId) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.personas.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    }
  };

  const updatePersona = useMutation({
    mutationFn: (draft: PersonaDraft) => personasApi.update(persona!.id, updateInputFromDraft(draft)),
    onSuccess: () => {
      invalidate();
      setEditOpen(false);
      pushToast({ title: "Persona saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save persona", body: errorMessage(error, ""), tone: "error" }),
  });

  const attachMutation = useMutation({
    mutationFn: (agentId: string) => personasApi.attachToAgent(agentId, persona!.id),
    onSuccess: (_result, agentId) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      setAttachAgentId("");
      const agent = agentById.get(agentId);
      pushToast({
        title: "Job attached",
        body: agent ? `${persona!.displayName} now works as ${agent.name}.` : undefined,
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not attach the job", body: errorMessage(error, ""), tone: "error" }),
  });

  const detachMutation = useMutation({
    mutationFn: (agentId: string) => personasApi.attachToAgent(agentId, null),
    onSuccess: (_result, agentId) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      const agent = agentById.get(agentId);
      pushToast({
        title: "Job detached",
        body: agent ? `${agent.name} runs as a blank job again. Its instructions, tools and history are untouched.` : undefined,
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not detach the job", body: errorMessage(error, ""), tone: "error" }),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
      }
    },
  });
  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => approvalsApi.reject(id, note),
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

  const name = persona.displayName;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <PersonaAvatar persona={persona} size="lg" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold">{name}</h1>
              {persona.pronouns ? <span className="text-sm text-muted-foreground">{persona.pronouns}</span> : null}
              {persona.status === "paused" ? <Badge variant="secondary">Paused</Badge> : null}
            </div>
            {persona.handle ? <p className="text-sm text-muted-foreground">@{persona.handle}</p> : null}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
      </div>

      {persona.traits ? (
        <section className="space-y-1.5">
          <h2 className="text-sm font-semibold">Traits</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{persona.traits}</p>
        </section>
      ) : null}

      {persona.backstory ? (
        <section className="space-y-1.5">
          <h2 className="text-sm font-semibold">Who they are</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{persona.backstory}</p>
        </section>
      ) : null}

      {persona.voice ? (
        <section className="space-y-1.5">
          <h2 className="text-sm font-semibold">How they write</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{persona.voice}</p>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Jobs</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          The agents {name} works as. Each job keeps its own instructions, tools and limits; {name} brings the name,
          the backstory and the voice.
        </p>
        {agentsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : attachedJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No job yet. Attach one below and {name} starts working as it.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {liveJobCount === 0 ? (
              <li className="px-4 py-2 text-xs text-muted-foreground">
                No live job: every job {name} held has been terminated.
              </li>
            ) : null}
            {attachedJobs.map(({ id, agent, terminated }) => {
              const label = agent?.name ?? "Terminated job";
              return (
                <li
                  key={id}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${terminated ? "text-muted-foreground" : ""}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <AgentAvatar agent={agent} size="sm" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {agent ? (
                          <Link to={agentUrl(agent)} className="font-medium text-inherit no-underline hover:underline">
                            {agent.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{label}</span>
                        )}
                        {terminated ? <Badge variant="outline">Terminated</Badge> : null}
                        {agent?.laneAEnabled ? <Badge variant="outline">Quick agent</Badge> : null}
                        {agent?.status === "paused" ? <Badge variant="secondary">Paused</Badge> : null}
                      </div>
                      {agent ? (
                        <p className="text-xs text-muted-foreground">
                          {agent.title ?? roleLabels[agent.role] ?? agent.role} · {describePictureLimit(agent)} ·{" "}
                          <Link to={`${agentUrl(agent)}/tools`} className="underline underline-offset-2">
                            Tools
                          </Link>
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          This job no longer runs. Detach it to tidy up; nothing else changes.
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => detachMutation.mutate(id)}
                    disabled={detachMutation.isPending && detachMutation.variables === id}
                    aria-label={`Detach ${label}`}
                  >
                    Detach
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Attach a job"
            className="min-w-[14rem] flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none sm:flex-none"
            value={attachAgentId}
            onChange={(event) => setAttachAgentId(event.target.value)}
            disabled={agentsQuery.isLoading || attachMutation.isPending}
          >
            <option value="">
              {agentsQuery.isLoading
                ? "Loading agents…"
                : attachableAgents.length === 0
                  ? "No agents without a persona"
                  : "Pick an agent to attach"}
            </option>
            {attachableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.title ? ` - ${agent.title}` : ""}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => attachAgentId && attachMutation.mutate(attachAgentId)}
            disabled={!attachAgentId || attachMutation.isPending}
          >
            {attachMutation.isPending ? "Attaching…" : "Attach"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          An agent already working as another persona is not listed; change it from that agent's settings.
        </p>
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Before anything goes out</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Every picture {name} makes waits for your OK before it's used anywhere. Posts go out on their own only on
          accounts you set to that, after the first few posts there have had your OK, and never more than the daily
          limit you gave the account. Anything else waits here.
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
                requesterAgent={approval.requestedByAgentId ? agentById.get(approval.requestedByAgentId) ?? null : null}
                onApprove={() => approveMutation.mutate(approval.id)}
                onReject={(note) => rejectMutation.mutate({ id: approval.id, note })}
                isPending={
                  (approveMutation.isPending &&
                    approveMutation.variables === approval.id) ||
                  (rejectMutation.isPending &&
                    rejectMutation.variables?.id === approval.id)
                }
              />
            ))}
          </div>
        )}
      </section>

      <PersonaPublishingPanel persona={persona} />

      <PersonaFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initialDraft={draftFromPersona(persona)}
        title="Edit persona"
        isEditing
        onSubmit={(draft) => updatePersona.mutate(draft)}
        isPending={updatePersona.isPending}
      />
    </div>
  );
}
