import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
  type CreateModelDirectoryEntry,
  type LocalModelsSyncResult,
  type ModelDirectoryEntry,
  type ModelDirectorySettings,
} from "@paperclipai/shared";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { modelDirectoryApi } from "../api/modelDirectory";
import { queryKeys } from "../lib/queryKeys";
import { draftFromInstalled, localAddressesInUse } from "../lib/model-catalogue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Settings > Models, "your PC": the graphics card size (used for "fits your
 * graphics card" advice) and "Resync local Ollama models", which asks Ollama
 * at each local address in use which models are installed, marks the saved
 * setups installed / not installed, and offers to add installed models that
 * have no saved setup yet.
 */

export function modelSettingsQueryKey(companyId: string) {
  return [...queryKeys.companies.modelDirectory(companyId), "settings"] as const;
}

/** The company's model settings (graphics card size); null while unknown. */
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
  const [text, setText] = useState(saved === null ? "" : String(saved));
  useEffect(() => setText(saved === null ? "" : String(saved)), [saved]);
  const mutation = useMutation({
    mutationFn: (localGpuVramGb: number | null) => modelDirectoryApi.updateSettings(companyId, { localGpuVramGb }),
    onSuccess: (next) => queryClient.setQueryData(modelSettingsQueryKey(companyId), next),
    onError,
  });
  const value = parseVram(text);
  const bad = Number.isNaN(value);
  const save = () => {
    if (bad || value === saved) return;
    mutation.mutate(value);
  };

  if (!canManage) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="models-gpu-readonly">
        Your graphics card: {saved === null ? "not set" : `${saved} GB`}
      </span>
    );
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="The memory of the graphics card in the PC that runs your local models. Used to say which sizes fit.">
      Your graphics card:
      <Input
        className="h-7 w-16 px-1.5 text-center text-sm"
        inputMode="decimal"
        value={text}
        placeholder="12"
        aria-label="Graphics card memory in GB"
        aria-invalid={bad || undefined}
        disabled={mutation.isPending}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
        data-testid="models-gpu-input"
      />
      GB
      {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
      {bad && <span className="text-destructive">Type a number of GB, like 12.</span>}
    </label>
  );
}

export interface SyncOutcome {
  baseUrl: string;
  result?: LocalModelsSyncResult;
  error?: string;
}

/** Runs the resync for every local address in use (the default address when there is none). */
export function useLocalResync(
  companyId: string,
  entries: readonly ModelDirectoryEntry[],
  describeError: (error: unknown) => string,
  onDone: () => void,
) {
  const addresses = localAddressesInUse(entries);
  return useMutation({
    mutationFn: async (): Promise<SyncOutcome[]> => {
      const targets = addresses.length > 0 ? addresses : [MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS];
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

export function ResyncButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={onClick}
      title="Ask Ollama on your PC which models are installed, and update the list"
      data-testid="models-resync"
    >
      {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
      Resync local Ollama models
    </Button>
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
        <p className="text-sm font-semibold">Models installed on your PC</p>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {outcomes.map((outcome) => (
        <div key={outcome.baseUrl} className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Asked Ollama at <code className="font-mono">{outcome.baseUrl}</code>
            {outcome.result ? ` at ${new Date(outcome.result.checkedAt).toLocaleTimeString()}.` : "."}
          </p>
          {outcome.error ? (
            <p className="text-destructive" data-testid="models-resync-error">
              Could not reach it: {outcome.error} Is the PC switched on and Ollama running?
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
