import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  agentRequestRightsApi,
  type AgentRequestRightState,
  type AgentRequestRights,
  type AgentRequestRightsUpdate,
} from "../api/agentRequestRights";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { permissionDescription, permissionLabel } from "../lib/permission-labels";

/**
 * Agent settings > Permissions: may this agent ASK a person to put changes
 * live, or to merge finished code? Only the company's owner or an admin can
 * flip these; everyone else sees them read-only. A person still approves
 * every deploy and merge, whatever is set here.
 */
export function AgentRequestRightsSection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const queryKey = ["agents", "request-rights", agentId] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => agentRequestRightsApi.get(agentId),
  });

  const save = useMutation({
    mutationFn: (update: AgentRequestRightsUpdate) => agentRequestRightsApi.set(agentId, update),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next);
      // The Job/Rights list further down this page reads the same grants.
      void queryClient.invalidateQueries({ queryKey: ["agents", "role-state", agentId] });
    },
    onError: (err) =>
      pushToast({
        title: "Could not change this",
        body: err instanceof ApiError ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  if (isLoading) return <p className="text-xs text-muted-foreground">Loading what this agent may ask for…</p>;
  if (error || !data) return null;

  const disabled = !data.canChange || save.isPending;

  return (
    <div className="space-y-4" data-testid="agent-request-rights">
      <RequestRightRow
        testId="agent-request-rights-deploy"
        label={permissionLabel("deploys:request")}
        description={permissionDescription("deploys:request") ?? ""}
        state={data.deploysRequest}
        position={data.position}
        disabled={disabled}
        onChange={(next) => save.mutate({ deploysRequest: next })}
      />
      <RequestRightRow
        testId="agent-request-rights-merge"
        label={permissionLabel("merges:request")}
        description={permissionDescription("merges:request") ?? ""}
        state={data.mergesRequest}
        position={data.position}
        disabled={disabled}
        onChange={(next) => save.mutate({ mergesRequest: next })}
      />
      {!data.canChange ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-request-rights-readonly">
          Only the company's owner or an admin can change these two.
        </p>
      ) : null}
    </div>
  );
}

function sourceNote(state: AgentRequestRightState, position: AgentRequestRights["position"]): string | null {
  const name = position?.name ?? "its position";
  if (state.source === "position") {
    return `Comes with the position “${name}”. Switching it off here changes only this agent.`;
  }
  if (state.source === "turned_off") {
    return `The position “${name}” normally gives this, but it is switched off for this agent.`;
  }
  return null;
}

function RequestRightRow({
  testId,
  label,
  description,
  state,
  position,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  description: string;
  state: AgentRequestRightState;
  position: AgentRequestRights["position"];
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const note = sourceNote(state, position);
  return (
    <div className="flex items-center justify-between gap-4 text-sm" data-testid={testId}>
      <div className="space-y-1">
        <div>{label}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
      <ToggleSwitch
        checked={state.enabled}
        aria-label={label}
        onCheckedChange={(next) => onChange(next)}
        disabled={disabled}
      />
    </div>
  );
}
