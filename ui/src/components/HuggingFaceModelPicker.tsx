import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildHuggingFaceModelId, splitHuggingFaceModelId } from "@paperclipai/shared";
import { Check, Loader2, X } from "lucide-react";
import { laneAApi, type HuggingFaceModelEntry, type HuggingFaceProviderEntry } from "../api/laneA";
import { ApiError } from "../api/client";
import { formatContextTokens } from "../lib/model-catalogue";
import {
  cheapestToolProvider,
  filterHuggingFacePickerModels,
  huggingFaceChoiceSupportsTools,
} from "../lib/huggingface-picker";
import { Button } from "@/components/ui/button";

const MAX_ROWS = 40;

function price(p: HuggingFaceProviderEntry) {
  if (p.inputUsdPerMillion === null || p.outputUsdPerMillion === null) return "Price not listed";
  return `Costs $${p.inputUsdPerMillion} to read and $${p.outputUsdPerMillion} to write, per million tokens`;
}

/**
 * The model picker for Hugging Face quick agents: a searchable live list, with
 * a clear "can use tools" mark per host. Picking saves the model address with
 * the host (or "cheapest" / "fastest") attached.
 */
export function HuggingFaceModelPicker({
  companyId,
  value,
  disabled,
  onSave,
}: {
  companyId: string;
  value: string | null;
  disabled?: boolean;
  onSave: (next: string) => Promise<unknown> | void;
}) {
  const [search, setSearch] = useState("");
  const [toolsOnly, setToolsOnly] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["huggingface-models", companyId],
    queryFn: () => laneAApi.huggingFaceModels(companyId),
    enabled: Boolean(companyId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const all: HuggingFaceModelEntry[] = query.data?.models ?? [];
  const shown = useMemo(() => filterHuggingFacePickerModels(all, { search, toolsOnly }), [all, search, toolsOnly]);
  const saved = value ? splitHuggingFaceModelId(value) : null;
  const choiceTools = saved ? huggingFaceChoiceSupportsTools(all, saved.model, saved.suffix) : null;
  const savedEntry = saved ? all.find((m) => m.id === saved.model) : undefined;
  const cheapestCapable = savedEntry ? cheapestToolProvider(savedEntry) : null;

  const pick = (model: string, selection: string) => void onSave(buildHuggingFaceModelId(model, selection));

  return (
    <div className="space-y-2" data-testid="huggingface-model-picker">
      <div className="text-xs text-muted-foreground">Model</div>
      <div className="text-sm" data-testid="huggingface-current-model">
        {value ? <>Chosen: <span className="font-mono">{value}</span></> : "No model chosen yet."}
      </div>

      {choiceTools === false && (
        <div
          className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="huggingface-no-tools-warning"
        >
          <p>
            This host can chat, but this agent will not be able to make pictures, look things up, or start tasks
            with it.
          </p>
          {cheapestCapable && saved && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => pick(saved.model, cheapestCapable.provider)}
            >
              Switch to the cheapest host that can use tools ({cheapestCapable.provider})
            </Button>
          )}
        </div>
      )}

      <input
        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
        placeholder="Search models, for example qwen or llama"
        aria-label="Search models"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={toolsOnly} onChange={(e) => setToolsOnly(e.target.checked)} />
        Only show hosts that can use tools (needed for pictures, look-ups and tasks)
      </label>

      {query.isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading the model list…
        </div>
      )}
      {query.isError && (
        <p className="text-xs text-destructive" data-testid="huggingface-list-error">
          {query.error instanceof ApiError ? query.error.message : "Could not load the model list."}
        </p>
      )}
      {query.data && shown.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No models match.{toolsOnly ? " Untick the box above to see models that cannot use tools too." : ""}
        </p>
      )}

      <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {shown.slice(0, MAX_ROWS).map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="w-full px-2.5 py-1.5 text-left font-mono text-xs hover:bg-accent/40"
              onClick={() => setOpen(open === m.id ? null : m.id)}
              aria-expanded={open === m.id}
            >
              {m.id} <span className="font-sans text-muted-foreground">({m.providers.length} hosts)</span>
            </button>
            {open === m.id && (
              <div className="space-y-1 bg-muted/30 px-2.5 py-2">
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={disabled} onClick={() => pick(m.id, "cheapest")}>
                    Cheapest host
                  </Button>
                  <Button size="sm" variant="outline" disabled={disabled} onClick={() => pick(m.id, "fastest")}>
                    Fastest host
                  </Button>
                </div>
                {m.providers.map((p) => (
                  <div key={p.provider} className="flex items-center justify-between gap-2 text-xs">
                    <div>
                      <div className="font-medium">{p.provider}</div>
                      <div className="text-muted-foreground">
                        {price(p)}
                        {p.contextLength ? ` · remembers ${formatContextTokens(p.contextLength)}` : ""}
                        {p.firstTokenLatencyMs !== null ? ` · starts in ${Math.round(p.firstTokenLatencyMs)} ms` : ""}
                      </div>
                      <div className={p.supportsTools ? "text-emerald-600" : "text-amber-600"}>
                        {p.supportsTools ? (
                          <><Check className="inline h-3 w-3" /> Can use tools</>
                        ) : (
                          <><X className="inline h-3 w-3" /> Cannot use tools</>
                        )}
                      </div>
                    </div>
                    <Button size="sm" disabled={disabled} onClick={() => pick(m.id, p.provider)}>
                      Use this host
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {shown.length > MAX_ROWS && (
        <p className="text-xs text-muted-foreground">Showing the first {MAX_ROWS}. Search to narrow the list.</p>
      )}
    </div>
  );
}
