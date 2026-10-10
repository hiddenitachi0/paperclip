import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { formatAgentDisplayName } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import type { LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn, formatCents } from "../lib/utils";
import { TOWER_STATUS_COLOR, towerAgentState } from "./TowerScene";

/**
 * Paperclip Tower side panel for one agent: Inspect (what they're doing, what
 * they've cost this month) and New Task (a normal company issue assigned to
 * them — same endpoint and permission checks as the New Task dialog).
 */

export const TOWER_STATE_WORDS: Record<string, { label: string; meaning: string }> = {
  working: { label: "Working now", meaning: "At their desk on a task right now." },
  idle: { label: "On a break", meaning: "Not working on anything this minute. They pick up work when it arrives." },
  paused: { label: "Paused", meaning: "Switched off for now. They won't start new work until someone resumes them." },
  error: { label: "Needs attention", meaning: "Their last attempt hit a problem. Open their page to see what happened." },
  pending_approval: { label: "Waiting for approval", meaning: "Hired, but someone still has to approve them before they start." },
};

function errorWords(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You don't have permission to give this agent a task.";
    if (error.status === 401) return "You've been signed out. Sign in again and retry.";
    return error.message || "The task couldn't be created.";
  }
  return error instanceof Error ? error.message : "The task couldn't be created.";
}

export interface TowerAgentPanelProps {
  companyId: string;
  agent: Agent;
  boss: Agent | null;
  run: LiveRunForIssue | null;
  spentThisMonthCents: number | null;
  initialTab?: "inspect" | "task";
  onClose: () => void;
}

export function TowerAgentPanel({
  companyId,
  agent,
  boss,
  run,
  spentThisMonthCents,
  initialTab = "inspect",
  onClose,
}: TowerAgentPanelProps) {
  const [tab, setTab] = useState<"inspect" | "task">(initialTab);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState<{ ref: string } | null>(null);
  const queryClient = useQueryClient();

  // A new person was clicked: start fresh.
  useEffect(() => {
    setTab(initialTab);
    setTitle("");
    setDescription("");
    setCreated(null);
  }, [agent.id, initialTab]);

  const issueId = run?.issueId ?? null;
  const { data: currentIssue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueId!),
    enabled: Boolean(issueId),
  });

  const createTask = useMutation({
    mutationFn: (input: { title: string; description: string }) =>
      issuesApi.create(companyId, {
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        status: "todo",
        priority: "medium",
        assigneeAgentId: agent.id,
      }),
    onSuccess: (issue) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      setCreated({ ref: issue.identifier ?? issue.id });
      setTitle("");
      setDescription("");
    },
  });

  const state = towerAgentState(agent.status, Boolean(run));
  const words = TOWER_STATE_WORDS[state] ?? TOWER_STATE_WORDS.idle!;
  const displayName = formatAgentDisplayName(agent, agent.persona);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || createTask.isPending) return;
    setCreated(null);
    createTask.mutate({ title: t, description: description.trim() });
  };

  return (
    <aside
      className="flex h-full w-full flex-col border-l border-border bg-card text-card-foreground"
      aria-label={`${displayName} details`}
      data-testid="tower-panel"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{displayName}</h2>
          <p className="truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex border-b border-border text-sm" role="tablist">
        {(["inspect", "task"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={cn(
              "flex-1 px-3 py-2 font-medium transition-colors",
              tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(t)}
          >
            {t === "inspect" ? "Inspect" : "New task"}
          </button>
        ))}
      </div>

      {tab === "inspect" ? (
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <div>
            <span
              className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold text-black"
              style={{ backgroundColor: TOWER_STATUS_COLOR[state] }}
              data-testid="tower-panel-status"
            >
              {words.label}
            </span>
            <p className="mt-2 text-muted-foreground">{words.meaning}</p>
          </div>

          <div className="rounded-md border border-border p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Working on now</div>
            {run ? (
              <div className="mt-1">
                {currentIssue ? (
                  <Link to={`/issues/${currentIssue.identifier ?? currentIssue.id}`} className="font-medium hover:underline">
                    {currentIssue.identifier ? `${currentIssue.identifier} — ` : ""}
                    {currentIssue.title}
                  </Link>
                ) : (
                  <span className="font-medium">{issueId ? "Loading the task…" : "A routine check-in (no task)"}</span>
                )}
                {run.currentStatusMessage ? (
                  <p className="mt-1 text-xs text-muted-foreground">{run.currentStatusMessage}</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-muted-foreground">Nothing right now.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-border p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Spent this month</div>
              <div className="mt-1 text-lg font-semibold tabular-nums" data-testid="tower-panel-spend">
                {spentThisMonthCents == null ? "—" : formatCents(spentThisMonthCents)}
              </div>
              {agent.budgetMonthlyCents > 0 ? (
                <div className="text-xs text-muted-foreground">of {formatCents(agent.budgetMonthlyCents)} budget</div>
              ) : null}
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Reports to</div>
              <div className="mt-1 truncate font-medium">{boss ? formatAgentDisplayName(boss, boss.persona) : "Nobody (top of the company)"}</div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Button onClick={() => setTab("task")}>Give {agent.name} a task</Button>
            <Button variant="outline" asChild>
              <Link to={agentUrl(agent)}>Open {agent.name}'s page</Link>
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex-1 space-y-4 overflow-y-auto p-4 text-sm" onSubmit={submit}>
          <div className="space-y-1.5">
            <label htmlFor="tower-task-title" className="text-xs font-medium text-muted-foreground">
              What needs doing?
            </label>
            <Input
              id="tower-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="A short title"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="tower-task-description" className="text-xs font-medium text-muted-foreground">
              Details (optional)
            </label>
            <Textarea
              id="tower-task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Context, links, and what 'done' looks like"
              rows={5}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            This creates a normal task for {agent.name}. They'll pick it up on their next turn.
          </p>
          {createTask.isError ? (
            <p className="text-xs text-destructive" role="alert">
              {errorWords(createTask.error)}
            </p>
          ) : null}
          {created ? (
            <p className="text-xs" role="status">
              Task created:{" "}
              <Link to={`/issues/${created.ref}`} className="font-medium underline">
                {created.ref}
              </Link>
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setTab("inspect")}>
              Back
            </Button>
            <Button type="submit" disabled={!title.trim() || createTask.isPending} className="flex-1">
              {createTask.isPending ? "Creating…" : "Create task"}
            </Button>
          </div>
        </form>
      )}
    </aside>
  );
}
