import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, XCircle } from "lucide-react";
import {
  MODEL_PICKER_MODELS_PAGE,
  modelPickerReadiness,
  modelReadinessSummary,
  readinessHealthReading,
  readinessSetupFromDirectoryEntry,
  type ModelKeyState,
  type ModelPickerReadiness,
  type ModelReadinessContext,
  type LaneASetupCheckResult,
  type LaneASetupCheckTarget,
  type ModelDirectoryEntry,
  type ModelDirectoryEntryHealth,
  type ModelHealthReport,
  type ModelSetupForReadiness,
  type AgentModelHealth,
  type ModelLastCheck,
  type ModelOptionStatus,
  type ModelReadinessLine,
  type ModelReadinessStatus,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApiError } from "../api/client";
import { laneAApi } from "../api/laneA";
import { modelDirectoryApi } from "../api/modelDirectory";
import { queryKeys } from "../lib/queryKeys";
import { useModelDirectorySettings } from "./ModelLocalSync";

/**
 * Model readiness on the page: the checklist (green / amber / red / grey
 * lines with a plain reason and a fix link), the one-line status under a
 * model picker, the "Refresh status" action that asks the company's model
 * server what is installed, and "Check this setup" (one tiny real call).
 * The lines themselves come from modelReadiness() in @paperclipai/shared.
 */

const TONE_CLASS: Record<ModelReadinessStatus, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-destructive",
  unknown: "text-muted-foreground",
};

const STATUS_WORD: Record<ModelReadinessStatus, string> = { ok: "OK", warn: "Check", fail: "Problem", unknown: "Not known" };

function StatusIcon({ status, className }: { status: ModelReadinessStatus; className?: string }) {
  const Icon = status === "ok" ? CheckCircle2 : status === "warn" ? AlertTriangle : status === "fail" ? XCircle : CircleHelp;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", TONE_CLASS[status], className)} aria-label={STATUS_WORD[status]} />;
}

/** The checklist itself. */
export function ReadinessLines({ lines, testId }: { lines: readonly ModelReadinessLine[]; testId?: string }) {
  return (
    <ul className="space-y-1" data-testid={testId}>
      {lines.map((line) => (
        <li key={line.id} className="flex items-start gap-1.5 text-xs" data-testid={testId ? `${testId}-${line.id}` : undefined} data-status={line.status}>
          <StatusIcon status={line.status} className="mt-0.5" />
          <span>
            <span className="font-medium">{line.label}:</span> <span className="text-muted-foreground">{line.reason}</span>
            {line.fix && (
              <>
                {" "}
                <Link to={line.fix.href} className="underline">
                  {line.fix.label}
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A small "Ready?" chip that opens the checklist (Settings > Models). */
export function ReadyBadge({ lines, testId }: { lines: readonly ModelReadinessLine[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  const summary = modelReadinessSummary(lines);
  return (
    <span className="contents">
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0 text-[11px] leading-5",
          summary.status === "ok" && "border-emerald-500/50",
          summary.status === "warn" && "border-amber-500/50",
          summary.status === "fail" && "border-destructive/50",
        )}
        aria-expanded={open}
        title="Is everything in place for this model? Worked out from what Paperclip already knows; no model is called."
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
        data-status={summary.status}
      >
        <StatusIcon status={summary.status} className="h-3 w-3" />
        Ready? {summary.label}
      </button>
      {open && (
        <span className="block w-full basis-full pt-1">
          <ReadinessLines lines={lines} testId={testId ? `${testId}-lines` : undefined} />
        </span>
      )}
    </span>
  );
}

/**
 * @deprecated Use ModelPickerNotice with modelPickerReadiness(). Kept so
 * branches that still use it keep building.
 */
export function ModelStatusLine({ status, prefix, testId }: { status: ModelOptionStatus; prefix?: string; testId?: string }) {
  return (
    <span className="flex items-start gap-1.5 text-xs" data-testid={testId} data-kind={status.kind}>
      <StatusIcon status={status.tone} className="mt-0.5" />
      <span>
        {prefix && <span className="text-muted-foreground">{prefix} </span>}
        <span className={cn("font-medium", TONE_CLASS[status.tone])}>{status.label}.</span>{" "}
        <span className="text-muted-foreground">{status.detail}</span>
      </span>
    </span>
  );
}

/** @deprecated Use modelPickerOptionText() with modelPickerReadiness() from @paperclipai/shared. */
export function optionTextWithStatus(label: string, status: ModelOptionStatus | null | undefined): string {
  return status ? `${label} [${status.label}]` : label;
}

/** A saved model as the readiness helpers see it. */
export function setupFromEntry(entry: ModelDirectoryEntry): ModelSetupForReadiness {
  return readinessSetupFromDirectoryEntry(entry);
}

/** A stored health report as the readiness helpers take it; "not checked" counts as no reading. */
export function healthReading(report: Pick<ModelHealthReport, "status" | "lastCheckedAt"> | null | undefined) {
  return readinessHealthReading(report);
}

export function modelHealthQueryKey(companyId: string) {
  return [...queryKeys.companies.modelDirectory(companyId), "health"] as const;
}

/**
 * What the readiness lines need from the company: its model settings (model
 * server address, graphics card memory, blocked hosts) and the last
 * model-server readings, plus "Refresh status" (asks each model server
 * involved what is installed, then reads the readings again). Both reads are
 * owner/admin only on the server; for anyone else they stay empty and the
 * lines say "not known".
 */
export function useModelReadinessSources(companyId: string | null | undefined, enabled = true) {
  const queryClient = useQueryClient();
  const settingsQuery = useModelDirectorySettings(enabled ? companyId : null);
  const healthQuery = useQuery({
    queryKey: modelHealthQueryKey(companyId ?? ""),
    queryFn: () => modelDirectoryApi.health(companyId!),
    enabled: enabled && Boolean(companyId),
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: async (addresses: readonly string[]) => {
      const seen = new Set<string>();
      const results: Array<{ baseUrl: string; ok: boolean; message: string }> = [];
      for (const raw of addresses) {
        const baseUrl = raw.trim();
        const key = baseUrl.toLowerCase().replace(/\/+$/, "").replace(/\/v1$/, "");
        if (!baseUrl || seen.has(key)) continue;
        seen.add(key);
        try {
          const result = await modelDirectoryApi.syncLocal(companyId!, baseUrl);
          results.push({ baseUrl, ok: true, message: `${result.baseUrl}: ${result.installed.length} model${result.installed.length === 1 ? "" : "s"} installed.` });
        } catch (err) {
          results.push({ baseUrl, ok: false, message: err instanceof ApiError ? err.message : `Could not ask ${baseUrl}.` });
        }
      }
      return results;
    },
    onSettled: () => {
      if (companyId) void queryClient.invalidateQueries({ queryKey: queryKeys.companies.modelDirectory(companyId) });
    },
  });
  const healthByEntryId = useMemo(
    () => new Map<string, ModelDirectoryEntryHealth>((healthQuery.data?.entries ?? []).map((h) => [h.entryId, h])),
    [healthQuery.data],
  );
  const healthByAgentId = useMemo(
    () => new Map<string, AgentModelHealth>((healthQuery.data?.agents ?? []).map((h) => [h.agentId, h])),
    [healthQuery.data],
  );
  return { settings: settingsQuery.data ?? null, healthByEntryId, healthByAgentId, refresh };
}

/** "Refresh status": asks the model server(s) what is installed. */
export function RefreshStatusButton({
  addresses,
  refresh,
  disabled,
  testId,
}: {
  addresses: readonly string[];
  refresh: ReturnType<typeof useModelReadinessSources>["refresh"];
  disabled?: boolean;
  testId?: string;
}) {
  if (addresses.length === 0) return null;
  return (
    <span className="block space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || refresh.isPending}
        onClick={() => refresh.mutate(addresses)}
        data-testid={testId}
        title="Ask the computer that runs your local models which models it has installed. Free; no model is run."
      >
        <RefreshCw className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")} /> {refresh.isPending ? "Asking the model server…" : "Refresh status"}
      </Button>
      {refresh.data?.map((r) => (
        <span key={r.baseUrl} className={cn("block text-xs", r.ok ? "text-muted-foreground" : "text-destructive")} data-testid={testId ? `${testId}-result` : undefined}>
          {r.message}
        </span>
      ))}
    </span>
  );
}

export function lastCheckFromResult(result: LaneASetupCheckResult): ModelLastCheck {
  return {
    ok: result.ok,
    checkedAt: result.checkedAt,
    toolCalling: result.toolCalling,
    thinkingAccepted: result.thinkingAccepted,
    summary: result.summary,
  };
}

/**
 * "Check this setup": an optional instant pre-check line (settings only),
 * then one tiny real call through exactly the path a chat would take. Only
 * the company's owner or admin can run it (it costs a fraction of a cent).
 */
export function SetupCheck({
  agentId,
  companyId,
  target,
  canCheck,
  preCheck,
  blockedReason,
  onResult,
  testId,
}: {
  agentId: string;
  companyId: string;
  target: LaneASetupCheckTarget;
  canCheck: boolean;
  /** Instant settings check; a failed one stops the real call. */
  preCheck?: () => { ok: boolean; text: string };
  /** Why the real call cannot run right now (for example unsaved changes). */
  blockedReason?: string | null;
  onResult?: (result: LaneASetupCheckResult) => void;
  testId: string;
}) {
  const [pre, setPre] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => laneAApi.checkSetup(agentId, { companyId, target }),
    onSuccess: (result) => onResult?.(result),
  });
  const run = () => {
    setNote(null);
    check.reset();
    const first = preCheck ? preCheck() : null;
    setPre(first);
    if (first && !first.ok) return;
    if (blockedReason) {
      setNote(blockedReason);
      return;
    }
    if (!canCheck) {
      setNote("Only a company owner or admin can run a real check (it sends one tiny message, which costs a fraction of a cent).");
      return;
    }
    check.mutate();
  };
  const result = check.data;
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={check.isPending} onClick={run} data-testid={`${testId}-button`}>
          {check.isPending ? "Checking…" : "Check this setup"}
        </Button>
        <span className="text-xs text-muted-foreground">Sends one tiny test message and one test tool call, as a real chat would.</span>
      </div>
      {pre && (
        <p className={cn("text-xs", pre.ok ? "text-muted-foreground" : "text-destructive")} role="status" data-testid={`${testId}-precheck`}>
          Settings: {pre.text}
        </p>
      )}
      {note && (
        <p className="text-xs text-muted-foreground" role="status" data-testid={`${testId}-note`}>
          {note}
        </p>
      )}
      {check.isError && (
        <p className="text-xs text-destructive" role="alert" data-testid={`${testId}-error`}>
          {check.error instanceof ApiError ? check.error.message : "The check could not be run."}
        </p>
      )}
      {result && (
        <div className="space-y-1" role="status" data-testid={`${testId}-result`} data-ok={result.ok ? "true" : "false"}>
          <p className={cn("text-xs font-medium", result.ok ? TONE_CLASS.ok : TONE_CLASS.fail)}>{result.summary}</p>
          <ul className="space-y-0.5">
            {result.steps.map((step, index) => (
              <li key={`${step.id}-${index}`} className="flex items-start gap-1.5 text-xs" data-testid={`${testId}-step-${step.id}`}>
                <StatusIcon status={step.ok === true ? "ok" : step.ok === false ? "fail" : "unknown"} className="mt-0.5" />
                <span className="text-muted-foreground">{step.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Readiness for every saved model in a picker, from data Paperclip already
 * has (the company's model settings and the last model-server readings,
 * both cached by react-query): opening a dropdown never calls anything.
 * `keyState` says whether the agent the picker belongs to has the key a
 * hosted model needs; leave it out where no agent is involved.
 *
 * Usage (any picker):
 *   const { readinessOf } = useSavedModelPickerReadiness(companyId);
 *   const groups = pickerGroups(entries, undefined, (e) => readinessOf(byId.get(e.id)!));
 *   <option>{modelPickerOptionText(option.label, option.readiness)}</option>
 *   <ModelPickerNotice readiness={readinessOf(selected)} />
 */
export function useSavedModelPickerReadiness(
  companyId: string | null | undefined,
  options: { enabled?: boolean; keyState?: (entry: ModelDirectoryEntry) => ModelKeyState | undefined } = {},
) {
  const sources = useModelReadinessSources(companyId, options.enabled ?? true);
  const { settings, healthByEntryId } = sources;
  const keyState = options.keyState;
  const readinessOf = useCallback(
    (entry: ModelDirectoryEntry, extra: Partial<ModelReadinessContext> = {}): ModelPickerReadiness =>
      modelPickerReadiness(setupFromEntry(entry), {
        companyLocalBaseUrl: settings?.localBaseUrl ?? null,
        gpuVramGb: settings?.localGpuVramGb ?? null,
        blockedHosts: settings?.openrouterBlockedHosts ?? [],
        key: keyState?.(entry),
        health: healthReading(healthByEntryId.get(entry.id)),
        ...extra,
      }),
    [settings, healthByEntryId, keyState],
  );
  return { readinessOf, sources };
}

/**
 * The one line under a model picker. Not ready: what is wrong and what to do,
 * with a link to the Models page (and Connections for a key). Ready: nothing,
 * or a quiet "Ready" line when `showWhenReady`.
 */
export function ModelPickerNotice({
  readiness,
  prefix,
  showWhenReady = false,
  testId,
}: {
  readiness: ModelPickerReadiness | null | undefined;
  /** For example "The model it uses now:". */
  prefix?: string;
  showWhenReady?: boolean;
  testId?: string;
}) {
  if (!readiness) return null;
  if (readiness.ready || !readiness.warning) {
    if (!showWhenReady) return null;
    return (
      <span className="flex items-start gap-1.5 text-xs" data-testid={testId} data-kind={readiness.kind} data-ready="true">
        <StatusIcon status={readiness.tone} className="mt-0.5" />
        <span>
          {prefix && <span className="text-muted-foreground">{prefix} </span>}
          <span className={cn("font-medium", TONE_CLASS[readiness.tone])}>{readiness.ready ? "Ready." : readiness.badge.replace(/^\S+\s/, "") + "."}</span>{" "}
          <span className="text-muted-foreground">{readiness.detail}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5 text-xs" role="status" data-testid={testId} data-kind={readiness.kind} data-ready="false">
      <StatusIcon status={readiness.tone} className="mt-0.5" />
      <span>
        {prefix && <span className="text-muted-foreground">{prefix} </span>}
        <span className={cn("font-medium", TONE_CLASS[readiness.tone])}>{readiness.badge.replace(/^\S+\s/, "")}.</span>{" "}
        <span className="text-muted-foreground">{readiness.warning}</span>{" "}
        {readiness.fix && (
          <>
            <Link to={readiness.fix.href} className="underline">
              {readiness.fix.label}
            </Link>
            {" · "}
          </>
        )}
        <Link to={MODEL_PICKER_MODELS_PAGE} className="underline">
          Open the Models page
        </Link>
      </span>
    </span>
  );
}
