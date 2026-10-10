import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Building2, CircleHelp, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { agentsApi } from "../api/agents";
import { costsApi } from "../api/costs";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { TowerAgentPanel, TOWER_STATE_WORDS } from "../components/TowerAgentPanel";
import { TOWER_SCENE_CSS, TOWER_STATUS_COLOR, TowerScene, type TowerSceneAgent } from "../components/TowerScene";
import { buildTowerFloor, visibleTowerAgents, workingAgentIdsFromRuns } from "../lib/tower-layout";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

/**
 * Paperclip Tower: a gamified isometric office. One floor per company the
 * viewer belongs to; agents sit in rooms that follow the reporting tree, and
 * only the ones working right now are at their desks.
 */

const LIVE_POLL_MS = 10_000; // live events also invalidate these keys; polling is the fallback
const DEFAULT_ACCENT = "#e8b23a";
const SILKSCREEN_HREF = "https://fonts.googleapis.com/css2?family=Silkscreen&display=swap";

function startOfUtcMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Load the Silkscreen pixel font once; the scene falls back to monospace without it. */
function useSilkscreenFont() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("tower-silkscreen-font")) return;
    const link = document.createElement("link");
    link.id = "tower-silkscreen-font";
    link.rel = "stylesheet";
    link.href = SILKSCREEN_HREF;
    document.head.appendChild(link);
  }, []);
}

export function Tower() {
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [kioskOpen, setKioskOpen] = useState(false);
  useSilkscreenFont();

  useEffect(() => {
    setBreadcrumbs([{ label: "Tower" }]);
  }, [setBreadcrumbs]);

  // Changing floor clears the selection.
  useEffect(() => {
    setSelectedAgentId(null);
    setKioskOpen(false);
  }, [selectedCompanyId]);

  // Floors: only companies this viewer can see (the companies list is already
  // membership-filtered by the server), minus archived ones.
  const floors = useMemo(
    () => companies.filter((c) => c.status !== "archived").map((c, i) => ({ company: c, number: i + 1 })),
    [companies],
  );

  // Live runs for every floor drive the elevator's "working" counters. Same
  // query key as the sidebar, so the live-event channel keeps them fresh.
  const floorRuns = useQueries({
    queries: floors.map(({ company }) => ({
      queryKey: queryKeys.liveRuns(company.id),
      queryFn: () => heartbeatsApi.liveRunsForCompany(company.id),
      refetchInterval: LIVE_POLL_MS,
    })),
  });

  const companyId = selectedCompanyId;
  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? "__none__"),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
    refetchInterval: 30_000,
  });

  const monthStart = useMemo(() => startOfUtcMonthIso(), []);
  const { data: spendRows } = useQuery({
    queryKey: queryKeys.costsByAgent(companyId ?? "__none__", monthStart),
    queryFn: () => costsApi.byAgent(companyId!, monthStart),
    enabled: Boolean(companyId),
    refetchInterval: 60_000,
  });

  const floorIndex = floors.findIndex((f) => f.company.id === companyId);
  const runs: LiveRunForIssue[] = (floorIndex >= 0 ? floorRuns[floorIndex]?.data : undefined) ?? [];
  const workingIds = useMemo(() => workingAgentIdsFromRuns(runs), [runs]);

  const visible = useMemo(() => visibleTowerAgents(agents ?? []), [agents]);
  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of visible) m.set(a.id, a);
    return m;
  }, [visible]);
  const sceneAgents = useMemo(() => {
    const m = new Map<string, TowerSceneAgent>();
    for (const a of visible) m.set(a.id, { id: a.id, name: a.name, role: a.role, status: a.status });
    return m;
  }, [visible]);
  const layout = useMemo(() => buildTowerFloor(visible, workingIds), [visible, workingIds]);

  const spendByAgent = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of spendRows ?? []) m.set(row.agentId, row.costCents);
    return m;
  }, [spendRows]);

  const runByAgent = useMemo(() => {
    const m = new Map<string, LiveRunForIssue>();
    for (const r of runs) if (r.status === "running" && !m.has(r.agentId)) m.set(r.agentId, r);
    return m;
  }, [runs]);

  const selectedAgent = selectedAgentId ? agentMap.get(selectedAgentId) ?? null : null;
  const accent = selectedCompany?.brandColor || DEFAULT_ACCENT;
  const workingCount = visible.filter((a) => workingIds.has(a.id)).length;

  const onSelectAgent = useCallback((id: string) => setSelectedAgentId(id), []);
  const onKiosk = useCallback(() => setKioskOpen(true), []);

  if (!companyId) {
    return <EmptyState icon={Building2} message="Pick a company to open its floor." />;
  }
  if (agentsLoading && !agents) {
    return <PageSkeleton variant="org-chart" />;
  }

  return (
    <div
      className="tower-scene relative flex h-[calc(100dvh-9rem)] min-h-[420px] overflow-hidden rounded-md border border-border md:h-full md:min-h-0"
      data-testid="tower-page"
    >
      <style>{TOWER_SCENE_CSS}</style>

      {/* Elevator: one button per floor (company) */}
      <nav
        aria-label="Floors"
        className="z-10 flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-border bg-card/90 py-3"
      >
        <span className="text-[9px] uppercase tracking-widest text-muted-foreground" style={{ fontFamily: "Silkscreen, monospace" }}>
          Floor
        </span>
        {[...floors].reverse().map(({ company, number }) => {
          const i = floors.findIndex((f) => f.company.id === company.id);
          const working = workingAgentIdsFromRuns(floorRuns[i]?.data).size;
          const active = company.id === companyId;
          return (
            <button
              key={company.id}
              type="button"
              onClick={() => navigate(`/${company.issuePrefix}/tower`)}
              aria-current={active ? "page" : undefined}
              aria-label={`Floor ${number}: ${company.name}, ${working} working`}
              title={company.name}
              data-testid={`tower-floor-${company.issuePrefix}`}
              className={cn(
                "relative flex h-14 w-12 flex-col items-center justify-center gap-0.5 rounded-md border text-foreground transition-colors",
                active ? "border-primary bg-accent" : "border-border bg-background hover:border-primary/60",
              )}
            >
              <span
                className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded"
                style={{ backgroundColor: company.brandColor || DEFAULT_ACCENT }}
              />
              <span className="text-sm font-bold" style={{ fontFamily: "Silkscreen, monospace" }}>{number}</span>
              <span className="text-[9px] text-muted-foreground" style={{ fontFamily: "Silkscreen, monospace" }}>
                {company.issuePrefix}
              </span>
              <span className="flex items-center gap-1 text-[9px]">
                <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: TOWER_STATUS_COLOR.working }} />
                {working}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="relative min-w-0 flex-1">
        {/* Top bar */}
        <div className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-3 bg-card/80 px-3 py-2 text-xs backdrop-blur-sm">
          <span className="font-semibold" style={{ fontFamily: "Silkscreen, monospace", color: accent }}>
            {selectedCompany?.name ?? "Company"}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: TOWER_STATUS_COLOR.working }} />
            working <b className="text-foreground tabular-nums">{workingCount}</b>
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: TOWER_STATUS_COLOR.idle }} />
            in the break room <b className="text-foreground tabular-nums">{visible.length - workingCount}</b>
          </span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
            <CircleHelp className="mr-1 h-3.5 w-3.5" /> What am I looking at?
          </Button>
        </div>

        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center pt-10">
            <EmptyState icon={Building2} message="Nobody works on this floor yet. Hire an agent to fill it." />
          </div>
        ) : (
          <div className="h-full w-full pt-10">
            <TowerScene
              layout={layout}
              agents={sceneAgents}
              workingIds={workingIds}
              selectedAgentId={selectedAgentId}
              accent={accent}
              onSelectAgent={onSelectAgent}
              onKiosk={onKiosk}
            />
          </div>
        )}

        {legendOpen ? <TowerLegend onClose={() => setLegendOpen(false)} /> : null}

        {kioskOpen ? (
          <div
            role="dialog"
            aria-label="Wind down"
            className="absolute bottom-3 left-3 z-20 max-w-sm rounded-md border border-border bg-card p-4 text-sm shadow-lg"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold">🌙 Wind down this floor</span>
              <Button variant="ghost" size="icon-sm" onClick={() => setKioskOpen(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-muted-foreground">
              Want this company to rest? Pause its agents on the Agents page. Paused agents stop taking new work until
              you resume them, and nothing they finished is lost.
            </p>
            <Button className="mt-3" size="sm" asChild>
              <Link to="/agents/active">Go to Agents</Link>
            </Button>
          </div>
        ) : null}
      </div>

      {selectedAgent ? (
        <div className="absolute inset-y-0 right-0 z-30 w-full sm:w-80 md:static md:z-auto md:shrink-0">
          <TowerAgentPanel
            companyId={companyId}
            agent={selectedAgent}
            boss={selectedAgent.reportsTo ? agentMap.get(selectedAgent.reportsTo) ?? null : null}
            run={runByAgent.get(selectedAgent.id) ?? null}
            spentThisMonthCents={spendRows ? spendByAgent.get(selectedAgent.id) ?? 0 : null}
            onClose={() => setSelectedAgentId(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

function TowerLegend({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="What am I looking at?"
      className="absolute right-3 top-12 z-20 w-[min(22rem,calc(100%-1.5rem))] rounded-md border border-border bg-card p-4 text-sm shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">What am I looking at?</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ul className="space-y-1.5 text-muted-foreground">
        <li>Each floor is one of your companies. Use the elevator on the left to switch floors.</li>
        <li>Rooms follow who reports to whom: a manager's room holds their team, and a team lead's room sits inside it.</li>
        <li>The small glass office at the back of a room is that manager's own desk.</li>
        <li>People at a desk are working on something right now. Everyone else waits in the break room.</li>
        <li>Click anyone to see what they're doing, what they've cost this month, or to give them a task.</li>
        <li>The 🌙 kiosk in the break room explains how to let a floor rest.</li>
      </ul>
      <div className="mt-3 space-y-1">
        {Object.entries(TOWER_STATE_WORDS).map(([key, w]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: TOWER_STATUS_COLOR[key] }} />
            <span className="text-foreground">{w.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
