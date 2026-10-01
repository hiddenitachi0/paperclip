import { useEffect, useRef } from "react";
import { useDeployRunnerStatusStream } from "../hooks/useDeployRunnerStatusStream";
import type { DeployRunnerStatusEntry } from "../api/deployRunner";

/**
 * DUR-4235: live tail of scripts/deploy-runner.sh's activity for one deploy
 * approval, via GET .../deploy-runner/status/stream (SSE). The deploy
 * runner's raw deploy-runner.log never reaches the UI -- it is host-only
 * (the runner script runs outside any container) -- this shows the same
 * company-scoped, already-curated operator-facing lines the runner mirrors
 * onto the approval's own comments and status.jsonl.
 */
export function DeployRunnerLogViewer({
  companyId,
  approvalId,
  active,
}: {
  companyId: string;
  approvalId: string;
  active: boolean;
}) {
  const { entries, connecting, connected, error } = useDeployRunnerStatusStream(companyId, {
    approvalId,
    enabled: active,
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (!active) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Deploy log</h3>
        {connected ? (
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-cyan-400" />
            </span>
            <span className="text-xs text-cyan-400">Live</span>
          </div>
        ) : connecting ? (
          <span className="text-xs text-muted-foreground">Connecting…</span>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        data-testid="deploy-log-viewer"
        className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto space-y-0.5"
      >
        {entries.length === 0 ? (
          <div className="text-muted-foreground">Waiting for the deploy runner…</div>
        ) : (
          entries.map((entry, i) => <LogLine key={`${entry.ts}-${i}`} entry={entry} />)
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </div>
  );
}

function LogLine({ entry }: { entry: DeployRunnerStatusEntry }) {
  const tone =
    entry.outcome === "failed" || /\bfailed\b/i.test(entry.body)
      ? "text-red-400"
      : !entry.commentDelivered
        ? "text-yellow-400"
        : entry.outcome === "carried" || entry.outcome === "started"
          ? "text-blue-300"
          : "text-foreground";
  const time = new Date(entry.ts).toLocaleTimeString();
  return (
    <div className={tone}>
      [{time}] {entry.body}
    </div>
  );
}
