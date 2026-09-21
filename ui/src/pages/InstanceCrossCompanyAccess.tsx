import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Building2, ChevronLeft, ChevronRight, Clock, Eye, User } from "lucide-react";
import type { CrossCompanyAccessLogEntry } from "@paperclipai/shared";
import { crossCompanyAccessApi } from "@/api/crossCompanyAccess";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";

const PAGE_SIZE = 50;

/** "2026-09-18" in the viewer's own time zone -> the ISO instant that day starts. */
export function startOfLocalDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The "to" day is included in full, so the exclusive bound is the start of the next day. */
export function startOfNextLocalDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function describeWho(entry: Pick<CrossCompanyAccessLogEntry, "actorType" | "actorId" | "actorName">): string {
  switch (entry.actorType) {
    case "user":
      return entry.actorName?.trim() || (entry.actorId ? `A person (id ${entry.actorId})` : "A person");
    case "agent":
      return entry.actorName?.trim() ? `Agent ${entry.actorName.trim()}` : "An agent";
    case "scheduler":
      return "Paperclip's background scheduler";
    case "system":
      return "Paperclip itself";
    case null:
    case undefined:
      return "Someone who was not signed in yet";
    default:
      return entry.actorName?.trim() || entry.actorType;
  }
}

function WhoIcon({ actorType }: { actorType: string | null }) {
  const className = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  if (actorType === "agent") return <Bot className={className} />;
  if (actorType === "scheduler" || actorType === "system") return <Clock className={className} />;
  return <User className={className} />;
}

function EntryRow({ entry }: { entry: CrossCompanyAccessLogEntry }) {
  return (
    <div className="space-y-1 px-3 py-2.5 text-sm" data-testid="cross-company-access-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular-nums text-muted-foreground" title={relativeTime(entry.occurredAt)}>
          {formatDateTime(entry.occurredAt)}
        </span>
        <span className="flex items-center gap-1.5 font-medium">
          <WhoIcon actorType={entry.actorType} />
          {describeWho(entry)}
        </span>
        {entry.companies.map((company) => (
          <Badge key={company.id} variant="outline" className="gap-1 px-1.5 py-0 text-[11px] font-normal">
            <Building2 className="h-3 w-3" />
            {company.name ?? "a company that no longer exists"}
          </Badge>
        ))}
      </div>
      <p className="text-foreground/90">{entry.reason}</p>
      {entry.route && (
        <p className="truncate font-mono text-xs text-muted-foreground" title={entry.route}>
          {entry.route}
        </p>
      )}
    </div>
  );
}

export function InstanceCrossCompanyAccess() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [showRoutine, setShowRoutine] = useState(false);
  // Keyset pagination: the cursors of the pages already walked past, so
  // "Newer" can step back without the server having to count anything.
  const [cursors, setCursors] = useState<string[]>([]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Cross-company access" },
    ]);
  }, [setBreadcrumbs]);

  const from = fromDay ? startOfLocalDay(fromDay) : null;
  const to = toDay ? startOfNextLocalDay(toDay) : null;
  const rangeInverted = Boolean(from && to && from >= to);
  const cursor = cursors[cursors.length - 1] ?? null;

  const resetPaging = () => setCursors([]);

  const pageQuery = useQuery({
    queryKey: queryKeys.instance.crossCompanyAccess({ from, to, cursor, showRoutine }),
    queryFn: () => crossCompanyAccessApi.list({ from, to, cursor, limit: PAGE_SIZE, showRoutine }),
    enabled: !rangeInverted,
    placeholderData: (previous) => previous,
  });

  const page = pageQuery.data;
  const forbidden = pageQuery.error instanceof ApiError && pageQuery.error.status === 403;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Eye className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Who looked at another company's data</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Paperclip keeps each company's data apart. A few things are allowed to look across companies -- for example
          signing in as a person who belongs to more than one company, or the server checking every company for
          unfinished work after it restarts. Every time that happens it is written down here, newest first. Only
          instance admins can see this page. Entries older than 90 days are removed automatically.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1 text-sm">
              <span className="block text-xs font-medium text-muted-foreground">From</span>
              <Input
                type="date"
                value={fromDay}
                className="h-8 w-40"
                onChange={(event) => {
                  setFromDay(event.target.value);
                  resetPaging();
                }}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-xs font-medium text-muted-foreground">To (including that day)</span>
              <Input
                type="date"
                value={toDay}
                className="h-8 w-40"
                onChange={(event) => {
                  setToDay(event.target.value);
                  resetPaging();
                }}
              />
            </label>
            {(fromDay || toDay) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => {
                  setFromDay("");
                  setToDay("");
                  resetPaging();
                }}
              >
                Clear dates
              </Button>
            )}
            <div className="flex items-center gap-2 text-sm sm:ml-auto">
              <ToggleSwitch
                checked={showRoutine}
                aria-label="Show routine background checks"
                onCheckedChange={(checked) => {
                  setShowRoutine(checked);
                  resetPaging();
                }}
              />
              <span>Show routine background checks</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Until 17 September the server wrote an entry here every 30 seconds for its own routine background checks.
            Those are hidden unless you switch them on; anything out of the ordinary is always shown.
          </p>

          {rangeInverted ? (
            <p className="text-sm text-destructive">The "From" day must be on or before the "To" day.</p>
          ) : forbidden ? (
            <p className="text-sm text-muted-foreground">Only an instance admin can see this page.</p>
          ) : pageQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : pageQuery.error || !page ? (
            <p className="text-sm text-destructive">
              {pageQuery.error instanceof Error ? pageQuery.error.message : "Could not load the list."}
            </p>
          ) : page.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {cursors.length > 0
                ? "There is nothing older than this."
                : fromDay || toDay
                  ? "Nothing crossed between companies in these dates."
                  : "Nothing has crossed between companies yet."}
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {page.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}

          {!rangeInverted && !forbidden && page && (cursors.length > 0 || page.nextCursor) && (
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={cursors.length === 0 || pageQuery.isFetching}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
                Newer
              </Button>
              <span className="text-xs text-muted-foreground">Page {cursors.length + 1}</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!page.nextCursor || pageQuery.isFetching}
                onClick={() => {
                  const next = page.nextCursor;
                  if (next) setCursors((previous) => [...previous, next]);
                }}
              >
                Older
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
