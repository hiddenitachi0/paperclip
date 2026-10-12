import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateModelDirectoryEntry,
  LocalModelsSyncResult,
  ModelDirectoryEntry,
  ModelDirectorySettings,
} from "@paperclipai/shared";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { modelDirectoryApi } from "../api/modelDirectory";
import { queryKeys } from "../lib/queryKeys";
import { draftFromInstalled, isLoopbackAddress, localAddressIssue, resyncTargets } from "../lib/model-catalogue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpTip, MODEL_HELP } from "./ModelHelp";

/**
 * Settings > Models, the company's local model setup: the graphics card
 * memory of the computer that runs local models (only for "fits" advice;
 * "Not set" until someone enters it, never a guess), the address of the
 * company's model server (the default for new local models), and "Resync
 * local models", which asks the model server at each local address which
 * models are installed, marks the saved setups installed / not installed,
 * and offers to add installed models that have no saved setup yet.
 */

export function modelSettingsQueryKey(companyId: string) {
  return [...queryKeys.companies.modelDirectory(companyId), "settings"] as const;
}

/** The company's model settings (graphics card memory, model server address); undefined while loading. */
export function useModelDirectorySettings(companyId: string | null | undefined) {
  return useQuery({
    queryKey: modelSettingsQueryKey(companyId ?? ""),
    queryFn: () => modelDirectoryApi.getSettings(companyId!),
    enabled: Boolean(companyId),
    retry: false,
  });
}

/** "12" -> 12, "" -> null, "lots" -> NaN. A comma works as a decimal point. */
export function parseVram(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) && value >= 0 && value <= 1024 ? value : Number.NaN;
}

/** Common graphics card memory sizes, in GB, offered in the select. */
export const GPU_MEMORY_CHOICES = [4, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64, 80] as const;

/** The select's value for a saved size: "unset", "0" (no graphics card), a listed size, or "other". */
export function gpuSelectValue(saved: number | null | undefined): string {
  if (saved === null || saved === undefined) return "unset";
  if (saved === 0) return "0";
  return (GPU_MEMORY_CHOICES as readonly number[]).includes(saved) ? String(saved) : "other";
}

/** How a saved size reads: "Not set", "No graphics card (CPU only)", "12 GB". */
export function gpuMemoryText(saved: number | null | undefined): string {
  if (saved === null || saved === undefined) return "Not set";
  if (saved === 0) return "No graphics card (CPU only)";
  return `${saved} GB`;
}

export function GpuMemoryField({
  companyId,
  settings,
  canManage,
  onError,
}: {
  companyId: string;
  settings: ModelDirectorySettings | undefined;
  canManage: boolean;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const saved = settings?.localGpuVramGb ?? null;
  const [choice, setChoice] = useState(gpuSelectValue(saved));
  const [custom, setCustom] = useState(choice === "other" && saved !== null ? String(saved) : "");
  useEffect(() => {
    const next = gpuSelectValue(saved);
    setChoice(next);
    if (next === "other" && saved !== null) setCustom(String(saved));
  }, [saved]);
  const mutation = useMutation({
    mutationFn: (localGpuVramGb: number | null) => modelDirectoryApi.updateSettings(companyId, { localGpuVramGb }),
    onSuccess: (next) => queryClient.setQueryData(modelSettingsQueryKey(companyId), next),
    onError,
  });
  const customValue = parseVram(custom);
  const customBad = choice === "other" && (Number.isNaN(customValue) || customValue === 0);
  const saveCustom = () => {
    if (customBad || customValue === null || customValue === saved) return;
    mutation.mutate(customValue);
  };

  const label = (
    <span className="inline-flex items-center gap-1">
      Graphics card memory
      <HelpTip topic="graphics card memory" text={MODEL_HELP.gpu} />
    </span>
  );
  if (!canManage) {
    return (
      <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="models-gpu-readonly">
        {label}: <span className="text-foreground">{gpuMemoryText(saved)}</span>
      </div>
    );
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="models-gpu">
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor="models-gpu-select" className="inline-flex items-center gap-1">
          {label}
        </label>
        <select
          id="models-gpu-select"
          className="h-7 rounded-md border border-border bg-transparent px-1.5 text-sm text-foreground outline-none"
          value={choice}
          disabled={mutation.isPending}
          onChange={(event) => {
            const next = event.target.value;
            setChoice(next);
            if (next === "other") return; // saved once a number is typed
            const value = next === "unset" ? null : Number(next);
            if (value !== saved) mutation.mutate(value);
          }}
          data-testid="models-gpu-select"
        >
          <option value="unset">Not set</option>
          <option value="0">No graphics card / CPU only</option>
          {GPU_MEMORY_CHOICES.map((size) => (
            <option key={size} value={String(size)}>
              {size} GB
            </option>
          ))}
          <option value="other">Other…</option>
        </select>
        {choice === "other" && (
          <>
            <Input
              className="h-7 w-20 px-1.5 text-center text-sm"
              inputMode="decimal"
              value={custom}
              placeholder="GB"
              aria-label="Graphics card memory in GB"
              aria-invalid={customBad || undefined}
              disabled={mutation.isPending}
              onChange={(event) => setCustom(event.target.value)}
              onBlur={saveCustom}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCustom();
              }}
              data-testid="models-gpu-input"
            />
            GB
          </>
        )}
        {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {customBad && custom.trim() !== "" && (
        <p className="text-destructive">Type the memory in GB as a number above 0, like 11 or 7.5.</p>
      )}
      <p>Only used to say which model sizes fit. Saved for this company.</p>
    </div>
  );
}

export function LocalAddressField({
  companyId,
  settings,
  canManage,
  onError,
}: {
  companyId: string;
  settings: ModelDirectorySettings | undefined;
  canManage: boolean;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const saved = settings?.localBaseUrl ?? null;
  const [text, setText] = useState(saved ?? "");
  useEffect(() => setText(saved ?? ""), [saved]);
  const mutation = useMutation({
    mutationFn: (localBaseUrl: string | null) => modelDirectoryApi.updateSettings(companyId, { localBaseUrl }),
    onSuccess: (next) => queryClient.setQueryData(modelSettingsQueryKey(companyId), next),
    onError,
  });
  const issue = localAddressIssue(text);
  const save = () => {
    const value = text.trim() ? text.trim() : null;
    if (issue || value === saved) return;
    mutation.mutate(value);
  };
  const label = (
    <span className="inline-flex items-center gap-1">
      Model server address
      <HelpTip topic="the model server address" text={MODEL_HELP.address} />
    </span>
  );
  if (!canManage) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="models-address-readonly">
        {label}: {saved ? <code className="font-mono text-foreground">{saved}</code> : <span className="text-foreground">Not set</span>}
      </div>
    );
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="models-address">
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor="models-address-input" className="inline-flex items-center gap-1">
          {label}
        </label>
        <Input
          id="models-address-input"
          className="h-7 w-72 max-w-full px-1.5 font-mono text-sm"
          value={text}
          placeholder="http://192.168.1.20:11434/v1"
          aria-invalid={issue ? true : undefined}
          disabled={mutation.isPending}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
          data-testid="models-address-input"
        />
        {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {issue ? (
        <p className="text-destructive" data-testid="models-address-issue">
          {issue}
        </p>
      ) : isLoopbackAddress(text) ? (
        <p className="text-amber-700 dark:text-amber-400" data-testid="models-address-loopback">
          This points at Paperclip's own server. Use it only if the models really run on that same machine; otherwise
          type the address of the computer that runs them.
        </p>
      ) : null}
      <p>
        The computer that runs Ollama or another OpenAI-compatible model server, as Paperclip's server reaches it.
        New local models start from this address.
      </p>
    </div>
  );
}

export interface SyncOutcome {
  baseUrl: string;
  result?: LocalModelsSyncResult;
  error?: string;
}

/**
 * Runs the resync for the company's model server address and every local
 * address in use. With none of them there is nothing to ask: the page asks
 * for the model server address instead (see NEEDS_ADDRESS_FOR_RESYNC).
 */
export function useLocalResync(
  companyId: string,
  entries: readonly ModelDirectoryEntry[],
  localBaseUrl: string | null | undefined,
  describeError: (error: unknown) => string,
  onDone: () => void,
) {
  const targets = resyncTargets(localBaseUrl, entries);
  return useMutation({
    mutationFn: async (): Promise<SyncOutcome[]> => {
      const outcomes: SyncOutcome[] = [];
      for (const baseUrl of targets) {
        try {
          outcomes.push({ baseUrl, result: await modelDirectoryApi.syncLocal(companyId, baseUrl) });
        } catch (error) {
          outcomes.push({ baseUrl, error: describeError(error) });
        }
      }
      return outcomes;
    },
    onSuccess: onDone,
  });
}

/** Shown instead of resyncing when the company has no local address at all. */
export const NEEDS_ADDRESS_FOR_RESYNC =
  "Set the model server address above first, so Paperclip knows where to ask which models are installed.";

export function ResyncButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={onClick}
        title="Ask this company's model server which models are installed, and update the list"
        data-testid="models-resync"
      >
        {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
        Resync local models
      </Button>
      <HelpTip topic="resync local models" text={MODEL_HELP.resync} />
    </span>
  );
}

function names(ids: readonly string[], byId: ReadonlyMap<string, ModelDirectoryEntry>): string {
  return ids.map((id) => byId.get(id)?.name ?? "a removed setup").join(", ");
}

export function LocalSyncResults({
  outcomes,
  entries,
  canManage,
  gpuVramGb,
  onAdd,
  onClose,
}: {
  outcomes: readonly SyncOutcome[];
  entries: readonly ModelDirectoryEntry[];
  canManage: boolean;
  gpuVramGb: number | null;
  onAdd: (draft: CreateModelDirectoryEntry) => void;
  onClose: () => void;
}) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="models-resync-result">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">Models installed on this company's model server</p>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {outcomes.map((outcome) => (
        <div key={outcome.baseUrl} className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Asked the model server at <code className="font-mono">{outcome.baseUrl}</code>
            {outcome.result ? ` at ${new Date(outcome.result.checkedAt).toLocaleTimeString()}.` : "."}
          </p>
          {outcome.error ? (
            <p className="text-destructive" data-testid="models-resync-error">
              {outcome.error}
            </p>
          ) : outcome.result ? (
            <>
              {outcome.result.installed.length === 0 ? (
                <p>No models are installed there.</p>
              ) : (
                <ul className="space-y-1">
                  {outcome.result.installed.map((model) => (
                    <li
                      key={model.name}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1"
                      data-testid={`models-installed-${model.name}`}
                    >
                      <span className="min-w-0">
                        <code className="font-mono text-foreground">{model.name}</code>
                        <span className="text-muted-foreground">
                          {[
                            model.parameterSize,
                            model.quantization,
                            typeof model.sizeGb === "number" ? `${Math.round(model.sizeGb * 10) / 10} GB` : null,
                          ]
                            .filter(Boolean)
                            .map((part) => ` · ${part}`)
                            .join("")}
                        </span>
                        {model.entryIds.length > 0 && (
                          <span className="text-muted-foreground"> · saved as {names(model.entryIds, byId)}</span>
                        )}
                      </span>
                      {model.entryIds.length === 0 &&
                        (canManage ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => onAdd(draftFromInstalled(model, outcome.baseUrl, { gpuVramGb }))}
                          >
                            <Plus /> Add
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">not saved</span>
                        ))}
                    </li>
                  ))}
                </ul>
              )}
              {outcome.result.markedInstalledEntryIds.length > 0 && (
                <p data-testid="models-resync-marked-installed">
                  Marked as installed: {names(outcome.result.markedInstalledEntryIds, byId)}
                </p>
              )}
              {outcome.result.missingEntryIds.length > 0 && (
                <p data-testid="models-resync-missing">
                  Not installed any more (now marked planned): {names(outcome.result.missingEntryIds, byId)}
                </p>
              )}
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
