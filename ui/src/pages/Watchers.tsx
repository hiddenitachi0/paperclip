import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Eye, MoreVertical, Pencil, Plus, Send, Trash2 } from "lucide-react";
import {
  formatWatcherPrice,
  type CreateWatcherInput,
  type WatcherSource,
  type WatcherSummary,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { agentsApi } from "../api/agents";
import { watchersApi } from "../api/watchers";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { WatcherFormDialog } from "../components/WatcherFormDialog";

/**
 * Watchers: cheap scheduled price checks (crypto, US stocks, Oslo Børs
 * closing prices) that tell the operator on Telegram, through a quick
 * agent, only when a rule fires. Everyone in the company can see them; the
 * owner and admins can add, change, switch off, test and delete them.
 */

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function alertStatusWords(status: string): string {
  switch (status) {
    case "composing":
      return "being written";
    case "ready":
      return "waiting for Telegram";
    case "delivered":
      return "sent";
    case "failed":
      return "could not be sent";
    case "expired":
      return "not sent (too old)";
    default:
      return status;
  }
}

export function WatcherRow({
  watcher,
  canManage,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  busy,
}: {
  watcher: WatcherSummary;
  canManage: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const lastAlert = watcher.recentAlerts[0] ?? null;
  return (
    <li className="px-4 py-3" data-testid="watcher-row">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {watcher.name}
            {!watcher.enabled ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">switched off</span>
            ) : null}
            {watcher.withPicture ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">with picture</span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {watcher.ruleText}
            {watcher.agentName ? ` · ${watcher.agentName} tells you` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {watcher.lastPrice !== null
              ? `Last price ${formatWatcherPrice(watcher.lastPrice, watcher.currency)}`
              : "No price yet"}
            {watcher.lastCheckAt ? ` · checked ${timeAgo(watcher.lastCheckAt)}` : " · not checked yet"}
            {` · ${watcher.checksToday} check${watcher.checksToday === 1 ? "" : "s"} today`}
            {` · ${watcher.alertsToday} alert${watcher.alertsToday === 1 ? "" : "s"} today`}
            {watcher.lastAlertAt ? ` · last alert ${timeAgo(watcher.lastAlertAt)}` : ""}
          </p>
          {watcher.lastCheckMessage ? (
            <p className={`text-xs ${watcher.lastCheckOk === false ? "text-destructive" : "text-muted-foreground"}`}>
              {watcher.lastCheckMessage}
            </p>
          ) : null}
          {lastAlert ? (
            <p className="text-xs text-muted-foreground">
              {lastAlert.isTest ? "Last test alert" : "Last alert"} {alertStatusWords(lastAlert.status)}
              {lastAlert.note ? ` — ${lastAlert.note}` : ""}
            </p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <ToggleSwitch
              aria-label={watcher.enabled ? `Switch off ${watcher.name}` : `Switch on ${watcher.name}`}
              checked={watcher.enabled}
              onCheckedChange={onToggle}
              disabled={busy}
            />
            <Button variant="outline" size="sm" onClick={onTest} disabled={busy}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Test alert now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`More for ${watcher.name}`}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onDelete} variant="destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function Watchers() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WatcherSummary | null>(null);
  const [deleting, setDeleting] = useState<WatcherSummary | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Watchers" }]);
  }, [setBreadcrumbs]);

  const watchersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.watchers.list(selectedCompanyId) : ["watchers", "__none__"],
    queryFn: () => watchersApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    // Prices and counters move on their own; keep the page roughly current.
    refetchInterval: 60_000,
  });
  const watchers = watchersQuery.data ?? [];

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__none__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && canManage,
  });
  const quickAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.laneAEnabled === true && agent.status !== "terminated"),
    [agentsQuery.data],
  );

  // The key a stock watcher of the same market already uses, offered first.
  const suggestedKeys = useMemo(() => {
    const keys: Partial<Record<WatcherSource, string>> = {};
    for (const watcher of watchers) {
      if (watcher.keySecretId) keys[watcher.source] = watcher.keySecretId;
    }
    return keys;
  }, [watchers]);

  const invalidate = () => {
    if (selectedCompanyId) queryClient.invalidateQueries({ queryKey: queryKeys.watchers.list(selectedCompanyId) });
  };

  const save = useMutation({
    mutationFn: (input: CreateWatcherInput) =>
      editing ? watchersApi.update(selectedCompanyId!, editing.id, input) : watchersApi.create(selectedCompanyId!, input),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      pushToast({ title: editing ? "Watcher saved" : "Watcher added", tone: "success" });
      setEditing(null);
    },
    onError: (error) => pushToast({ title: "Could not save the watcher", body: errorMessage(error, ""), tone: "error" }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      watchersApi.update(selectedCompanyId!, id, { enabled }),
    onSuccess: invalidate,
    onError: (error) => pushToast({ title: "Could not switch the watcher", body: errorMessage(error, ""), tone: "error" }),
  });

  const test = useMutation({
    mutationFn: (id: string) => watchersApi.testAlert(selectedCompanyId!, id),
    onSuccess: () => {
      invalidate();
      pushToast({
        title: "Test alert on its way",
        body: "It should reach Telegram within a minute or two.",
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not send a test alert", body: errorMessage(error, ""), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => watchersApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      pushToast({ title: "Watcher deleted", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not delete the watcher", body: errorMessage(error, ""), tone: "error" }),
  });

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  const busy = save.isPending || toggle.isPending || test.isPending || remove.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Watchers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cheap checks of a price — Bitcoin, a US stock, an Oslo Børs share. Checking costs nothing: no AI is used.
            Only when a rule fires does a quick agent write to you on Telegram, in its own words, with a picture if you
            want one.
          </p>
        </div>
        {canManage ? (
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add watcher
          </Button>
        ) : null}
      </div>

      {watchersQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : watchersQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(watchersQuery.error, "Could not load the watchers.")}</div>
      ) : watchers.length === 0 ? (
        <EmptyState
          icon={Eye}
          message={
            canManage
              ? "No watchers yet. Add one — for example: tell me when Bitcoin moves 5% or more within 24 hours."
              : "No watchers yet. A company owner or admin can add one."
          }
          action={canManage ? "Add watcher" : undefined}
          onAction={canManage ? openCreate : undefined}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {watchers.map((watcher) => (
            <WatcherRow
              key={watcher.id}
              watcher={watcher}
              canManage={canManage}
              busy={busy}
              onToggle={(enabled) => toggle.mutate({ id: watcher.id, enabled })}
              onTest={() => test.mutate(watcher.id)}
              onEdit={() => {
                setEditing(watcher);
                setFormOpen(true);
              }}
              onDelete={() => setDeleting(watcher)}
            />
          ))}
        </ul>
      )}

      {!canManage && watchers.length > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Bell className="h-3.5 w-3.5" />
          Only a company owner or admin can change watchers.
        </p>
      ) : null}

      <WatcherFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        watcher={editing}
        quickAgents={quickAgents}
        suggestedKeys={suggestedKeys}
        busy={save.isPending}
        onSubmit={(input) => save.mutate(input)}
      />

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this watcher?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.name}" stops checking, and its price history and alerts are removed. The saved key stays in
              Secrets.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove.mutate(deleting.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
