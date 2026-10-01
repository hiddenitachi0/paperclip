import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CheckCircle2, Rocket } from "lucide-react";
import { dashboardApi } from "@/api/dashboard";
import { approvalsApi } from "@/api/approvals";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatCents } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PULSE_REFRESH_OPTIONS_MS,
  usePulseSettings,
} from "@/hooks/usePulseSettings";
import type { DashboardPulse } from "@paperclipai/shared";

/** Plain-language labels for the refresh-rate picker -- no "ms"/"interval" jargon. */
function refreshLabel(ms: number): string {
  if (ms < 60_000) return `Every ${Math.round(ms / 1000)} seconds`;
  const minutes = Math.round(ms / 60_000);
  return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type PulseState = "ok" | "warning" | "critical";

function pulseState(pulse: DashboardPulse | undefined): PulseState {
  if (!pulse) return "ok";
  if (pulse.budget.status === "critical") return "critical";
  if (pulse.needsYouCount > 0 || pulse.budget.status === "warning") return "warning";
  return "ok";
}

const DOT_CLASSES: Record<PulseState, string> = {
  ok: "bg-green-600",
  warning: "bg-amber-500",
  critical: "bg-red-600",
};

const BADGE_VARIANT: Record<PulseState, "secondary" | "outline" | "destructive"> = {
  ok: "secondary",
  warning: "outline",
  critical: "destructive",
};

function PulseTrigger({ enabled, pulse }: { enabled: boolean; pulse: DashboardPulse | undefined }) {
  const state = pulseState(pulse);
  const count = pulse?.needsYouCount ?? 0;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={
        !enabled
          ? "Pulse (off) — open to turn on status updates"
          : count > 0
            ? `${count} thing${count === 1 ? "" : "s"} need your attention`
            : "Everything looks fine"
      }
      className="relative"
    >
      <Activity className={cn("h-4.5 w-4.5", !enabled && "opacity-40")} />
      {enabled && count > 0 && (
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white",
            DOT_CLASSES[state],
          )}
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
      {enabled && count === 0 && (
        <span className={cn("absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full", DOT_CLASSES[state])} />
      )}
    </Button>
  );
}

function NeedsYouTab({ pulse, companyId }: { pulse: DashboardPulse | undefined; companyId: string }) {
  const queryClient = useQueryClient();
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const approveMutation = useMutation({
    mutationFn: (approvalId: string) => approvalsApi.approve(approvalId),
    onMutate: (approvalId: string) => setApprovingId(approvalId),
    onSettled: () => {
      setApprovingId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardPulse(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    },
  });

  const items = pulse?.needsYou ?? [];

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
        <CheckCircle2 className="h-5 w-5 text-green-600" />
        Nothing needs you right now.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.approvalId}
          className="flex items-start justify-between gap-2 rounded-md border border-border p-2.5"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{item.title ?? "Needs a decision"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.requestedByAgentName ? `Asked by ${item.requestedByAgentName} · ` : ""}
              {timeAgo(item.createdAt)}
            </p>
          </div>
          <Button
            size="sm"
            className="shrink-0"
            disabled={approveMutation.isPending && approvingId === item.approvalId}
            onClick={() => approveMutation.mutate(item.approvalId)}
          >
            {approveMutation.isPending && approvingId === item.approvalId ? "Approving…" : "Approve"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function HappeningTab({ pulse }: { pulse: DashboardPulse | undefined }) {
  const budget = pulse?.budget;
  const executions = pulse?.activeExecutions ?? [];
  const completions = pulse?.recentCompletions ?? [];
  const deploys = pulse?.deploys ?? [];

  return (
    <div className="flex flex-col gap-4">
      {budget && (
        <div className="rounded-md border border-border p-2.5">
          <p className="text-xs text-muted-foreground">Spent today</p>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold">{formatCents(budget.spentTodayCents)}</p>
            {budget.dailyLimitCents != null && (
              <p className="text-xs text-muted-foreground">
                of {formatCents(budget.dailyLimitCents)}/day
              </p>
            )}
          </div>
          {budget.percentage != null && (
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  budget.status === "critical"
                    ? "bg-red-600"
                    : budget.status === "warning"
                      ? "bg-amber-500"
                      : "bg-green-600",
                )}
                style={{ width: `${Math.min(100, Math.max(0, budget.percentage))}%` }}
              />
            </div>
          )}
        </div>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          Working now {executions.length > 0 && `(${executions.length})`}
        </p>
        {executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one is working right now.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {executions.map((run) => (
              <li key={run.issueId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{run.agentName ?? "Someone"} — {run.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {run.startedAt ? timeAgo(run.startedAt) : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Finished recently</p>
        {completions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing finished in the last 12 hours.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {completions.slice(0, 5).map((item) => (
              <li key={item.issueId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.completedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {deploys.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Rocket className="h-3.5 w-3.5" /> Recent launches
          </p>
          <ul className="flex flex-col gap-1.5">
            {deploys.slice(0, 5).map((deploy) => (
              <li key={deploy.approvalId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{deploy.title ?? "Launch"}</span>
                <Badge variant={deploy.deployedAt ? "secondary" : "outline"} className="shrink-0">
                  {deploy.deployedAt ? "Live" : deploy.status}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SettingsTab({
  enabled,
  setEnabled,
  telegramEnabled,
  setTelegramEnabled,
  refreshMs,
  setRefreshMs,
}: ReturnType<typeof usePulseSettings>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Show pulse updates</p>
          <p className="text-xs text-muted-foreground">
            Turns the status icon and these updates on or off.
          </p>
        </div>
        <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Show pulse updates" />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Send a copy to Telegram</p>
          <p className="text-xs text-muted-foreground">
            Not connected yet — turning this on won't send messages until Telegram is set up.
          </p>
        </div>
        <ToggleSwitch
          checked={telegramEnabled}
          onCheckedChange={setTelegramEnabled}
          aria-label="Send a copy to Telegram"
          disabled={!enabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">How often to check for updates</p>
        <Select
          value={String(refreshMs)}
          onValueChange={(value) => setRefreshMs(Number(value))}
          disabled={!enabled}
        >
          <SelectTrigger size="sm" className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PULSE_REFRESH_OPTIONS_MS.map((ms) => (
              <SelectItem key={ms} value={String(ms)}>
                {refreshLabel(ms)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function PulsePanel({ companyId }: { companyId: string | null }) {
  const [open, setOpen] = useState(false);
  const settings = usePulseSettings();
  const { enabled, refreshMs } = settings;

  const { data: pulse } = useQuery({
    queryKey: queryKeys.dashboardPulse(companyId ?? ""),
    queryFn: () => dashboardApi.pulse(companyId as string),
    enabled: !!companyId && enabled,
    refetchInterval: enabled ? refreshMs : false,
  });

  const defaultTab = useMemo(() => (enabled ? "needs-you" : "settings"), [enabled]);

  if (!companyId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span>
          <PulseTrigger enabled={enabled} pulse={pulse} />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 sm:w-96">
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList className="m-2 mb-0">
            <TabsTrigger value="needs-you">Needs You</TabsTrigger>
            <TabsTrigger value="happening">What's Happening</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <div className="max-h-[70vh] overflow-y-auto p-3">
            <TabsContent value="needs-you">
              {enabled ? (
                <NeedsYouTab pulse={pulse} companyId={companyId} />
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Turn on pulse updates in Settings to see what needs you.
                </p>
              )}
            </TabsContent>
            <TabsContent value="happening">
              {enabled ? (
                <HappeningTab pulse={pulse} />
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Turn on pulse updates in Settings to see what's happening.
                </p>
              )}
            </TabsContent>
            <TabsContent value="settings">
              <SettingsTab {...settings} />
            </TabsContent>
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
