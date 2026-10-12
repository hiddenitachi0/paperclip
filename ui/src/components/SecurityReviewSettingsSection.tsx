import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatAgentDisplayName } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { securityReviewSettingsApi } from "../api/securityReviewSettings";
import { queryKeys } from "../lib/queryKeys";

/**
 * DUR-4566 item 5: which agent is "the company's security reviewer" -- the
 * only agent (alongside a board user) who may record a merge-card
 * security-review verdict. The "Request security review" button on a merge
 * card explains that one has to be chosen here first when this is unset.
 */
export function SecurityReviewSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const key = queryKeys.companies.securityReviewSettings(companyId);
  const { data: settings, error } = useQuery({
    queryKey: key,
    queryFn: () => securityReviewSettingsApi.get(companyId),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const mutation = useMutation({
    mutationFn: (securityReviewerAgentId: string | null) =>
      securityReviewSettingsApi.setReviewerAgentId(companyId, securityReviewerAgentId),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });

  return (
    <div className="space-y-4" data-testid="company-settings-security-review-section">
      <div className="section-title">Who reviews merge cards for security</div>
      <div className="space-y-3 rounded-md section-box px-4 py-4">
        <p className="text-sm text-muted-foreground">
          Merge cards need a passed security review before they can be approved normally. Pick the agent who
          does that review for this company.
        </p>
        {error && (
          <p className="text-xs text-destructive">
            Couldn't load this setting. {error instanceof Error ? error.message : ""}
          </p>
        )}
        <select
          className="w-full max-w-sm rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={settings?.securityReviewerAgentId ?? ""}
          onChange={(e) => mutation.mutate(e.target.value || null)}
          disabled={!settings || !agents}
          data-testid="security-reviewer-agent-select"
        >
          <option value="">No one chosen yet</option>
          {(agents ?? []).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {formatAgentDisplayName(agent, agent.persona)}
            </option>
          ))}
        </select>
        {!settings?.securityReviewerAgentId && (
          <p className="text-xs text-muted-foreground">
            Until one is chosen, "Request security review" on a merge card will explain that this needs to be
            set first.
          </p>
        )}
      </div>
    </div>
  );
}
