import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  formatAgentDisplayName,
  type Agent,
  type FleetAgentInErrorSample,
  type FleetHealth,
  type FleetHealthLevel,
  type FleetHealthSnapshot,
  type FleetUnavailableAgentSample,
} from "@paperclipai/shared";
import { Activity, AlertTriangle, ArrowRight, CircleCheck, CircleHelp, OctagonAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { healthApi } from "../api/health";
import { normalizeCompanyPrefix } from "../lib/company-routes";
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
  const { runs, slots, agents, scheduler, requests, quietMode } = fleet;
  const facts: Array<{ key: string; text: string; alert: boolean }> = [];

  // DUR-3965: first fact, because when quiet mode is on every number after it
  // is a consequence of it. "0 started, 0 queued" with no explanation is the
  // shape of the 2026-09-10 incident, where a failed deploy left the whole
  // instance muted for 27 minutes and nothing on screen said so.
  //
  // Stated as a plain fact while it is within its own window, and only
  // highlighted once it is past it. The operator pauses the whole fleet most
  // nights on purpose (the overnight Claude-quota window); an amber line
  // every night would train him to ignore the one night it means something.
  if (quietMode.active) {
    facts.push({
      key: "quiet",
      text:
        quietMode.activeForMs === null
          ? "Everything paused (quiet mode)"
          : `Everything paused (quiet mode) for ${formatFleetDuration(quietMode.activeForMs)}`,
      alert: quietMode.stuck,
    });
  }

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
  // Polish round 3: split the queue by whether each queued run is waiting on
  // its own agent (normal: agents run one at a time) or on nothing at all
  // (a free agent and a free slot, yet it has not started). Only the second
  // number means the queue itself is stuck, and only once nothing has
  // started for the whole window -- the same rule the server uses for its
  // critical line, so the fact and the headline never disagree.
  if (runs.queued > 0) {
    const free = runs.queuedWithNoRunningAgent;
    const behindOwnAgent = Math.max(0, runs.queued - free);
    facts.push({
      key: "queue",
      text:
        `${free} queued with a free agent` +
        (behindOwnAgent > 0 ? ` · ${behindOwnAgent} queued behind ${behindOwnAgent === 1 ? "its" : "their"} own agent` : ""),
      alert: free > 0 && !slots.saturated && runs.startedInWindow === 0,
    });
  }
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
  // DUR-3973: tasks sitting with agents that cannot pick them up. A fact,
  // never highlighted: whole companies' agents are paused on purpose for weeks
  // on this instance, and an amber chip for that would be crying wolf. The
  // one-time Activity notice per task is what flags a new case.
  const waiting = fleet.waitingOnUnavailableAgents;
  if (waiting && waiting.tasks > 0) {
    facts.push({
      key: "waiting-on-unavailable",
      text: `${waiting.tasks} task${waiting.tasks === 1 ? "" : "s"} waiting on agents that are off`,
      alert: false,
    });
  }
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

/** What the strip needs to know about a company to link into it. */
export interface FleetHealthCompanyRef {
  id: string;
  name: string;
  issuePrefix: string;
}

/**
 * DUR-4001: the Now page's own data, handed down so the strip can name and
 * link the agents concerned without a request of its own (the page polls
 * every 5 seconds). `agents` is the selected company's list: persona names
 * ("Sales agent 1 (Maja)") and the company-scoped error text come from it.
 * Agents in other companies get a name and, when this board can open that
 * company, a link through its prefix.
 */
export interface FleetHealthContext {
  agents?: Agent[];
  companies?: FleetHealthCompanyRef[];
  selectedCompanyId?: string | null;
}

/** One agent the strip names, and where its page (and its tasks) can be found. */
export interface FleetAgentLinkTarget {
  id: string;
  /** The raw agent name, as the server's sentences spell it. */
  name: string;
  /** What to show: the persona in brackets when the company list knows it. */
  label: string;
  /** The agent page, or null when the agent is in a company this board cannot open. */
  href: string | null;
  /** Its open tasks on the issues board; null on the same rule as `href`. */
  tasksHref: string | null;
  /** Set when the agent is in another company than the selected one and that company is known. */
  companyName: string | null;
  inOtherCompany: boolean;
  /** The company-scoped error text, known only for the selected company's agents. */
  errorReason: string | null;
}

export function resolveFleetAgentLink(
  sample: Pick<FleetAgentInErrorSample | FleetUnavailableAgentSample, "id" | "name" | "urlKey" | "companyId">,
  context: FleetHealthContext,
): FleetAgentLinkTarget {
  const inOtherCompany = Boolean(context.selectedCompanyId) && sample.companyId !== context.selectedCompanyId;
  const known = inOtherCompany ? undefined : context.agents?.find((agent) => agent.id === sample.id);
  const company = inOtherCompany ? context.companies?.find((entry) => entry.id === sample.companyId) : undefined;
  // Same company: a company-relative path, which Link prefixes for the board
  // in view. Another company: its own prefix, which Link leaves alone.
  const base = inOtherCompany ? (company ? `/${normalizeCompanyPrefix(company.issuePrefix)}` : null) : "";
  const errorReason = known?.errorReason?.trim();
  return {
    id: sample.id,
    name: sample.name,
    label: formatAgentDisplayName(sample, known?.persona),
    href: base === null ? null : `${base}/agents/${sample.urlKey}`,
    tasksHref: base === null ? null : `${base}/issues?assignee=${encodeURIComponent(sample.id)}`,
    companyName: company?.name ?? null,
    inOtherCompany,
    errorReason: errorReason ? errorReason : null,
  };
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AGENT_LINK_CLASS = "font-medium text-foreground underline underline-offset-2 hover:text-foreground/80";

/**
 * The server's sentences name agents in plain text ("...: Reviewer, Writer.").
 * Wrap every name that has a page in a link -- longest names first, so
 * "Sales agent 10" never links as "Sales agent 1" plus a stray "0", and only
 * where the name stands on its own rather than inside another word. A name
 * two sampled agents share (a "CEO" in two companies) is left as plain
 * text: the sentence cannot say which one it means, and the per-agent rows
 * under the facts are the place where each is told apart.
 */
export function renderWithAgentLinks(text: string, targets: FleetAgentLinkTarget[]): ReactNode {
  const nameCounts = new Map<string, number>();
  for (const target of targets) nameCounts.set(target.name, (nameCounts.get(target.name) ?? 0) + 1);
  const linkable = targets
    .filter((target) => target.href !== null && target.name.trim().length > 0 && nameCounts.get(target.name) === 1)
    .sort((left, right) => right.name.length - left.name.length);
  if (linkable.length === 0) return text;
  const pattern = new RegExp(linkable.map((target) => escapeRegExp(target.name)).join("|"), "g");
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const matched = match[0];
    const start = match.index;
    const end = start + matched.length;
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    if ((before && WORD_CHAR_RE.test(before)) || (after && WORD_CHAR_RE.test(after))) continue;
    const target = linkable.find((entry) => entry.name === matched);
    if (!target?.href) continue;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <Link key={`${target.id}-${start}`} to={target.href} className={AGENT_LINK_CLASS} data-testid="fleet-health-agent-link">
        {matched}
      </Link>,
    );
    last = end;
  }
  if (nodes.length === 0) return text;
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function AgentNameLink({ target }: { target: FleetAgentLinkTarget }) {
  return (
    <>
      {target.href ? (
        <Link to={target.href} className={AGENT_LINK_CLASS} data-testid="fleet-health-agent-link">
          {target.label}
        </Link>
      ) : (
        <span className="font-medium text-foreground">{target.label}</span>
      )}
      {target.inOtherCompany ? ` (in ${target.companyName ?? "another company"})` : ""}
    </>
  );
}

const ERROR_TEXT_MAX_CHARS = 160;

function shortErrorText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_TEXT_MAX_CHARS ? `${oneLine.slice(0, ERROR_TEXT_MAX_CHARS - 1).trimEnd()}…` : oneLine;
}

const DETAIL_ACTION_CLASS = "inline-flex items-center gap-0.5 font-medium text-foreground/80 hover:text-foreground";

/**
 * DUR-4001: under the facts row, one line per agent the counts are about --
 * its linked name, one plain sentence, and the one thing to do. Before this,
 * "1 agent needs attention" was a bare count and the operator, on his phone,
 * could not find which agent was meant.
 */
function FleetAgentDetails({ fleet, context }: { fleet: FleetHealthSnapshot; context: FleetHealthContext }) {
  const inError = fleet.agents.inErrorSample.map((sample) => ({ sample, target: resolveFleetAgentLink(sample, context) }));
  const waiting = fleet.waitingOnUnavailableAgents;
  const off = (waiting?.sample ?? []).map((sample) => ({ sample, target: resolveFleetAgentLink(sample, context) }));
  if (inError.length === 0 && off.length === 0) return null;
  const moreInError = fleet.agents.inError - inError.length;
  const moreOff = (waiting?.agents ?? 0) - off.length;

  return (
    <div className="mt-2 space-y-2 text-xs" data-testid="fleet-health-agent-details">
      {inError.length > 0 ? (
        <div data-testid="fleet-health-agents-in-error">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            {fleet.agents.inError === 1 ? "The agent that needs attention" : "The agents that need attention"}
          </p>
          <ul className="mt-0.5 space-y-1 text-muted-foreground">
            {inError.map(({ sample, target }) => (
              <li key={sample.id} data-testid="fleet-health-agent-in-error">
                <AgentNameLink target={target} /> — {sample.reasonText}
                {target.errorReason ? ` Last error: ${shortErrorText(target.errorReason)}` : ""}
                {target.href ? (
                  <>
                    {" "}
                    <Link to={target.href} className={DETAIL_ACTION_CLASS} data-testid="fleet-health-clear-error-link">
                      Clear the error on the agent page
                      <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {moreInError > 0 ? <p className="mt-0.5 text-muted-foreground">and {moreInError} more</p> : null}
        </div>
      ) : null}
      {off.length > 0 ? (
        <div data-testid="fleet-health-waiting-agents">
          <p className="font-medium text-foreground/80">Agents that are off, with tasks waiting on them</p>
          <ul className="mt-0.5 space-y-1 text-muted-foreground">
            {off.map(({ sample, target }) => (
              <li key={sample.id} data-testid="fleet-health-waiting-agent">
                <AgentNameLink target={target} /> — {sample.reasonText}
                {target.tasksHref ? (
                  <>
                    {" "}
                    <Link to={target.tasksHref} className={DETAIL_ACTION_CLASS} data-testid="fleet-health-waiting-tasks-link">
                      See {sample.tasks === 1 ? "the task" : `the ${sample.tasks} tasks`}
                      <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {moreOff > 0 ? (
            <p className="mt-0.5 text-muted-foreground">and {moreOff} more {moreOff === 1 ? "agent" : "agents"}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FleetHealthStripView({
  fleet,
  agents,
  companies,
  selectedCompanyId,
}: { fleet: FleetHealth | undefined } & FleetHealthContext) {
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
  const context: FleetHealthContext = { agents, companies, selectedCompanyId };
  // Every agent the server named, so the headline and the notes can link
  // the names they already contain.
  const linkTargets = [
    ...fleet.agents.inErrorSample,
    ...(fleet.waitingOnUnavailableAgents?.sample ?? []),
  ].map((sample) => resolveFleetAgentLink(sample, context));

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
            <span data-testid="fleet-health-headline">{renderWithAgentLinks(fleet.summary.headline, linkTargets)}</span>
          </p>
          {fleet.summary.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {fleet.summary.notes.map((note, index) => (
                <li key={index} data-testid="fleet-health-note">
                  {renderWithAgentLinks(note, linkTargets)}
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
          <FleetAgentDetails fleet={fleet} context={context} />
        </div>
      </div>
    </section>
  );
}

export function FleetHealthStrip({ agents, companies, selectedCompanyId }: FleetHealthContext = {}) {
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
  return (
    <FleetHealthStripView
      fleet={healthQuery.data?.fleet}
      agents={agents}
      companies={companies}
      selectedCompanyId={selectedCompanyId}
    />
  );
}
