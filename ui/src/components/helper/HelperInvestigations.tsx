import { useState } from "react";
import { Loader2, Search, ExternalLink } from "lucide-react";
import type {
  HelperDroppedReference,
  HelperInvestigationAvailability,
  HelperInvestigationView,
  HelperPictureInput,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { formatCents } from "../../lib/utils";
import { timeAgo } from "../../lib/timeAgo";
import { MarkdownBody } from "../MarkdownBody";

/**
 * "Ask Paperclip", Phase 3: "Investigate deeper".
 *
 * The person can hand a question to the company's investigation agent. It
 * becomes an ordinary task; this file draws the confirm step (who will look,
 * what it usually takes and costs, that it is advice only) and the person's
 * own investigations with their live state and, when done, the agent's answer.
 * The list comes from the server, so it survives a reload.
 */

/** What a click on "Investigate deeper" would send. */
export interface InvestigationDraft {
  question: string;
  context: string | null;
  pageRoute: string | null;
  references: string[];
  pictures: HelperPictureInput[];
  /** The quick helper's answer the person wants checked, if the draft came from one. */
  quickAnswer: string | null;
}

export const HELPER_INVESTIGATION_POLL_MS = 15_000;

export function isInvestigationActive(item: Pick<HelperInvestigationView, "status">): boolean {
  return item.status === "queued" || item.status === "working";
}

function minutesText(minutes: number): string {
  if (minutes < 2) return "a minute or two";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 6) / 10;
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

function costText(cents: number): string {
  return cents > 0 && cents < 1 ? "less than $0.01" : `about ${formatCents(cents)}`;
}

/** The honest time and cost line, from the agent's own recent finished tasks. */
export function investigationEstimateText(availability: HelperInvestigationAvailability): string {
  const name = availability.agentName ? `“${availability.agentName}”` : "The agent";
  const { basedOnTasks, typicalMinutes, typicalCostCents } = availability.estimate;
  const parts: string[] = [];
  if (basedOnTasks > 0 && typicalMinutes !== null) {
    const from = `going by the middle of ${name}'s last ${basedOnTasks} finished task${basedOnTasks === 1 ? "" : "s"}`;
    if (typicalCostCents !== null && typicalCostCents > 0) {
      parts.push(`It usually takes ${minutesText(typicalMinutes)} and costs ${costText(typicalCostCents)}, ${from}.`);
    } else {
      parts.push(
        `It usually takes ${minutesText(typicalMinutes)}, ${from}. Those tasks show no metered cost in Costs (the agent may run on a subscription, which still uses that plan's allowance).`,
      );
    }
    parts.push(`Bigger questions can take longer and cost more. It is paid from ${name}'s budget.`);
  } else {
    parts.push(
      `${name} has no finished tasks yet to estimate from. Expect several minutes; the cost depends on its model and is paid from its budget like any of its tasks.`,
    );
  }
  if (availability.agentBudgetMonthlyCents > 0) {
    const left = Math.max(0, availability.agentBudgetMonthlyCents - availability.agentSpentMonthlyCents);
    parts.push(`${formatCents(left)} of its ${formatCents(availability.agentBudgetMonthlyCents)} monthly budget is left.`);
  }
  return parts.join(" ");
}

/** "The question, the page text … and your 2 pictures". */
function sentParts(draft: InvestigationDraft): string {
  const parts = ["The question"];
  if (draft.context) parts.push("the page text shown under “What the helper sees”");
  if (draft.references.length > 0) parts.push("the records you marked");
  if (draft.pictures.length > 0) parts.push(draft.pictures.length === 1 ? "your picture" : `your ${draft.pictures.length} pictures`);
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function InvestigateConfirm({
  draft,
  availability,
  loading,
  starting,
  error,
  onStart,
  onCancel,
}: {
  draft: InvestigationDraft;
  availability: HelperInvestigationAvailability | null;
  loading: boolean;
  starting: boolean;
  error: string | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  const pictures = draft.pictures.length;
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 text-xs" data-testid="helper-investigate-confirm">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Search className="h-4 w-4" /> Investigate deeper
      </div>
      <p className="line-clamp-3 text-muted-foreground">“{draft.question}”</p>
      {loading && !availability ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking who can look into it…
        </p>
      ) : null}
      {availability && !availability.ready ? (
        <div className="space-y-1.5" role="alert" data-testid="helper-investigate-problem">
          <p className="text-amber-700 dark:text-amber-500">{availability.problem}</p>
          {availability.problemCode === "no_agent" ||
          availability.problemCode === "agent_unavailable" ||
          availability.problemCode === "agent_can_write" ? (
            <p className="text-muted-foreground">
              {availability.canConfigure
                ? "Tip: a dedicated “Investigator” agent that can only read is the safest choice."
                : "Until then, you can still ask the quick helper."}{" "}
              <Link to="/company/settings" className="underline" data-testid="helper-investigate-settings-link">
                Open Helper settings
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {availability?.ready ? (
        <div className="space-y-1.5" data-testid="helper-investigate-details">
          <p>
            “{availability.agentName}” will read what it needs (tasks, cards, comments, code, reviews, logs) and write one
            answer back here. It gives advice only: it does not approve, merge, deploy or change anything.
          </p>
          <p data-testid="helper-investigate-estimate">{investigationEstimateText(availability)}</p>
          {availability.canConfigure && availability.agentBudgetMonthlyCents === 0 ? (
            <p className="text-amber-700 dark:text-amber-500" data-testid="helper-investigate-no-budget">
              “{availability.agentName}” has no monthly budget, so only the helper's limits cap what investigations cost.
              You can set one on the agent's page.
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {sentParts(draft)} go{sentParts(draft) === "The question" ? "es" : ""} into a normal task
            {pictures > 0 ? " (pictures are shrunk and stripped of hidden data)" : ""}. You can open it any time.
          </p>
          <p className="text-muted-foreground">
            You have {availability.runningCount} of {availability.maxRunning} running, and started {availability.startedLast24h}{" "}
            of {availability.maxPerDay} in the last 24 hours ({availability.companyStartedLast24h} of{" "}
            {availability.companyMaxPerDay} for the whole company). Records or pictures you do not have access to are left
            out.
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {availability?.ready ? (
          <Button size="xs" onClick={onStart} disabled={starting} data-testid="helper-investigate-start">
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Start investigation
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onCancel} disabled={starting}>
          {availability?.ready ? "Cancel" : "Close"}
        </Button>
      </div>
    </div>
  );
}

const BADGE: Record<HelperInvestigationView["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  working: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

function InvestigationItem({ item, initiallyOpen }: { item: HelperInvestigationView; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const taskPath = `/issues/${item.identifier ?? item.id}`;
  return (
    <li className="space-y-1.5 rounded-md border border-border px-2.5 py-2" data-testid="helper-investigation" data-status={item.status}>
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${BADGE[item.status]}`}>
          {isInvestigationActive(item) ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {item.statusLabel}
        </span>
        <Link
          to={taskPath}
          disableIssueQuicklook
          className="inline-flex items-center gap-1 text-[11px] underline"
          data-testid="helper-investigation-link"
        >
          Open task{item.identifier ? ` ${item.identifier}` : ""} <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <button
        type="button"
        className="block w-full text-left text-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide the answer" : "Show the answer"}
      >
        <span className={open ? "" : "line-clamp-2"}>{item.question}</span>
      </button>
      <p className="text-[11px] text-muted-foreground">
        {item.agentName ?? "Agent"} · started {timeAgo(item.createdAt)}
        {item.costCents > 0 ? ` · ${formatCents(item.costCents)} so far` : ""}
      </p>
      {item.statusDetail ? <p className="text-xs text-muted-foreground">{item.statusDetail}</p> : null}
      {item.answer ? (
        open ? (
          <div className="border-t border-border pt-1.5" data-testid="helper-investigation-answer">
            <MarkdownBody className="text-sm">{item.answer}</MarkdownBody>
          </div>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
            Show the answer
          </Button>
        )
      ) : null}
    </li>
  );
}

/** "My investigations": the person's own, newest first, live while any is running. */
export function MyInvestigations({
  investigations,
  openIds,
}: {
  investigations: HelperInvestigationView[];
  /** Items whose answer shows without a click (the newest, and any started in this panel). */
  openIds: ReadonlySet<string>;
}) {
  if (investigations.length === 0) return null;
  const active = investigations.filter(isInvestigationActive).length;
  return (
    <section className="space-y-1.5" data-testid="helper-investigations" aria-label="My investigations">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">My investigations</span>
        <span className="text-muted-foreground">
          {active > 0 ? `${active} running · updates every ${HELPER_INVESTIGATION_POLL_MS / 1000} s` : "Only you see this list"}
        </span>
      </div>
      <ul className="space-y-1.5">
        {investigations.map((item) => (
          <InvestigationItem key={item.id} item={item} initiallyOpen={openIds.has(item.id)} />
        ))}
      </ul>
    </section>
  );
}

/** After a start: which marked records were left out, and why. */
export function DroppedReferencesNotice({ dropped, onClose }: { dropped: HelperDroppedReference[]; onClose: () => void }) {
  if (dropped.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/50 px-2.5 py-2 text-xs" role="status" data-testid="helper-investigation-dropped">
      <p>The investigation started, but {dropped.length === 1 ? "one marked record was" : `${dropped.length} marked records were`} left out:</p>
      <ul className="list-disc pl-5">
        {dropped.map((d) => (
          <li key={d.reference}>
            {d.reference}: {d.reason}.
          </li>
        ))}
      </ul>
      <Button size="xs" variant="ghost" onClick={onClose}>
        OK
      </Button>
    </div>
  );
}
