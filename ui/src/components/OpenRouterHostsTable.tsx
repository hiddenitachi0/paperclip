import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  isOpenRouterModelId,
  openRouterHostsAllowed,
  openRouterNoToolHostWarning,
  parseLaneAProviderSlugList,
  type LaneAProviderRouting,
  type OpenRouterHost,
  type OpenRouterHostChoice,
  type OpenRouterHostRules,
} from "@paperclipai/shared";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { modelDirectoryApi } from "../api/modelDirectory";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { formatContextTokens } from "../lib/model-catalogue";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";

/**
 * "Hosts for this model" (OpenRouter only): every host that runs the model,
 * read live from OpenRouter, with its price, context, quantisation and what it
 * supports FOR THIS MODEL (tool support differs per model and per host). Per
 * host a three-way choice: Use (only these), Never, or Default (the company's
 * host rules decide). Used by the Saved model dialog and the quick-agent card.
 */

export function openRouterHostsQueryKey(companyId: string, model: string) {
  return [...queryKeys.companies.modelDirectory(companyId), "openrouter-hosts", model.trim()] as const;
}

/** The live host list for one OpenRouter model; disabled for an id that is not "maker/model". */
export function useOpenRouterHosts(companyId: string | null | undefined, model: string, enabled = true) {
  const id = model.trim();
  return useQuery({
    queryKey: openRouterHostsQueryKey(companyId ?? "", id),
    queryFn: () => modelDirectoryApi.openrouterHosts(companyId!, id),
    enabled: enabled && Boolean(companyId) && isOpenRouterModelId(id),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

/** Per-host choices from the two typed lists ("Use only" and "Never"). */
export function hostChoicesFromText(useText: string | undefined, neverText: string | undefined) {
  const out: Record<string, OpenRouterHostChoice> = {};
  for (const slug of parseLaneAProviderSlugList(neverText ?? "").slugs) out[slug] = "never";
  for (const slug of parseLaneAProviderSlugList(useText ?? "").slugs) out[slug] = "use";
  return out;
}

/** The two typed lists after one host's choice changes (other hosts keep their place). */
export function hostTextsWithChoice(
  useText: string | undefined,
  neverText: string | undefined,
  slug: string,
  choice: OpenRouterHostChoice,
): { use: string; never: string } {
  const use = parseLaneAProviderSlugList(useText ?? "").slugs.filter((s) => s !== slug);
  const never = parseLaneAProviderSlugList(neverText ?? "").slugs.filter((s) => s !== slug);
  if (choice === "use") use.push(slug);
  if (choice === "never") never.push(slug);
  return { use: use.join(", "), never: never.join(", ") };
}

/** One row per host: a host can list several endpoints (e.g. two quantisations); they are shown together. */
export function mergeHostsBySlug(hosts: readonly OpenRouterHost[]): OpenRouterHost[] {
  const out: OpenRouterHost[] = [];
  for (const host of hosts) {
    const seen = out.find((row) => row.slug === host.slug);
    if (!seen) {
      out.push({ ...host });
      continue;
    }
    const min = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
    const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
    seen.quantization = [...new Set([seen.quantization, host.quantization].filter(Boolean))].join(", ") || null;
    seen.priceInPerM = min(seen.priceInPerM, host.priceInPerM);
    seen.priceOutPerM = min(seen.priceOutPerM, host.priceOutPerM);
    seen.contextTokens = max(seen.contextTokens, host.contextTokens);
    seen.maxOutputTokens = max(seen.maxOutputTokens, host.maxOutputTokens);
    seen.supportsTools ||= host.supportsTools;
    seen.supportsToolChoice ||= host.supportsToolChoice;
    seen.supportsReasoning ||= host.supportsReasoning;
    seen.supportsImages ||= host.supportsImages;
    if (host.status === "degraded") seen.status = "degraded";
  }
  return out;
}

function price(value: number | null): string {
  if (value === null) return "?";
  if (value === 0) return "free";
  return `$${value < 0.1 ? value.toFixed(3).replace(/0+$/, "") : value.toFixed(2)}`;
}

export function hostsErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only the company owner or an admin can see the host list.";
    return error.message;
  }
  return "Could not read the host list from OpenRouter just now.";
}

function Chip({ on, label, title }: { on: boolean; label: string; title: string }) {
  return (
    <span
      title={title}
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[11px] leading-none",
        on ? "border-green-600/40 text-green-700 dark:text-green-400" : "border-border text-muted-foreground/60 line-through",
      )}
    >
      {label}
    </span>
  );
}

export function OpenRouterHostsTable({
  hosts,
  loading,
  error,
  choices,
  onChoice,
  rules,
  routing,
  readOnly = false,
  onRefresh,
  refreshing = false,
  changeNote,
  checkedAt,
}: {
  hosts: readonly OpenRouterHost[] | undefined;
  loading: boolean;
  error: unknown;
  /** The explicit per-host choices; a host not listed is "default". */
  choices: Readonly<Record<string, OpenRouterHostChoice>>;
  onChoice?: (slug: string, choice: OpenRouterHostChoice) => void;
  /** The company's preferred / blocked hosts (Settings > Models). */
  rules?: OpenRouterHostRules | null;
  /** The routing these choices save as, after the company rules: decides "Used" / "Not used". */
  routing: LaneAProviderRouting | null;
  readOnly?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** "What changed since last time", after a refresh. */
  changeNote?: string | null;
  /** When the list was read (ISO). */
  checkedAt?: string | null;
}) {
  const [hideNoTools, setHideNoTools] = useState(false);
  const rows = useMemo(() => mergeHostsBySlug(hosts ?? []), [hosts]);
  const allowed = useMemo(() => new Set(openRouterHostsAllowed(routing, rows).map((host) => host.slug)), [routing, rows]);
  const shown = hideNoTools ? rows.filter((host) => host.supportsTools) : rows;
  const warning = openRouterNoToolHostWarning(routing, rows);
  const preferred = rules?.preferred ?? [];
  const blocked = rules?.blocked ?? [];
  const noTools = rows.filter((host) => !host.supportsTools).length;

  return (
    <div className="space-y-2" data-testid="openrouter-hosts-table">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Hosts are the companies that actually run this model for OpenRouter. What each supports differs per model, so
          this list is read live from OpenRouter for this model.
          {checkedAt ? ` Checked ${new Date(checkedAt).toLocaleString()}.` : ""}
        </p>
        {onRefresh && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onRefresh}
            disabled={refreshing || loading}
            data-testid="openrouter-hosts-refresh"
          >
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh hosts
          </Button>
        )}
      </div>
      {changeNote && (
        <p className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs" data-testid="openrouter-hosts-change">
          What changed since last time: {changeNote}
        </p>
      )}
      {loading ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking OpenRouter which hosts run this model…
        </p>
      ) : error ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="openrouter-hosts-error">
          {hostsErrorText(error)} You can still type host names below.
        </p>
      ) : hosts === undefined ? (
        <p className="text-xs text-muted-foreground" data-testid="openrouter-hosts-need-model">
          Pick or type an OpenRouter model id (maker/model) to see which hosts run it.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">OpenRouter lists no host for this model right now.</p>
      ) : (
        <>
          {noTools > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <ToggleSwitch
                checked={hideNoTools}
                onCheckedChange={setHideNoTools}
                aria-label="Hide hosts without tool support"
                data-testid="openrouter-hosts-hide-no-tools"
              />
              Hide hosts without tool support ({noTools} of {rows.length})
            </label>
          )}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[34rem] text-xs">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">Host</th>
                  <th className="px-2 py-1 font-medium" title="US dollars per million tokens sent in / written out">
                    Price in / out (per million)
                  </th>
                  <th className="px-2 py-1 font-medium">Context</th>
                  <th className="px-2 py-1 font-medium" title="How much the model is shrunk on this host">
                    Quantisation
                  </th>
                  <th className="px-2 py-1 font-medium">Supports</th>
                  <th className="px-2 py-1 font-medium">Choice</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((host) => {
                  const choice = choices[host.slug] ?? "default";
                  const companyNote = preferred.includes(host.slug)
                    ? "Company prefers"
                    : blocked.includes(host.slug)
                      ? "Company blocks"
                      : null;
                  return (
                    <tr
                      key={host.slug}
                      className={cn("border-t border-border align-top", !host.supportsTools && "bg-amber-500/5")}
                      data-testid={`openrouter-host-row-${host.slug}`}
                    >
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-foreground">{host.name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{host.slug}</div>
                        {!host.supportsTools && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-400" data-testid={`openrouter-host-no-tools-${host.slug}`}>
                            No tool support for this model
                          </div>
                        )}
                        {host.status === "degraded" && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-400">OpenRouter reports problems</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {price(host.priceInPerM)} / {price(host.priceOutPerM)}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {host.contextTokens ? formatContextTokens(host.contextTokens) : "?"}
                      </td>
                      <td className="px-2 py-1.5">{host.quantization ?? "not said"}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          <Chip on={host.supportsTools} label="Tools" title="Passes tools to the model: pictures, weather, hand-overs and other actions work" />
                          <Chip on={host.supportsToolChoice} label="Forced tool" title="Can make the model use one specific tool (used for one retry when a tool call goes wrong)" />
                          <Chip on={host.supportsImages} label="Pictures in" title="The model can look at pictures you send it" />
                          <Chip on={host.supportsReasoning} label="Reasoning" title="Thinking can be switched on or off" />
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        {readOnly || !onChoice ? (
                          <span>{choice === "use" ? "Use" : choice === "never" ? "Never" : "Default"}</span>
                        ) : (
                          <select
                            aria-label={`Use ${host.name}?`}
                            className="rounded-md border border-border bg-transparent px-1.5 py-1 text-xs outline-none"
                            value={choice}
                            onChange={(event) => onChoice(host.slug, event.target.value as OpenRouterHostChoice)}
                            data-testid={`openrouter-host-choice-${host.slug}`}
                          >
                            <option value="default">Default</option>
                            <option value="use">Use</option>
                            <option value="never">Never</option>
                          </select>
                        )}
                        {companyNote && choice === "default" && (
                          <div className="pt-0.5 text-[11px] text-muted-foreground">{companyNote}</div>
                        )}
                        <div
                          className={cn("pt-0.5 text-[11px]", allowed.has(host.slug) ? "text-green-700 dark:text-green-400" : "text-muted-foreground")}
                          data-testid={`openrouter-host-result-${host.slug}`}
                        >
                          {allowed.has(host.slug) ? "May be used" : "Not used"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Use = only the hosts marked Use are used. Never = this host is never used. Default = the company's host
            rules decide (Settings &gt; Models &gt; OpenRouter hosts); with no rule, OpenRouter picks among the hosts
            that are not marked Never. When a quick agent offers tools, OpenRouter only sends the request to a host
            that supports them.
          </p>
        </>
      )}
      {warning && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="openrouter-hosts-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {warning}
        </p>
      )}
    </div>
  );
}
