import { useEffect, useMemo, type ReactNode } from "react";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval, Agent, Issue } from "@paperclipai/shared";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Loader2,
  MessageCircleQuestion,
  RadioTower,
} from "lucide-react";
import { Link } from "@/lib/router";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { interactionsApi, type PendingCompanyInteraction } from "../api/interactions";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import { describeRunActivity } from "../lib/run-activity";
import { classifyTaskWaiting, type TaskWaiting } from "../lib/task-waiting";
import { Button } from "@/components/ui/button";
import {
  approvalLabel,
  typeIcon,
  defaultTypeIcon,
  approvalTargetBadge,
  approvalDuplicateKey,
} from "../components/ApprovalPayload";

// Live board polling cadence. Fast enough to feel live, slow enough to stay cheap
// with several lanes fetching in parallel (mirrors the sidebar's 10s but tighter
// because this page is the dedicated "what's happening now" surface).
const NOW_POLL_INTERVAL_MS = 5_000;
// Pull a generous window so "Just finished" has recent completions to show; the
// lanes each cap their own visible rows below.
const NOW_RUN_FETCH_LIMIT = 60;
const NOW_RUN_MIN_COUNT = 40;
const LANE_ROW_LIMIT = 12;
// Every open, non-terminal status — used only to count what this page is
// *not* showing, so "Needs you" being quiet never reads as "nothing to do".
const OPEN_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked";
const OPEN_ISSUES_COUNT_LIMIT = 300;
// Live-transcript polling for the "what's it doing now" glimpse on active runs.
const NOW_LOG_POLL_INTERVAL_MS = 5_000;
const NOW_LOG_READ_LIMIT_BYTES = 48_000;
const NOW_MAX_CHUNKS_PER_RUN = 24;

type LaneKey = "needs_you" | "working" | "queued" | "finished";

function isRunning(run: LiveRunForIssue): boolean {
  return run.status === "running";
}

function isQueued(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "scheduled_retry";
}

function needsFollowup(run: LiveRunForIssue): boolean {
  return run.livenessState === "needs_followup";
}

// A run's lane. "Needs you" is reserved for a run that is *still live and stuck*
// — running, but flagged as needing follow-up. A run that has already terminated
// is never a human action item, even if the liveness monitor tagged it
// `needs_followup` (e.g. "succeeded but no concrete action evidence" — that's the
// recovery system's job, not Filip's); it belongs in "Just finished." This keeps
// the Needs-you lane to genuine asks instead of every monitoring heuristic.
function laneForRun(run: LiveRunForIssue): LaneKey {
  if (isRunning(run)) return needsFollowup(run) ? "needs_you" : "working";
  if (isQueued(run)) return "queued";
  return "finished";
}

interface LaneMeta {
  key: LaneKey;
  label: string;
  hint: string;
  // Tailwind classes for the accent dot / count pill per lane.
  dot: string;
  pill: string;
}

// Ordered most-urgent first: the human acts on "Needs you", then scans live work.
const LANES: LaneMeta[] = [
  {
    key: "needs_you",
    label: "Needs you",
    hint: "Waiting on a decision or a nudge",
    dot: "bg-amber-500",
    pill: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  {
    key: "working",
    label: "Working now",
    hint: "Agents actively running",
    dot: "bg-cyan-500",
    pill: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  },
  {
    key: "queued",
    label: "Queued",
    hint: "Waiting for a slot",
    dot: "bg-muted-foreground/50",
    pill: "bg-muted text-muted-foreground",
  },
  {
    key: "finished",
    label: "Just finished",
    hint: "Recently completed runs",
    dot: "bg-emerald-500",
    pill: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
];

export function DashboardNow() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Now" }]);
  }, [setBreadcrumbs]);

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "now-view"],
    queryFn: () =>
      heartbeatsApi.liveRunsForCompany(selectedCompanyId!, {
        minCount: NOW_RUN_MIN_COUNT,
        limit: NOW_RUN_FETCH_LIMIT,
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: NOW_POLL_INTERVAL_MS,
  });

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: NOW_POLL_INTERVAL_MS,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  // Blocked tasks that stopped waiting on someone. We surface the ones waiting
  // on the user in the Needs-you lane — a blocked task an agent can't move past
  // without a human is exactly "needs you", even without a run or approval.
  const { data: blockedTasks } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "now-blocked"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        status: "blocked",
        includeBlockedInboxAttention: true,
        includeBlockedBy: true,
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: NOW_POLL_INTERVAL_MS,
  });

  // An agent that halted an issue thread to ask the operator a direct
  // question — independent of the issue's own status (in_review, blocked,
  // in_progress all halt this way). This is a precise fourth source: only
  // interactions still pending a human answer, never a looser "parked task"
  // heuristic (see task-waiting.ts's own warning against over-notifying).
  const { data: pendingInteractions } = useQuery({
    queryKey: queryKeys.interactions.pendingForCompany(selectedCompanyId!),
    queryFn: () => interactionsApi.listPendingForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: NOW_POLL_INTERVAL_MS,
  });

  // Total open issues across every status that isn't done/cancelled, purely
  // to tell the operator how much this page is *not* showing (DUR-249): the
  // Needs-you lane only ever surfaces items Paperclip can attribute to a
  // human, so a board can have many more open tasks than the lane implies.
  const { data: openIssuesForCount } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "now-open-count"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        status: OPEN_ISSUE_STATUSES,
        limit: OPEN_ISSUES_COUNT_LIMIT,
      }),
    enabled: !!selectedCompanyId,
    staleTime: 15_000,
  });
  const totalOpenCount = openIssuesForCount?.length ?? null;
  const totalOpenCountIsFloor = totalOpenCount !== null && totalOpenCount >= OPEN_ISSUES_COUNT_LIMIT;

  const runs = useMemo(() => liveRuns ?? [], [liveRuns]);

  // Fetch issue titles for every run that references one, so rows can show the
  // human-readable task instead of a bare id (same approach as ActiveAgentsPanel).
  const issueIds = useMemo(
    () => [...new Set(runs.map((r) => r.issueId).filter((id): id is string => Boolean(id)))],
    [runs],
  );
  const issueQueries = useQueries({
    queries: issueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const q of issueQueries) {
      if (q.data) map.set(q.data.id, q.data);
    }
    return map;
  }, [issueQueries]);

  const runsByLane = useMemo(() => {
    const grouped: Record<LaneKey, LiveRunForIssue[]> = {
      needs_you: [],
      working: [],
      queued: [],
      finished: [],
    };
    for (const run of runs) grouped[laneForRun(run)].push(run);
    // Finished lane reads best newest-first by completion time.
    grouped.finished.sort((a, b) => finishedSortValue(b) - finishedSortValue(a));
    return grouped;
  }, [runs]);

  // Pull the live transcript for actively-running agents so each row can show
  // the real current action ("Editing worker.ts", "Running `pnpm build`") rather
  // than the opaque runtime status. Only running/followup runs produce output.
  const activeRuns = useMemo(
    () => runs.filter((r) => r.status === "running" || r.livenessState === "needs_followup"),
    [runs],
  );
  const { transcriptByRun } = useLiveRunTranscripts({
    runs: activeRuns.map((r) => ({
      id: r.id,
      status: r.status,
      adapterType: r.adapterType,
      logBytes: r.logBytes,
      lastOutputBytes: r.lastOutputBytes,
    })),
    companyId: selectedCompanyId,
    maxChunksPerRun: NOW_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: NOW_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: NOW_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });
  const activityByRun = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of activeRuns) {
      const activity = describeRunActivity(transcriptByRun.get(run.id));
      if (activity) map.set(run.id, activity);
    }
    return map;
  }, [activeRuns, transcriptByRun]);

  const actionableApprovals = useMemo(
    () =>
      (approvals ?? [])
        .filter((a) => a.status === "pending" || a.status === "revision_requested")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [approvals],
  );

  // Two pending approvals can target the very same PR or commit under
  // different wording (see DUR-156) — count how many actionable approvals
  // share each duplicate key so rows can flag it without anyone having to
  // open both to compare.
  const duplicateKeyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const approval of actionableApprovals) {
      const key = approvalDuplicateKey(approval.payload as Record<string, unknown>);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [actionableApprovals]);

  // Fetch the issue(s) each pending approval is linked to, so its row can
  // show the human-readable reference (e.g. "DUR-142") without opening the
  // approval (DUR-156). Small, bounded list — one query per actionable row.
  const approvalIssueQueries = useQueries({
    queries: actionableApprovals.map((approval) => ({
      queryKey: [...queryKeys.approvals.list(selectedCompanyId ?? ""), approval.id, "issues"],
      queryFn: () => approvalsApi.listIssues(approval.id),
      enabled: !!selectedCompanyId,
      staleTime: 30_000,
      retry: false,
    })),
  });
  const issuesByApprovalId = useMemo(() => {
    const map = new Map<string, Issue[]>();
    actionableApprovals.forEach((approval, index) => {
      const data = approvalIssueQueries[index]?.data;
      if (data) map.set(approval.id, data);
    });
    return map;
  }, [actionableApprovals, approvalIssueQueries]);

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  // Blocked tasks that are waiting on the user (not on another agent/external).
  const needsYouTasks = useMemo(
    () =>
      (blockedTasks ?? [])
        .map((issue) => ({ issue, waiting: classifyTaskWaiting(issue) }))
        .filter((t) => t.waiting.waitingOn === "you"),
    [blockedTasks],
  );

  // Blocked tasks Paperclip can't attribute to anyone (DUR-249): not wrong to
  // keep out of Needs-you, but they used to vanish from the page entirely —
  // give them a visible place instead.
  const parkedTasks = useMemo(
    () =>
      (blockedTasks ?? [])
        .map((issue) => ({ issue, waiting: classifyTaskWaiting(issue) }))
        .filter((t) => t.waiting.waitingOn === "unknown"),
    [blockedTasks],
  );

  const issuesBoardPath = selectedCompany?.issuePrefix ? `/${selectedCompany.issuePrefix}/issues` : "/issues";

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={
          companies.length === 0
            ? "Create a company to see what's happening now."
            : "Select a company to see what's happening now."
        }
      />
    );
  }

  const needsYouCount =
    runsByLane.needs_you.length
    + actionableApprovals.length
    + needsYouTasks.length
    + (pendingInteractions ?? []).length;

  // Rows the lane's own LANE_ROW_LIMIT silently drops (DUR-249 item 3) —
  // approvals and interactions above are never sliced, only these two are.
  const needsYouOverflow =
    Math.max(0, runsByLane.needs_you.length - LANE_ROW_LIMIT)
    + Math.max(0, needsYouTasks.length - LANE_ROW_LIMIT);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-normal text-foreground">
            <RadioTower className="h-5 w-5 text-cyan-500" />
            Now
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything live across this company at a glance — updates every few seconds.
          </p>
        </div>
        <Link
          to="/dashboard/live"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Full run history
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {LANES.map((lane) => {
          const count =
            lane.key === "needs_you" ? needsYouCount : runsByLane[lane.key].length;
          return (
            <Lane key={lane.key} meta={lane} count={count}>
              {lane.key === "needs_you" ? (
                <>
                  {actionableApprovals.map((approval) => {
                    const duplicateKey = approvalDuplicateKey(
                      approval.payload as Record<string, unknown>,
                    );
                    return (
                      <ApprovalRow
                        key={`approval-${approval.id}`}
                        approval={approval}
                        companyId={selectedCompanyId}
                        requester={
                          approval.requestedByAgentId
                            ? agentById.get(approval.requestedByAgentId) ?? null
                            : null
                        }
                        linkedIssues={issuesByApprovalId.get(approval.id)}
                        companyName={selectedCompany?.name ?? null}
                        isDuplicate={!!duplicateKey && (duplicateKeyCounts.get(duplicateKey) ?? 0) > 1}
                      />
                    );
                  })}
                  {(pendingInteractions ?? []).map((interaction) => (
                    <InteractionRow
                      key={`interaction-${interaction.id}`}
                      interaction={interaction}
                      companyId={selectedCompanyId}
                    />
                  ))}
                  {runsByLane.needs_you.slice(0, LANE_ROW_LIMIT).map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      lane="needs_you"
                      issue={run.issueId ? issueById.get(run.issueId) : undefined}
                      activity={activityByRun.get(run.id)}
                    />
                  ))}
                  {needsYouTasks.slice(0, LANE_ROW_LIMIT).map(({ issue, waiting }) => (
                    <BlockedTaskRow key={`task-${issue.id}`} issue={issue} label={waiting.label} />
                  ))}
                  {needsYouCount === 0 ? <LaneEmpty label="Nothing needs you right now." /> : null}
                  {needsYouOverflow > 0 ? (
                    <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                      +{needsYouOverflow} more
                    </p>
                  ) : null}
                  {totalOpenCount !== null ? (
                    <Link
                      to={issuesBoardPath}
                      className="mt-1 flex items-center justify-between gap-1 rounded-lg border border-dashed border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                    >
                      <span>
                        Showing {needsYouCount} of {totalOpenCountIsFloor ? `${totalOpenCount}+` : totalOpenCount}{" "}
                        open
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 font-medium">
                        See all
                        <ArrowRight className="h-3 w-3" />
                      </span>
                    </Link>
                  ) : null}
                </>
              ) : (
                <>
                  {runsByLane[lane.key].slice(0, LANE_ROW_LIMIT).map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      lane={lane.key}
                      issue={run.issueId ? issueById.get(run.issueId) : undefined}
                      activity={activityByRun.get(run.id)}
                    />
                  ))}
                  {runsByLane[lane.key].length === 0 ? (
                    <LaneEmpty label={emptyLabelForLane(lane.key)} />
                  ) : null}
                  {runsByLane[lane.key].length > LANE_ROW_LIMIT ? (
                    <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                      +{runsByLane[lane.key].length - LANE_ROW_LIMIT} more
                    </p>
                  ) : null}
                </>
              )}
            </Lane>
          );
        })}
      </div>

      <ParkedPanel tasks={parkedTasks} issuesBoardPath={issuesBoardPath} />
    </div>
  );
}

function finishedSortValue(run: LiveRunForIssue): number {
  const stamp = run.finishedAt ?? run.createdAt;
  return stamp ? new Date(stamp).getTime() : 0;
}

function emptyLabelForLane(key: LaneKey): string {
  switch (key) {
    case "working":
      return "No agents running.";
    case "queued":
      return "Nothing queued.";
    case "finished":
      return "Nothing finished recently.";
    default:
      return "Nothing here.";
  }
}

function Lane({
  meta,
  count,
  children,
}: {
  meta: LaneMeta;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-[8rem] flex-col rounded-xl border border-border bg-background/60">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
          <span className="text-sm font-semibold text-foreground">{meta.label}</span>
        </div>
        <span
          className={cn(
            "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            meta.pill,
          )}
        >
          {count}
        </span>
      </header>
      <p className="px-3 pt-2 text-[11px] text-muted-foreground">{meta.hint}</p>
      <div className="flex flex-col gap-1.5 p-2">{children}</div>
    </section>
  );
}

function LaneEmpty({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

const LANE_ROW_STATUS: Record<LaneKey, string> = {
  needs_you: "border-amber-500/30 hover:border-amber-500/50",
  working: "border-cyan-500/25 hover:border-cyan-500/45",
  queued: "border-border hover:border-border",
  finished: "border-border hover:border-border",
};

function RunRow({
  run,
  lane,
  issue,
  activity,
}: {
  run: LiveRunForIssue;
  lane: LaneKey;
  issue?: Issue;
  /** Live "what it's doing now" line derived from the run transcript. */
  activity?: string;
}) {
  const taskTitle = issue?.title ?? (run.issueId ? `Task ${run.issueId.slice(0, 8)}` : null);

  // Lead with the real current action (from the transcript). Fall back through
  // the follow-up reason, the ephemeral status, and finally the task title.
  const primary =
    activity ||
    (lane === "needs_you" ? run.livenessReason || run.nextAction : null) ||
    run.currentStatusMessage ||
    taskTitle ||
    (lane === "needs_you" ? "Waiting for you" : "Working…");

  // When the primary line is a live action (not the task itself), keep the task
  // visible as context so you see both what and on-which.
  const showTaskContext = Boolean(taskTitle) && primary !== taskTitle;
  const isActive = lane === "working" || lane === "needs_you";

  const timeLabel =
    lane === "finished"
      ? run.finishedAt
        ? `Finished ${relativeTime(run.finishedAt)}`
        : `Ended ${relativeTime(run.createdAt)}`
      : lane === "queued"
        ? `Queued ${relativeTime(run.createdAt)}`
        : lane === "working"
          ? "Live now"
          : run.lastEventAt
            ? `Updated ${relativeTime(run.lastEventAt)}`
            : `Started ${relativeTime(run.createdAt)}`;

  return (
    <Link
      to={`/agents/${run.agentId}/runs/${run.id}`}
      className={cn(
        "group flex flex-col gap-1 rounded-lg border bg-background/70 px-2.5 py-2 transition-colors",
        LANE_ROW_STATUS[lane],
      )}
      title={isActive ? "Open the live transcript" : "Open the run"}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {lane === "working" ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-cyan-500" />
          ) : lane === "needs_you" ? (
            <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
          ) : lane === "finished" ? (
            <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
          ) : (
            <CircleDot className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <Identity
            name={run.agentName}
            size="sm"
            className="[&>span:last-child]:!text-[11px] [&>span:last-child]:!font-medium"
          />
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel}</span>
      </div>
      <p
        className={cn(
          "line-clamp-2 pl-4 text-xs",
          lane === "working" ? "text-foreground/90" : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {primary}
      </p>
      <div className="flex items-center justify-between gap-2 pl-4">
        {showTaskContext ? (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">on {taskTitle}</span>
        ) : (
          <span />
        )}
        {isActive ? (
          <span className="hidden shrink-0 items-center gap-0.5 text-[10px] font-medium text-cyan-600 group-hover:inline-flex dark:text-cyan-400">
            Watch live <ArrowRight className="h-2.5 w-2.5" />
          </span>
        ) : null}
      </div>
    </Link>
  );
}

function BlockedTaskRow({
  issue,
  label,
  tone = "needs_you",
}: {
  issue: Issue;
  label: string;
  /** "parked" = blocked but not attributed to anyone yet (DUR-249) — same
   * shape as a needs-you row, muted instead of amber so it doesn't read as
   * a decision waiting on the operator. */
  tone?: "needs_you" | "parked";
}) {
  const isParked = tone === "parked";
  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      className={cn(
        "group flex items-start gap-1.5 rounded-lg border px-2.5 py-2",
        isParked ? "border-border bg-muted/30" : "border-amber-500/40 bg-amber-500/[0.04]",
      )}
      title="Open the task"
    >
      <AlertCircle
        className={cn(
          "mt-0.5 h-3.5 w-3.5 shrink-0",
          isParked ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400",
        )}
      />
      <div className="min-w-0">
        <p className="line-clamp-2 text-xs font-medium text-foreground group-hover:underline">
          {issue.identifier ? `${issue.identifier} · ` : ""}
          {issue.title}
        </p>
        <p className="text-[10px] text-muted-foreground">
          <span
            className={cn(
              "font-medium",
              isParked ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400",
            )}
          >
            {isParked ? "Parked" : "Waiting on you"}
          </span>
          {label && label !== "Parked" ? ` · ${label}` : ""}
        </p>
      </div>
    </Link>
  );
}

function ParkedPanel({
  tasks,
  issuesBoardPath,
}: {
  tasks: { issue: Issue; waiting: TaskWaiting }[];
  issuesBoardPath: string;
}) {
  const visible = tasks.slice(0, LANE_ROW_LIMIT);
  const overflow = tasks.length - visible.length;
  return (
    <section className="flex flex-col rounded-xl border border-border bg-background/60">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-slate-400" />
          <span className="text-sm font-semibold text-foreground">Parked</span>
        </div>
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
          {tasks.length}
        </span>
      </header>
      <p className="px-3 pt-2 text-[11px] text-muted-foreground">
        Blocked, but not waiting on you specifically — an agent still owns getting these moving again.
      </p>
      <div className="flex flex-col gap-1.5 p-2">
        {visible.map(({ issue, waiting }) => (
          <BlockedTaskRow key={`parked-${issue.id}`} issue={issue} label={waiting.label} tone="parked" />
        ))}
        {tasks.length === 0 ? <LaneEmpty label="Nothing parked." /> : null}
        {overflow > 0 ? (
          <p className="px-1 pt-1 text-[11px] text-muted-foreground">+{overflow} more</p>
        ) : null}
        <Link
          to={issuesBoardPath}
          className="mt-1 inline-flex items-center gap-1 self-start px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          See full board
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </section>
  );
}

function ApprovalRow({
  approval,
  companyId,
  requester,
  linkedIssues,
  companyName,
  isDuplicate,
}: {
  approval: Approval;
  companyId: string;
  requester: Agent | null;
  // Undefined = the linked-issues fetch for this row hasn't settled yet;
  // an empty array is a confirmed "nothing linked" defect (DUR-211).
  linkedIssues: Issue[] | undefined;
  companyName?: string | null;
  isDuplicate: boolean;
}) {
  const queryClient = useQueryClient();
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const payload = approval.payload as Record<string, unknown>;
  const label = approvalLabel(approval.type, payload);
  const targetBadge = approvalTargetBadge(payload);
  const issueRefs = (linkedIssues ?? [])
    .map((issue) => issue.identifier)
    .filter((identifier): identifier is string => Boolean(identifier));
  const showNoTicketFlag = linkedIssues !== undefined && issueRefs.length === 0;

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approval.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    },
  });
  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approval.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    },
  });
  const busy = approveMutation.isPending || rejectMutation.isPending;
  // A credential request is resolved by providing a value on its detail page,
  // not by a generic Approve/Reject.
  const isCredentialRequest = approval.type === "credential_request";

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-2.5 py-2",
        isDuplicate
          ? "border-red-500/50 bg-red-500/[0.06]"
          : "border-amber-500/40 bg-amber-500/[0.04]",
      )}
    >
      {isDuplicate ? (
        <p className="flex items-center gap-1 text-[10px] font-medium text-red-600 dark:text-red-400">
          <AlertCircle className="h-3 w-3 shrink-0" />
          Same {targetBadge ?? "target"} as another pending approval — approving both is likely wrong
        </p>
      ) : null}
      <Link
        to={`/approvals/${approval.id}`}
        className="group flex items-start gap-1.5"
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          {(issueRefs.length > 0 || showNoTicketFlag || companyName) && (
            <div className="mb-0.5 flex flex-wrap items-center gap-1">
              {companyName ? (
                <span className="rounded bg-background px-1 py-px text-[10px] font-medium text-muted-foreground">
                  {companyName}
                </span>
              ) : null}
              {issueRefs.map((ref) => (
                <span
                  key={ref}
                  className="rounded bg-primary/10 px-1 py-px font-mono text-[10px] font-semibold text-primary"
                >
                  {ref}
                </span>
              ))}
              {showNoTicketFlag ? (
                <span className="inline-flex items-center gap-0.5 rounded bg-red-500/10 px-1 py-px text-[10px] font-medium text-red-600 dark:text-red-400">
                  <AlertCircle className="h-2.5 w-2.5" />
                  No linked ticket
                </span>
              ) : null}
            </div>
          )}
          <p className="line-clamp-2 text-xs font-medium text-foreground group-hover:underline">
            {label}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {requester ? `From ${requester.name} · ` : ""}
            {relativeTime(approval.createdAt)}
            {targetBadge ? ` · ${targetBadge}` : ""}
          </p>
        </div>
      </Link>
      {isCredentialRequest ? (
        <Link
          to={`/approvals/${approval.id}`}
          className="inline-flex h-6 items-center justify-center rounded-md bg-amber-600 px-2 text-[11px] font-semibold text-white hover:bg-amber-500"
        >
          Provide credential
        </Link>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-6 flex-1 bg-green-700 px-2 text-[11px] text-white hover:bg-green-600"
            disabled={busy}
            onClick={() => approveMutation.mutate()}
          >
            {approveMutation.isPending ? "…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-6 flex-1 px-2 text-[11px]"
            disabled={busy}
            onClick={() => rejectMutation.mutate()}
          >
            {rejectMutation.isPending ? "…" : "Reject"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Plain-language question text for a pending interaction row — the prompt an
 * operator halted on, not a generic "Requested confirmation" status label. */
function interactionQuestionText(interaction: PendingCompanyInteraction): string {
  if (interaction.title?.trim()) return interaction.title.trim();
  switch (interaction.kind) {
    case "request_confirmation":
    case "request_checkbox_confirmation":
      return interaction.payload.prompt;
    case "ask_user_questions":
      return interaction.payload.title?.trim() || interaction.payload.questions[0]?.prompt || "Answer needed";
    case "suggest_tasks": {
      const count = interaction.payload.tasks.length;
      return interaction.summary?.trim() || `${count} suggested ${count === 1 ? "task" : "tasks"}`;
    }
    default:
      return "Waiting for your answer";
  }
}

function InteractionRow({
  interaction,
  companyId,
}: {
  interaction: PendingCompanyInteraction;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const issueRef = interaction.issueIdentifier ?? interaction.issueId;
  const threadHref = `/issues/${issueRef}#interaction-${interaction.id}`;
  // Only a plain confirmation resolves with a single tap; checkbox selections,
  // question forms, and task drafts need the full form in the issue thread.
  // A confirmation that requires a decline reason also needs the full form —
  // an inline Decline tap with no reason would just fail silently.
  const supportsInlineDecision =
    interaction.kind === "request_confirmation" && interaction.payload.rejectRequiresReason !== true;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.interactions.pendingForCompany(companyId) });

  const acceptMutation = useMutation({
    mutationFn: () => issuesApi.acceptInteraction(interaction.issueId, interaction.id),
    onSuccess: invalidate,
  });
  const rejectMutation = useMutation({
    mutationFn: () => issuesApi.rejectInteraction(interaction.issueId, interaction.id),
    onSuccess: invalidate,
  });
  const busy = acceptMutation.isPending || rejectMutation.isPending;
  const acceptLabel =
    interaction.kind === "request_confirmation" ? interaction.payload.acceptLabel ?? "Approve" : "Approve";
  const rejectLabel =
    interaction.kind === "request_confirmation" ? interaction.payload.rejectLabel ?? "Decline" : "Decline";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.04] px-2.5 py-2">
      <Link to={threadHref} className="group flex items-start gap-1.5">
        <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <p className="line-clamp-2 text-xs font-medium text-foreground group-hover:underline">
            {interactionQuestionText(interaction)}
          </p>
          <p className="line-clamp-1 text-[10px] text-muted-foreground">
            {interaction.issueIdentifier ? `${interaction.issueIdentifier} · ` : ""}
            {interaction.issueTitle}
            {interaction.createdByAgentName ? ` · from ${interaction.createdByAgentName}` : ""}
            {" · "}
            {relativeTime(interaction.createdAt)}
          </p>
        </div>
      </Link>
      {supportsInlineDecision ? (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-6 flex-1 bg-green-700 px-2 text-[11px] text-white hover:bg-green-600"
            disabled={busy}
            onClick={() => acceptMutation.mutate()}
          >
            {acceptMutation.isPending ? "…" : acceptLabel}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-6 flex-1 px-2 text-[11px]"
            disabled={busy}
            onClick={() => rejectMutation.mutate()}
          >
            {rejectMutation.isPending ? "…" : rejectLabel}
          </Button>
        </div>
      ) : (
        <Link
          to={threadHref}
          className="inline-flex h-6 items-center justify-center rounded-md border border-amber-600/50 px-2 text-[11px] font-semibold text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
        >
          Answer in thread
        </Link>
      )}
    </div>
  );
}
