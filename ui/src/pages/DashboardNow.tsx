import { useEffect, useMemo, type ReactNode } from "react";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval, Agent, Issue } from "@paperclipai/shared";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Loader2,
  RadioTower,
} from "lucide-react";
import { Link } from "@/lib/router";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { Button } from "@/components/ui/button";
import {
  approvalLabel,
  typeIcon,
  defaultTypeIcon,
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

// A run's lane. "Needs you" wins over everything else because it is the only
// lane that demands a human — an actioned run should surface there even if it is
// still technically running or already finished.
function laneForRun(run: LiveRunForIssue): LaneKey {
  if (needsFollowup(run)) return "needs_you";
  if (isRunning(run)) return "working";
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
  const { selectedCompanyId, companies } = useCompany();
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

  const actionableApprovals = useMemo(
    () =>
      (approvals ?? [])
        .filter((a) => a.status === "pending" || a.status === "revision_requested")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [approvals],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

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

  const needsYouCount = runsByLane.needs_you.length + actionableApprovals.length;

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
                  {actionableApprovals.map((approval) => (
                    <ApprovalRow
                      key={`approval-${approval.id}`}
                      approval={approval}
                      companyId={selectedCompanyId}
                      requester={
                        approval.requestedByAgentId
                          ? agentById.get(approval.requestedByAgentId) ?? null
                          : null
                      }
                    />
                  ))}
                  {runsByLane.needs_you.slice(0, LANE_ROW_LIMIT).map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      lane="needs_you"
                      issue={run.issueId ? issueById.get(run.issueId) : undefined}
                    />
                  ))}
                  {needsYouCount === 0 ? <LaneEmpty label="Nothing needs you right now." /> : null}
                </>
              ) : (
                <>
                  {runsByLane[lane.key].slice(0, LANE_ROW_LIMIT).map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      lane={lane.key}
                      issue={run.issueId ? issueById.get(run.issueId) : undefined}
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
}: {
  run: LiveRunForIssue;
  lane: LaneKey;
  issue?: Issue;
}) {
  // Prefer the ephemeral current-status message for live lanes; fall back to the
  // follow-up reason (needs_you) or the linked task title.
  const primary =
    (lane === "needs_you"
      ? run.livenessReason || run.nextAction || run.currentStatusMessage
      : run.currentStatusMessage) ||
    (issue?.title ?? (run.issueId ? `Task ${run.issueId.slice(0, 8)}` : "No linked task"));

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
      <p className="line-clamp-2 pl-4 text-xs text-muted-foreground group-hover:text-foreground">
        {primary}
      </p>
    </Link>
  );
}

function ApprovalRow({
  approval,
  companyId,
  requester,
}: {
  approval: Approval;
  companyId: string;
  requester: Agent | null;
}) {
  const queryClient = useQueryClient();
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown>);

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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.04] px-2.5 py-2">
      <Link
        to={`/approvals/${approval.id}`}
        className="group flex items-start gap-1.5"
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <p className="line-clamp-2 text-xs font-medium text-foreground group-hover:underline">
            {label}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {requester ? `From ${requester.name} · ` : ""}
            {relativeTime(approval.createdAt)}
          </p>
        </div>
      </Link>
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
    </div>
  );
}
