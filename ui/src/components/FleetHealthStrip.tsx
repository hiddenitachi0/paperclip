import { useQuery } from "@tanstack/react-query";
import type { FleetHealth, FleetHealthLevel, FleetHealthSnapshot } from "@paperclipai/shared";
import { Activity, AlertTriangle, CircleCheck, CircleHelp, OctagonAlert } from "lucide-react";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

// DUR-3939/DUR-3940/DUR-272/DUR-98: the one strip that answers "is the fleet
// actually moving?" On 2026-09-06 the only visible symptom of a starved fleet
// was a bare "Queued 9, waiting for a slot"; the night before, a dormant fleet
// showed nothing at all for ~5h. Reads /api/health's `fleet` field, which the
// server computes from live state on every request.

const FLEET_HEALTH_POLL_INTERVAL_MS = 10_000;

const LEVEL_STYLE: Record<
  FleetHealthLevel,
  { container: string; dot: string; icon: typeof CircleCheck; label: string }
> = {
  ok: {
    container: "border-emerald-500/30 bg-emerald-500/5",
    dot: "text-emerald-600 dark:text-emerald-400",
    icon: CircleCheck,
    label: "Healthy",
  },
  warning: {
    container: "border-amber-500/40 bg-amber-500/5",
    dot: "text-amber-600 dark:text-amber-400",
    icon: AlertTriangle,
    label: "Needs a look",
  },
  critical: {
    container: "border-red-500/40 bg-red-500/5",
    dot: "text-red-600 dark:text-red-400",
    icon: OctagonAlert,
    label: "Something is stuck",
  },
};

export function formatFleetDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The compact facts row under the headline, in the order an operator scans them. */
export function fleetHealthFacts(fleet: FleetHealthSnapshot): Array<{ key: string; text: string; alert: boolean }> {
  const { runs, slots, agents, scheduler, requests } = fleet;
  const facts: Array<{ key: string; text: string; alert: boolean }> = [];

  facts.push({
    key: "runs",
    text: `${runs.startedInWindow} started · ${runs.succeededInWindow} finished · ${runs.failedInWindow} failed (last ${runs.windowMinutes} min)`,
    alert: false,
  });
  facts.push({
    key: "slots",
    text:
      `${slots.used} of ${slots.max} slots in use` +
      (runs.queued > 0
        ? ` · ${runs.queued} queued${runs.oldestQueuedWaitMs !== null && runs.oldestQueuedWaitMs >= 60_000 ? ` (oldest ${formatFleetDuration(runs.oldestQueuedWaitMs)})` : ""}`
        : ""),
    alert: slots.saturated && runs.queued > 0,
  });
  facts.push({
    key: "zombies",
    text:
      runs.zombieCandidates > 0
        ? `${runs.zombieCandidates} run${runs.zombieCandidates === 1 ? "" : "s"} silent for ${runs.zombieSilenceMinutes}+ min`
        : "No stuck runs",
    alert: runs.zombieCandidates > 0,
  });
  facts.push({
    key: "agents",
    text:
      agents.inError > 0
        ? `${agents.inError} agent${agents.inError === 1 ? "" : "s"} need${agents.inError === 1 ? "s" : ""} attention`
        : "No agents in error",
    alert: agents.inError > 0,
  });
  facts.push({
    key: "scheduler",
    text: !scheduler.enabled
      ? "Scheduler off"
      : scheduler.sinceLastTickMs === null
        ? "Scheduler has not ticked yet"
        : `Scheduler ticked ${formatFleetDuration(scheduler.sinceLastTickMs)} ago`,
    alert: !scheduler.enabled || scheduler.stale,
  });
  // Slow requests and open streams (board chat replies, log tails) are
  // shown for information only; the one thing that turns this row amber is
  // a genuine pile-up (the overload line).
  facts.push({
    key: "requests",
    text:
      `${requests.inFlight} request${requests.inFlight === 1 ? "" : "s"} in flight` +
      (requests.slowInFlight > 0 ? ` (${requests.slowInFlight} slow)` : "") +
      (requests.streaming > 0 ? ` · ${requests.streaming} streaming` : ""),
    alert: requests.overloaded,
  });
  return facts;
}

export function FleetHealthStripView({ fleet }: { fleet: FleetHealth | undefined }) {
  if (!fleet) return null;

  if (!fleet.available) {
    return (
      <section
        data-testid="fleet-health-strip"
        data-level="unavailable"
        className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3"
      >
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Fleet health could not be checked right now.</p>
          <p className="text-xs text-muted-foreground">
            This is not a sign that things are fine — the check itself failed: {fleet.reason}
          </p>
        </div>
      </section>
    );
  }

  const style = LEVEL_STYLE[fleet.summary.level];
  const Icon = style.icon;
  const facts = fleetHealthFacts(fleet);

  return (
    <section
      data-testid="fleet-health-strip"
      data-level={fleet.summary.level}
      className={cn("rounded-xl border px-4 py-3", style.container)}
      aria-label={`Fleet health: ${style.label}`}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style.dot)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            <span className={cn("font-medium", style.dot)}>{style.label}.</span>{" "}
            <span data-testid="fleet-health-headline">{fleet.summary.headline}</span>
          </p>
          {fleet.summary.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {fleet.summary.notes.map((note, index) => (
                <li key={index} data-testid="fleet-health-note">
                  {note}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {facts.map((fact) => (
              <span
                key={fact.key}
                data-testid={`fleet-health-fact-${fact.key}`}
                className={cn("inline-flex items-center gap-1", fact.alert && "font-medium text-amber-700 dark:text-amber-300")}
              >
                <Activity className="h-3 w-3 opacity-60" aria-hidden />
                {fact.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function FleetHealthStrip() {
  const healthQuery = useQuery({
    // Shares Layout's key so there is one /api/health poll; the interval
    // here keeps it fresh while the Now page is open.
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: FLEET_HEALTH_POLL_INTERVAL_MS,
  });

  if (healthQuery.isError) {
    return (
      <FleetHealthStripView
        fleet={{ available: false, reason: healthQuery.error instanceof Error ? healthQuery.error.message : "health request failed" }}
      />
    );
  }
  return <FleetHealthStripView fleet={healthQuery.data?.fleet} />;
}
