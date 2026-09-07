import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy, DoneGateMode, DoneGateSettings } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_DONE_GATE_SETTINGS,
  MIN_DONE_GATE_MAX_ROUNDS,
  MAX_DONE_GATE_MAX_ROUNDS,
  DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS,
  MIN_GLOBAL_MAX_CONCURRENT_RUNS,
  MAX_GLOBAL_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_RUN_DURATION_MINUTES,
  MIN_MAX_RUN_DURATION_MINUTES,
  MAX_MAX_RUN_DURATION_MINUTES,
  DEFAULT_SILENT_RUN_TIMEOUT_MINUTES,
  MIN_SILENT_RUN_TIMEOUT_MINUTES,
  MAX_SILENT_RUN_TIMEOUT_MINUTES,
  DEFAULT_MAX_TURNS_PER_RUN,
  MIN_MAX_TURNS_PER_RUN,
  MAX_MAX_TURNS_PER_RUN,
  DEFAULT_SESSION_RESET_AFTER_RUNS,
  MIN_SESSION_RESET_AFTER_RUNS,
  MAX_SESSION_RESET_AFTER_RUNS,
  DEFAULT_SESSION_RESET_AFTER_HOURS,
  MIN_SESSION_RESET_AFTER_HOURS,
  MAX_SESSION_RESET_AFTER_HOURS,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

// DUR-3940 item 2 / run cap: one whole-number-of-minutes field with its own
// draft, so a half-typed value never saves. Shared by the two run time limits.
function MinutesLimitField(props: {
  label: string;
  saved: number;
  min: number;
  max: number;
  pending: boolean;
  onSave: (minutes: number) => void;
  unit?: string;
}) {
  const { label, saved, min, max, pending, onSave, unit = "minutes" } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(saved);
  const parsed = Number(value);
  const valid = /^\d+$/.test(value.trim()) && Number.isInteger(parsed) && parsed >= min && parsed <= max;
  const changed = valid && parsed !== saved;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed) return;
        onSave(parsed);
        setDraft(null);
      }}
    >
      <span className="w-full text-sm font-medium sm:w-56">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        disabled={pending}
        aria-label={label}
        aria-invalid={!valid}
        className="w-28"
      />
      <span className="text-sm text-muted-foreground">{unit}</span>
      <Button type="submit" size="sm" disabled={!changed || pending}>
        {pending ? "Saving..." : "Save"}
      </Button>
      {draft !== null && draft !== String(saved) ? (
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setDraft(null)}>
          Cancel
        </Button>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {valid ? `Currently ${saved}.` : `Enter a whole number from ${min} to ${max}.`}
      </span>
    </form>
  );
}

// DUR-3943 item 4: agents that carry their own "max turns per run" keep
// that number whatever the instance setting says (agents created before the
// instance setting existed all carry one). Show who still overrides and
// offer one click to put everyone on the instance setting.
function MaxTurnsAgentOverridesPanel(props: { instanceMaxTurns: number; onError: (message: string) => void }) {
  const { instanceMaxTurns, onError } = props;
  const queryClient = useQueryClient();
  const overridesQuery = useQuery({
    queryKey: queryKeys.instance.maxTurnsAgentOverrides,
    queryFn: () => instanceSettingsApi.listMaxTurnsAgentOverrides(),
    retry: false,
  });
  const clearMutation = useMutation({
    mutationFn: () => instanceSettingsApi.clearMaxTurnsAgentOverrides(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.maxTurnsAgentOverrides });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (error) => {
      onError(error instanceof Error ? error.message : "Could not update the agents.");
    },
  });
  const agents = overridesQuery.data?.agents ?? [];
  if (overridesQuery.isLoading) return null;
  if (agents.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="max-turns-overrides-none">
        Every agent follows this setting ({instanceMaxTurns} turns). An agent can still be given its own limit on its
        settings page.
      </p>
    );
  }
  const shown = agents.slice(0, 8);
  const rest = agents.length - shown.length;
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3" data-testid="max-turns-overrides">
      <p className="text-xs text-muted-foreground">
        {agents.length === 1 ? "1 agent has" : `${agents.length} agents have`} their own limit saved, which wins over
        this setting for that agent:{" "}
        {shown.map((agent) => `${agent.agentName} (${agent.maxTurnsPerRun})`).join(", ")}
        {rest > 0 ? ` and ${rest} more` : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={clearMutation.isPending}
          onClick={() => clearMutation.mutate()}
        >
          {clearMutation.isPending ? "Updating agents..." : `Use ${instanceMaxTurns} turns for every agent`}
        </Button>
        <span className="text-xs text-muted-foreground">
          Removes the per-agent limits so all agents follow this setting. You can give any agent its own limit again later.
        </span>
      </div>
    </div>
  );
}

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  // DUR-3939: the instance-wide run cap. Edited as text so a half-typed
  // number does not save; null means "showing the saved value".
  const [maxRunsDraft, setMaxRunsDraft] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to sign out.");
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const factCheckCardStrictAllowlist = generalQuery.data?.factCheckCardStrictAllowlist === true;
  const doneGate: DoneGateSettings = generalQuery.data?.doneGate ?? DEFAULT_DONE_GATE_SETTINGS;
  const saveDoneGate = (patch: Partial<DoneGateSettings>) =>
    updateGeneralMutation.mutate({ doneGate: { ...doneGate, ...patch } });
  const doneGateModeOptions: Array<{ value: DoneGateMode; label: string }> = [
    { value: "off", label: "Off" },
    { value: "dry_run", label: "Comment only" },
    { value: "enforce", label: "On" },
  ];
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const globalMaxConcurrentRuns = generalQuery.data?.globalMaxConcurrentRuns ?? DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS;
  const maxRunDurationMinutes = generalQuery.data?.maxRunDurationMinutes ?? DEFAULT_MAX_RUN_DURATION_MINUTES;
  const silentRunTimeoutMinutes = generalQuery.data?.silentRunTimeoutMinutes ?? DEFAULT_SILENT_RUN_TIMEOUT_MINUTES;
  const maxTurnsPerRun = generalQuery.data?.maxTurnsPerRun ?? DEFAULT_MAX_TURNS_PER_RUN;
  const sessionResetAfterRuns = generalQuery.data?.sessionResetAfterRuns ?? DEFAULT_SESSION_RESET_AFTER_RUNS;
  const sessionResetAfterHours = generalQuery.data?.sessionResetAfterHours ?? DEFAULT_SESSION_RESET_AFTER_HOURS;
  const maxRunsValue = maxRunsDraft ?? String(globalMaxConcurrentRuns);
  const maxRunsParsed = Number(maxRunsValue);
  const maxRunsValid =
    /^\d+$/.test(maxRunsValue.trim()) &&
    Number.isInteger(maxRunsParsed) &&
    maxRunsParsed >= MIN_GLOBAL_MAX_CONCURRENT_RUNS &&
    maxRunsParsed <= MAX_GLOBAL_MAX_CONCURRENT_RUNS;
  const maxRunsChanged = maxRunsValid && maxRunsParsed !== globalMaxConcurrentRuns;
  const saveMaxRuns = () => {
    if (!maxRunsChanged) return;
    updateGeneralMutation.mutate(
      { globalMaxConcurrentRuns: maxRunsParsed },
      { onSuccess: () => setMaxRunsDraft(null) },
    );
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide preferences including log display, keyboard shortcuts, how many
          agent runs may go at once, run time limits, backup retention, and data sharing.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Deployment and auth</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? "Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required."
              : healthQuery.data?.deploymentExposure === "public"
                ? "Authenticated public mode requires sign-in for board access and is intended for public URLs."
                : "Authenticated private mode requires sign-in and is intended for LAN, VPN, or other private-network deployments."}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label="Auth readiness"
              value={healthQuery.data?.authReady ? "Ready" : "Not ready"}
            />
            <StatusBox
              label="Bootstrap status"
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? "Setup required" : "Ready"}
            />
            <StatusBox
              label="Bootstrap invite"
              value={healthQuery.data?.bootstrapInviteActive ? "Active" : "None"}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle username log censoring"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating tasks or
              toggling panels. This is off by default.
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle keyboard shortcuts"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Max concurrent runs (whole instance)</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              How many agent runs may be going at the same time across every company on this server.
              When all of these slots are taken, new runs wait in the queue until one frees up; the
              Now page says so when that happens. Each agent also has its own limit in its settings,
              and both apply. Raising this lets more agents work at once but uses more of your AI
              budget and more of the server at the same time. Default {DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS};
              allowed {MIN_GLOBAL_MAX_CONCURRENT_RUNS} to {MAX_GLOBAL_MAX_CONCURRENT_RUNS}.
            </p>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              saveMaxRuns();
            }}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={MIN_GLOBAL_MAX_CONCURRENT_RUNS}
              max={MAX_GLOBAL_MAX_CONCURRENT_RUNS}
              step={1}
              value={maxRunsValue}
              onChange={(event) => setMaxRunsDraft(event.target.value)}
              disabled={updateGeneralMutation.isPending}
              aria-label="Max concurrent runs (whole instance)"
              aria-invalid={!maxRunsValid}
              className="w-28"
            />
            <Button type="submit" size="sm" disabled={!maxRunsChanged || updateGeneralMutation.isPending}>
              {updateGeneralMutation.isPending ? "Saving..." : "Save"}
            </Button>
            {maxRunsDraft !== null && maxRunsDraft !== String(globalMaxConcurrentRuns) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={updateGeneralMutation.isPending}
                onClick={() => setMaxRunsDraft(null)}
              >
                Cancel
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {maxRunsValid
                ? `Currently ${globalMaxConcurrentRuns}. Takes effect on the next run; running work is not interrupted.`
                : `Enter a whole number from ${MIN_GLOBAL_MAX_CONCURRENT_RUNS} to ${MAX_GLOBAL_MAX_CONCURRENT_RUNS}.`}
            </span>
          </form>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Run time limits</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Paperclip watches every agent run that runs as a program on this server. A run that goes on
              longer than the first limit without finishing, or whose program is still running but has
              printed nothing for longer than the second, is stopped, marked as failed in plain words, and
              retried once. The agent stays available; only if the retry gets stuck too is the agent flagged
              for attention. This frees the agent&apos;s run slot instead of leaving it held by a run that will
              never finish. Defaults {DEFAULT_MAX_RUN_DURATION_MINUTES} and {DEFAULT_SILENT_RUN_TIMEOUT_MINUTES};
              an agent&apos;s own settings (maxRunDurationMinutes / silentRunTimeoutMinutes) can override these.
            </p>
          </div>
          <MinutesLimitField
            label="Stop a run after"
            saved={maxRunDurationMinutes}
            min={MIN_MAX_RUN_DURATION_MINUTES}
            max={MAX_MAX_RUN_DURATION_MINUTES}
            pending={updateGeneralMutation.isPending}
            onSave={(minutes) => updateGeneralMutation.mutate({ maxRunDurationMinutes: minutes })}
          />
          <MinutesLimitField
            label="Stop a silent run after"
            saved={silentRunTimeoutMinutes}
            min={MIN_SILENT_RUN_TIMEOUT_MINUTES}
            max={MAX_SILENT_RUN_TIMEOUT_MINUTES}
            pending={updateGeneralMutation.isPending}
            onSave={(minutes) => updateGeneralMutation.mutate({ silentRunTimeoutMinutes: minutes })}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Turn limit and saved sessions</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Most of what an agent run costs is the context it re-reads on every turn, not what it writes.
              These two limits keep that in check. A run that reaches the turn limit stops with a plain note
              and the work continues in a fresh run; only if the same task hits the limit three times in a row
              are you told about it. A saved session (the conversation an agent picks up again on its next run
              on the same task) is dropped after the number of runs or hours below, so it stops growing without
              bound; the next run then starts fresh with the full task description. Defaults{" "}
              {DEFAULT_MAX_TURNS_PER_RUN} turns, {DEFAULT_SESSION_RESET_AFTER_RUNS} runs and{" "}
              {DEFAULT_SESSION_RESET_AFTER_HOURS} hours. Changing these does not touch runs already going.
            </p>
          </div>
          <MinutesLimitField
            label="Max turns per run"
            saved={maxTurnsPerRun}
            min={MIN_MAX_TURNS_PER_RUN}
            max={MAX_MAX_TURNS_PER_RUN}
            pending={updateGeneralMutation.isPending}
            onSave={(turns) => updateGeneralMutation.mutate({ maxTurnsPerRun: turns })}
            unit="turns"
          />
          <MaxTurnsAgentOverridesPanel
            instanceMaxTurns={maxTurnsPerRun}
            onError={(message) => setActionError(message)}
          />
          <MinutesLimitField
            label="Reset a saved session after"
            saved={sessionResetAfterRuns}
            min={MIN_SESSION_RESET_AFTER_RUNS}
            max={MAX_SESSION_RESET_AFTER_RUNS}
            pending={updateGeneralMutation.isPending}
            onSave={(runs) => updateGeneralMutation.mutate({ sessionResetAfterRuns: runs })}
            unit="runs on the same task (0 = never)"
          />
          <MinutesLimitField
            label="Reset a saved session older than"
            saved={sessionResetAfterHours}
            min={MIN_SESSION_RESET_AFTER_HOURS}
            max={MAX_SESSION_RESET_AFTER_HOURS}
            pending={updateGeneralMutation.isPending}
            onSave={(hours) => updateGeneralMutation.mutate({ sessionResetAfterHours: hours })}
            unit="hours (0 = never)"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Stricter fact-check cards</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Agents can ask you to check a fact (&quot;Do these numbers match Fiken?&quot;). Those asks get a calmer
              card that says this is not a decision. With this on, that calmer card is only used when the question
              clearly reads as a check and every numbered line is a plain statement; anything else gets the normal
              decision card instead. Off by default. Turning it on can only make the app more careful, never less.
            </p>
          </div>
          <ToggleSwitch
            checked={factCheckCardStrictAllowlist}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({ factCheckCardStrictAllowlist: !factCheckCardStrictAllowlist })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle stricter fact-check cards"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Quality check before a task is marked done</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              When an agent says a task is finished, a second, cheap AI reviewer reads what the task asked for next to
              what the agent reported (and the change summary, when there was one) and answers &quot;looks done&quot; or
              &quot;still needs work&quot;. You are never checked, only agents. Off by default.
            </p>
            <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li><span className="font-medium text-foreground">Off</span>: nothing happens.</li>
              <li>
                <span className="font-medium text-foreground">Comment only</span>: the reviewer&apos;s verdict is posted on
                the task, but the task still moves to done. Use this first to see whether the reviewer is helpful.
              </li>
              <li>
                <span className="font-medium text-foreground">On</span>: a &quot;needs work&quot; verdict sends the task
                back to the agent with the findings. After the number of rounds below, the platform stops looping and
                asks you to decide instead. Once you answer that question or move the task back to in progress, the
                agent gets a fresh set of rounds.
              </li>
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quality check mode">
            {doneGateModeOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={doneGate.mode === option.value ? "default" : "outline"}
                aria-pressed={doneGate.mode === option.value}
                disabled={updateGeneralMutation.isPending || doneGate.mode === option.value}
                onClick={() => saveDoneGate({ mode: option.value })}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <MinutesLimitField
            label="Ask me after"
            unit={"rounds of \"needs work\""}
            saved={doneGate.maxRounds}
            min={MIN_DONE_GATE_MAX_ROUNDS}
            max={MAX_DONE_GATE_MAX_ROUNDS}
            pending={updateGeneralMutation.isPending}
            onSave={(rounds) => saveDoneGate({ maxRounds: rounds })}
          />
          {Object.keys(doneGate.companyOverrides ?? {}).length > 0 ? (
            <p className="max-w-2xl text-xs text-muted-foreground">
              {Object.keys(doneGate.companyOverrides).length} company-specific override(s) are set through the API and
              take precedence over the instance setting for those companies.
            </p>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Backup retention</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Configure how long automatic database backups are retained. Backups run roughly
              every hour and are compressed with gzip. Within the daily window all backups are
              kept; beyond that, one backup per week and one per month are preserved.
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Daily</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{days} days</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Weekly</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = weeks === 1 ? "1 week" : `${weeks} weeks`;
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Monthly</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = months === 1 ? "1 month" : `${months} months`;
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">AI feedback sharing</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Control whether thumbs up and thumbs down votes can send the voted AI output to
              Paperclip Labs. Votes are always saved locally.
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Read our terms of service
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              No default is saved yet. The next thumbs up or thumbs down choice will ask once and
              then save the answer here.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: "Always allow",
                description: "Share voted AI outputs automatically.",
              },
              {
                value: "not_allowed",
                label: "Don't allow",
                description: "Keep voted AI outputs local only.",
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            To retest the first-use prompt in local dev, remove the{" "}
            <code>feedbackDataSharingPreference</code> key from the{" "}
            <code>instance_settings.general</code> JSON row for this instance, or set it back to{" "}
            <code>"prompt"</code>. Unset and <code>"prompt"</code> both mean no default has been
            chosen yet.
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Sign out</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Sign out of this Paperclip instance. You will be redirected to the login page.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
