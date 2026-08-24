import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Wrench, ShieldCheck, X } from "lucide-react";
import { jobsApi, type RightGrant } from "../../api/jobs";
import { ApiError } from "../../api/client";
import { useToastActions } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JobPicker } from "./JobPicker";
import { JobToolsPicker } from "./JobToolsPicker";
import { JobRightsPicker } from "./JobRightsPicker";
import { permissionLabel } from "../../lib/permission-labels";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/**
 * Shows an agent's job assignment plus, for tools and rights, which entries
 * came from the job vs. which were added/removed specifically on this agent.
 * DUR-115 hard rule: assignment is board-only. This section doesn't try to
 * detect the acting principal client-side — it just calls the endpoint and
 * surfaces the 403 the backend is required to return for agent callers.
 */
export function AgentJobSection({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [pickingJob, setPickingJob] = useState(false);
  const [addingToolOverride, setAddingToolOverride] = useState(false);
  const [addingRightOverride, setAddingRightOverride] = useState(false);

  const roleStateKey = ["agents", "role-state", agentId] as const;
  const jobsListKey = ["jobs", companyId ?? "__none__"] as const;

  const { data: roleState, isLoading, error } = useQuery({
    queryKey: roleStateKey,
    queryFn: () => jobsApi.getAgentRoleState(agentId),
  });

  const { data: jobs } = useQuery({
    queryKey: jobsListKey,
    queryFn: () => jobsApi.list(companyId!),
    enabled: Boolean(companyId) && pickingJob,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: roleStateKey });

  const assignJob = useMutation({
    mutationFn: (jobId: string) => jobsApi.assignToAgent(agentId, jobId),
    onSuccess: () => {
      invalidate();
      setPickingJob(false);
      pushToast({ title: "Job assigned", tone: "success" });
    },
    onError: (error) => {
      const status = error instanceof ApiError ? error.status : null;
      pushToast({
        title: status === 403 ? "Only a person on the company's board can assign a job" : "Could not assign job",
        body: status === 403 ? "Ask an operator to assign this from the board." : errorMessage(error, ""),
        tone: "error",
      });
    },
  });

  const addTool = useMutation({
    mutationFn: (tool: { name: string; command?: string; url?: string }) =>
      jobsApi.addAgentToolOverride(agentId, tool),
    onSuccess: () => {
      invalidate();
      setAddingToolOverride(false);
    },
    onError: (error) => pushToast({ title: "Could not add tool", body: errorMessage(error, ""), tone: "error" }),
  });

  const removeTool = useMutation({
    mutationFn: (toolName: string) => jobsApi.removeAgentToolOverride(agentId, toolName),
    onSuccess: invalidate,
    onError: (error) => pushToast({ title: "Could not remove tool", body: errorMessage(error, ""), tone: "error" }),
  });

  const addRight = useMutation({
    mutationFn: (grant: RightGrant) => jobsApi.addAgentRightOverride(agentId, grant),
    onSuccess: () => {
      invalidate();
      setAddingRightOverride(false);
    },
    onError: (error) => pushToast({ title: "Could not add right", body: errorMessage(error, ""), tone: "error" }),
  });

  const removeRight = useMutation({
    mutationFn: (permissionKey: RightGrant["permissionKey"]) => jobsApi.removeAgentRightOverride(agentId, permissionKey),
    onSuccess: invalidate,
    onError: (error) => pushToast({ title: "Could not remove right", body: errorMessage(error, ""), tone: "error" }),
  });

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading job…</p>;
  }
  // Guard against a partial/unexpected response shape (not just a missing one)
  // so a backend contract drift renders the empty state instead of throwing.
  if (error || !roleState || !roleState.tools || !roleState.rights) {
    return <p className="text-xs text-muted-foreground">Could not load this agent's job. Try again once the jobs feature is live.</p>;
  }

  const tools = {
    fromJob: roleState.tools.fromJob ?? [],
    added: roleState.tools.added ?? [],
    removed: roleState.tools.removed ?? [],
  };
  const rights = {
    fromJob: roleState.rights.fromJob ?? [],
    added: roleState.rights.added ?? [],
    removed: roleState.rights.removed ?? [],
  };

  const currentToolNames = new Set([...tools.fromJob, ...tools.added]);
  const currentRightKeys = new Set([
    ...rights.fromJob.map((g) => g.permissionKey),
    ...rights.added.map((g) => g.permissionKey),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Job</h3>
        {!pickingJob ? (
          <Button size="sm" variant="outline" onClick={() => setPickingJob(true)}>
            {roleState.job ? "Change job" : "Assign a job"}
          </Button>
        ) : null}
      </div>

      <div className="mt-2 border border-border rounded-lg p-4 space-y-4">
        {pickingJob ? (
          <div className="space-y-2">
            <JobPicker
              jobs={jobs ?? []}
              value={roleState.job?.id ?? null}
              onChange={(jobId) => jobId && assignJob.mutate(jobId)}
              disabled={assignJob.isPending}
              placeholder="Choose a job"
            />
            <p className="text-xs text-muted-foreground">
              This copies the job's instructions, tools, and rights onto this agent once. It won't stay linked — later
              changes to the job won't reach this agent.
            </p>
            <Button size="sm" variant="ghost" onClick={() => setPickingJob(false)} disabled={assignJob.isPending}>
              Cancel
            </Button>
          </div>
        ) : roleState.job ? (
          <div className="flex items-start gap-2 text-sm">
            <Briefcase className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <div className="font-medium">{roleState.job.name}</div>
              {roleState.job.description ? (
                <p className="text-xs text-muted-foreground">{roleState.job.description}</p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No job assigned.</p>
        )}

        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Wrench className="h-3.5 w-3.5" />
            Tools
          </div>
          <ul className="mt-1.5 space-y-1">
            {tools.fromJob.map((name) => (
              <OverrideRow key={`from-job-${name}`} label={name} tag="From job" />
            ))}
            {tools.added.map((name) => (
              <OverrideRow
                key={`added-${name}`}
                label={name}
                tag="Added"
                onRemove={() => removeTool.mutate(name)}
                removing={removeTool.isPending}
              />
            ))}
            {tools.removed.map((name) => (
              <OverrideRow key={`removed-${name}`} label={name} tag="Removed" muted />
            ))}
            {currentToolNames.size === 0 && tools.removed.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tools.</p>
            ) : null}
          </ul>
          {addingToolOverride ? (
            <div className="mt-2">
              <JobToolsPicker
                value={[]}
                onChange={(next) => {
                  const tool = next[0];
                  if (tool) addTool.mutate(tool);
                }}
                disabled={addTool.isPending}
              />
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setAddingToolOverride(true)}>
              Add a tool
            </Button>
          )}
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Rights
          </div>
          <ul className="mt-1.5 space-y-1">
            {rights.fromJob.map((grant) => (
              <OverrideRow key={`from-job-${grant.permissionKey}`} label={permissionLabel(grant.permissionKey)} tag="From job" />
            ))}
            {rights.added.map((grant) => (
              <OverrideRow
                key={`added-${grant.permissionKey}`}
                label={permissionLabel(grant.permissionKey)}
                tag="Added"
                onRemove={() => removeRight.mutate(grant.permissionKey)}
                removing={removeRight.isPending}
              />
            ))}
            {rights.removed.map((grant) => (
              <OverrideRow key={`removed-${grant.permissionKey}`} label={permissionLabel(grant.permissionKey)} tag="Removed" muted />
            ))}
            {currentRightKeys.size === 0 && rights.removed.length === 0 ? (
              <p className="text-xs text-muted-foreground">No rights.</p>
            ) : null}
          </ul>
          {addingRightOverride ? (
            <div className="mt-2 space-y-2">
              <JobRightsPicker
                value={[]}
                onChange={(next) => {
                  const grant = next[0];
                  if (grant) addRight.mutate(grant);
                }}
                disabled={addRight.isPending}
              />
              <Button size="sm" variant="ghost" onClick={() => setAddingRightOverride(false)}>
                Done
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setAddingRightOverride(true)}>
              Add a right
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function OverrideRow({
  label,
  tag,
  onRemove,
  removing,
  muted,
}: {
  label: string;
  tag: "From job" | "Added" | "Removed";
  onRemove?: () => void;
  removing?: boolean;
  muted?: boolean;
}) {
  return (
    <li className={`flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1 text-sm ${muted ? "opacity-60" : ""}`}>
      <span className="truncate">{label}</span>
      <span className="flex items-center gap-1.5 shrink-0">
        <Badge variant={tag === "From job" ? "outline" : tag === "Added" ? "secondary" : "outline"}>{tag}</Badge>
        {onRemove ? (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            onClick={onRemove}
            disabled={removing}
            aria-label={`Remove ${label}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </span>
    </li>
  );
}
