import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  QUALITY_DONE_CHECK_MAX_ROUNDS,
  QUALITY_SELF_REVIEW_MAX_PASSES,
  formatAgentDisplayName,
  type UpdateCompanyQualityLoopSettings,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { modelDirectoryApi } from "../api/modelDirectory";
import { qualityLoopsApi } from "../api/qualityLoops";
import { queryKeys } from "../lib/queryKeys";
import { ToggleField } from "./agent-config-primitives";

const selectClass =
  "w-full max-w-sm rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

/**
 * Agent quality loops: checks that run when an agent says a task is finished, so work
 * is not closed as "done" when it is not. All off for companies that existed before
 * this setting; new companies start with the self-check on and the finish check off.
 */
export function QualityLoopSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const key = queryKeys.companies.qualityLoopSettings(companyId);
  const { data: settings, error } = useQuery({
    queryKey: key,
    queryFn: () => qualityLoopsApi.get(companyId),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: models } = useQuery({
    queryKey: queryKeys.companies.modelDirectory(companyId),
    queryFn: () => modelDirectoryApi.list(companyId),
  });

  const mutation = useMutation({
    mutationFn: (patch: UpdateCompanyQualityLoopSettings) => qualityLoopsApi.update(companyId, patch),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  const save = (patch: UpdateCompanyQualityLoopSettings) => mutation.mutate(patch);
  const disabled = !settings || mutation.isPending;

  return (
    <div className="space-y-4" data-testid="company-settings-quality-loops-section">
      <div className="section-title">Quality checks</div>
      <div className="space-y-5 rounded-md section-box px-4 py-4">
        <p className="text-sm text-muted-foreground">
          Checks that run when an agent says a task is finished, so work is not closed as "done" when part of it was never
          done. Each check is limited, so an agent can never loop forever, and every check is written on the task. You can
          change these per task too.
        </p>
        {error && (
          <p className="text-xs text-destructive">
            Couldn't load these settings. {error instanceof Error ? error.message : ""}
          </p>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">1. Self-check before finishing</div>
          <p className="text-xs text-muted-foreground">
            The first time an agent moves a task to review or done, it is sent back once to compare its work with what the
            task asked for, list what is missing, fix it, and then finish. Costs one extra agent run per check.
          </p>
          <select
            className={selectClass}
            value={settings?.selfReviewPasses ?? 0}
            onChange={(e) => save({ selfReviewPasses: Number(e.target.value) })}
            disabled={disabled}
            data-testid="quality-self-review-passes"
          >
            <option value={0}>Off</option>
            {Array.from({ length: QUALITY_SELF_REVIEW_MAX_PASSES }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "Once per task (suggested)" : `${n} times per task`}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">2. Independent finish check</div>
          <p className="text-xs text-muted-foreground">
            When an agent marks a task done, a cheap model reads what the task asked for next to the agent's final note and
            answers "done" or "not done, this is missing". If something is missing, the task goes back to the agent with the
            list. After the last round you get the question instead. Each check costs a little and is shown under Costs as
            "quality check".
          </p>
          <ToggleField
            label="Check tasks before they are marked done"
            checked={!!settings?.doneCheckEnabled}
            onChange={(v) => save({ doneCheckEnabled: v })}
            toggleTestId="quality-done-check-toggle"
          />
          <label className="block text-xs text-muted-foreground">Model that does the check</label>
          <select
            className={selectClass}
            value={settings?.doneCheckDirectoryEntryId ?? ""}
            onChange={(e) => save({ doneCheckDirectoryEntryId: e.target.value || null })}
            disabled={disabled || !models}
            data-testid="quality-done-check-model"
          >
            <option value="">Same as the helper's default model</option>
            {(models ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          {settings?.doneCheckEnabled && !settings.effectiveDoneCheckModel && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No model is set for this check yet, so tasks are not checked (each task says so). Pick a cheap model above, or
              set the helper's default model.
            </p>
          )}
          {settings?.effectiveDoneCheckModel && (
            <p className="text-xs text-muted-foreground">Checks use "{settings.effectiveDoneCheckModel.name}".</p>
          )}
          <label className="block text-xs text-muted-foreground">Rounds before you are asked</label>
          <select
            className={selectClass}
            value={settings?.doneCheckMaxRounds ?? 2}
            onChange={(e) => save({ doneCheckMaxRounds: Number(e.target.value) })}
            disabled={disabled}
            data-testid="quality-done-check-rounds"
          >
            {Array.from({ length: QUALITY_DONE_CHECK_MAX_ROUNDS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "1 round" : `${n} rounds`}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">3. Second agent reviews code tasks</div>
          <p className="text-xs text-muted-foreground">
            New tasks in a project with code get this agent as their reviewer: when the worker says it is finished, the
            reviewer looks at it and either approves or sends it back with changes. You can change or remove the reviewer on
            any task under "Reviewers".
          </p>
          <select
            className={selectClass}
            value={settings?.defaultReviewerAgentId ?? ""}
            onChange={(e) => save({ defaultReviewerAgentId: e.target.value || null })}
            disabled={disabled || !agents}
            data-testid="quality-default-reviewer"
          >
            <option value="">No reviewer</option>
            {(agents ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {formatAgentDisplayName(agent, agent.persona)}
              </option>
            ))}
          </select>
        </div>

        {mutation.error && (
          <p className="text-xs text-destructive">
            Couldn't save. {mutation.error instanceof Error ? mutation.error.message : ""}
          </p>
        )}
      </div>
    </div>
  );
}
