import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LANE_A_MAX_MAX_OUTPUT_TOKENS,
  LANE_A_MAX_TEMPERATURE,
  LANE_A_MIN_MAX_OUTPUT_TOKENS,
  LANE_A_MIN_TEMPERATURE,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDERS,
  MODEL_DIRECTORY_NOTE_MAX_LENGTH,
  type CreateModelDirectoryEntry,
  type LaneAProvider,
  type ModelDirectoryAvailability,
  type ModelDirectoryEntry,
  type ModelDirectoryLane,
  type ModelDirectorySpecs,
} from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsSubsection } from "./SettingsSection";
import {
  availabilityLabel,
  baseModelsInUse,
  describeSpecs,
  laneLabel,
  makersInUse,
  parseTags,
  tagsIssue,
} from "../lib/model-catalogue";

/**
 * The add / edit dialog of Settings > Models, in five blocks: name and
 * grouping, connection, defaults for agents, details (closed at first) and
 * notes. Everything outside "Connection" and "Defaults" is a label for the
 * catalogue and never changes how an agent calls the model.
 */

export function providerLabel(provider: LaneAProvider): string {
  return LANE_A_PROVIDER_CATALOGUE[provider]?.label ?? provider;
}

/** The address only applies to a model server you run yourself. */
export function providerUsesAddress(provider: LaneAProvider): boolean {
  return provider === "local";
}

export type SpecsFormState = {
  params: string;
  quant: string;
  sizeGb: string;
  contextTokens: string;
  fitsLocalGpu: "" | "yes" | "tight" | "no";
  tools: "" | "yes" | "partial" | "no";
  vision: "" | "yes" | "no";
  thinking: "" | "yes" | "no" | "toggle";
  license: string;
  sourceUrl: string;
  pullCommand: string;
};

export type ModelFormState = {
  name: string;
  provider: LaneAProvider;
  model: string;
  baseUrl: string;
  thinking: "" | "on" | "off";
  temperature: string;
  maxOutputTokens: string;
  note: string;
  maker: string;
  baseModel: string;
  lane: "" | ModelDirectoryLane;
  availability: "" | ModelDirectoryAvailability;
  /** Comma-separated, as typed. */
  tags: string;
  favorite: boolean;
  specs: SpecsFormState;
};

export const EMPTY_SPECS_FORM: SpecsFormState = {
  params: "",
  quant: "",
  sizeGb: "",
  contextTokens: "",
  fitsLocalGpu: "",
  tools: "",
  vision: "",
  thinking: "",
  license: "",
  sourceUrl: "",
  pullCommand: "",
};

export const EMPTY_MODEL_FORM: ModelFormState = {
  name: "",
  provider: "local",
  model: "",
  baseUrl: "",
  thinking: "",
  temperature: "",
  maxOutputTokens: "",
  note: "",
  maker: "",
  baseModel: "",
  lane: "",
  availability: "",
  tags: "",
  favorite: false,
  specs: EMPTY_SPECS_FORM,
};

function specsFormFromEntry(specs: ModelDirectorySpecs | null): SpecsFormState {
  if (!specs) return EMPTY_SPECS_FORM;
  return {
    params: specs.params ?? "",
    quant: specs.quant ?? "",
    sizeGb: typeof specs.sizeGb === "number" ? String(specs.sizeGb) : "",
    contextTokens: typeof specs.contextTokens === "number" ? String(specs.contextTokens) : "",
    fitsLocalGpu: specs.fitsLocalGpu ?? "",
    tools: specs.tools ?? "",
    vision: specs.vision === true ? "yes" : specs.vision === false ? "no" : "",
    thinking: specs.thinking ?? "",
    license: specs.license ?? "",
    sourceUrl: specs.sourceUrl ?? "",
    pullCommand: specs.pullCommand ?? "",
  };
}

export function formFromEntry(entry: ModelDirectoryEntry): ModelFormState {
  return {
    name: entry.name,
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl ?? "",
    thinking: entry.defaultThinking ?? "",
    temperature: entry.defaultTemperature === null ? "" : String(entry.defaultTemperature),
    maxOutputTokens: entry.defaultMaxOutputTokens === null ? "" : String(entry.defaultMaxOutputTokens),
    note: entry.note ?? "",
    maker: entry.maker ?? "",
    baseModel: entry.baseModel ?? "",
    lane: entry.lane ?? "",
    availability: entry.availability ?? "",
    tags: (entry.tags ?? []).join(", "),
    favorite: Boolean(entry.favorite),
    specs: specsFormFromEntry(entry.specs ?? null),
  };
}

/** "16,5" and "16.5" both read as 16.5 (a Norwegian keyboard types a comma). Empty = null, bad = NaN. */
function decimal(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return Number(trimmed.replace(",", "."));
}

const textOrNull = (text: string) => (text.trim() ? text.trim() : null);

/** Only the facts that were filled in; null when none were. */
export function specsFromForm(specs: SpecsFormState): ModelDirectorySpecs | null {
  const out: ModelDirectorySpecs = {};
  const params = textOrNull(specs.params);
  if (params) out.params = params;
  const quant = textOrNull(specs.quant);
  if (quant) out.quant = quant;
  const size = decimal(specs.sizeGb);
  if (size !== null) out.sizeGb = size;
  const context = decimal(specs.contextTokens);
  if (context !== null) out.contextTokens = context;
  if (specs.fitsLocalGpu) out.fitsLocalGpu = specs.fitsLocalGpu;
  if (specs.tools) out.tools = specs.tools;
  if (specs.vision) out.vision = specs.vision === "yes";
  if (specs.thinking) out.thinking = specs.thinking;
  const license = textOrNull(specs.license);
  if (license) out.license = license;
  const sourceUrl = textOrNull(specs.sourceUrl);
  if (sourceUrl) out.sourceUrl = sourceUrl;
  const pullCommand = textOrNull(specs.pullCommand);
  if (pullCommand) out.pullCommand = pullCommand;
  return Object.keys(out).length > 0 ? out : null;
}

/** Fields to send; anything that does not apply to the provider is cleared so nothing stale lingers. */
export function bodyFromForm(form: ModelFormState): CreateModelDirectoryEntry {
  const maxTokens = decimal(form.maxOutputTokens);
  return {
    name: form.name,
    provider: form.provider,
    model: form.model,
    baseUrl: providerUsesAddress(form.provider) && form.baseUrl.trim() ? form.baseUrl.trim() : null,
    ...(form.provider === "openrouter" ? {} : { providerRouting: null }),
    defaultThinking: form.thinking === "" ? null : form.thinking,
    defaultTemperature: decimal(form.temperature),
    defaultMaxOutputTokens: maxTokens,
    note: textOrNull(form.note),
    maker: textOrNull(form.maker),
    baseModel: textOrNull(form.baseModel),
    lane: form.lane === "" ? null : form.lane,
    availability: form.availability === "" ? null : form.availability,
    tags: parseTags(form.tags),
    specs: specsFromForm(form.specs),
    favorite: form.favorite,
  };
}

/** What stops the form from being saved, in plain words, or null. Name and model id are checked separately. */
export function formIssue(form: ModelFormState): string | null {
  const temperature = decimal(form.temperature);
  if (temperature !== null && !(temperature >= LANE_A_MIN_TEMPERATURE && temperature <= LANE_A_MAX_TEMPERATURE)) {
    return `Creativity must be a number from ${LANE_A_MIN_TEMPERATURE} to ${LANE_A_MAX_TEMPERATURE}, like 0.7.`;
  }
  const maxTokens = decimal(form.maxOutputTokens);
  if (
    maxTokens !== null &&
    !(Number.isInteger(maxTokens) && maxTokens >= LANE_A_MIN_MAX_OUTPUT_TOKENS && maxTokens <= LANE_A_MAX_MAX_OUTPUT_TOKENS)
  ) {
    return `Longest answer must be a whole number from ${LANE_A_MIN_MAX_OUTPUT_TOKENS} to ${LANE_A_MAX_MAX_OUTPUT_TOKENS}.`;
  }
  const tags = tagsIssue(parseTags(form.tags));
  if (tags) return tags;
  const size = decimal(form.specs.sizeGb);
  if (size !== null && !(size >= 0 && size <= 2000)) return "Download size must be a number of GB, like 16.5.";
  const context = decimal(form.specs.contextTokens);
  if (context !== null && !(Number.isInteger(context) && context >= 0)) {
    return "Context length must be a whole number of tokens, like 131072.";
  }
  const link = form.specs.sourceUrl.trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return "The model page link must start with https://.";
  return null;
}

const SELECT_CLASS = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ModelEntryDialog({
  open,
  entry,
  allEntries,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  entry: ModelDirectoryEntry | null;
  /** Every saved model, for the maker and base model suggestions. */
  allEntries: readonly ModelDirectoryEntry[];
  busy: boolean;
  onClose: () => void;
  onSave: (body: CreateModelDirectoryEntry) => void;
}) {
  const [form, setForm] = useState<ModelFormState>(EMPTY_MODEL_FORM);
  useEffect(() => {
    if (open) setForm(entry ? formFromEntry(entry) : EMPTY_MODEL_FORM);
  }, [open, entry]);
  const set = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const setSpec = <K extends keyof SpecsFormState>(key: K, value: SpecsFormState[K]) =>
    setForm((current) => ({ ...current, specs: { ...current.specs, [key]: value } }));

  const makers = useMemo(() => makersInUse(allEntries), [allEntries]);
  const baseModels = useMemo(() => baseModelsInUse(allEntries, form.maker), [allEntries, form.maker]);
  const tags = parseTags(form.tags);
  const issue = formIssue(form);
  const canSave = form.name.trim() !== "" && form.model.trim() !== "" && issue === null;
  const specsSummary = describeSpecs(specsFromForm(form.specs)) || "Size, quality and install facts (optional)";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        data-testid="model-entry-dialog"
      >
        <DialogHeader>
          <DialogTitle>{entry ? "Edit model setup" : "Add a model setup"}</DialogTitle>
          <DialogDescription>
            Save a model once, then pick it for any quick agent. Keys are not saved here; they stay under
            Connections.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <SettingsSubsection title="Name and grouping" data-testid="model-entry-section-naming">
            <Field id="model-name" label="Name">
              <Input
                id="model-name"
                value={form.name}
                placeholder="Maja on my PC"
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="model-maker" label="Maker" hint="Who made the model, e.g. Google or Alibaba.">
                <Input
                  id="model-maker"
                  list="model-maker-options"
                  value={form.maker}
                  placeholder="Google"
                  onChange={(event) => set("maker", event.target.value)}
                />
                <datalist id="model-maker-options">
                  {makers.map((maker) => (
                    <option key={maker} value={maker} />
                  ))}
                </datalist>
              </Field>
              <Field id="model-base" label="Base model" hint="The family it belongs to, e.g. Gemma 3 27B.">
                <Input
                  id="model-base"
                  list="model-base-options"
                  value={form.baseModel}
                  placeholder="Gemma 3 27B"
                  onChange={(event) => set("baseModel", event.target.value)}
                />
                <datalist id="model-base-options">
                  {baseModels.map((base) => (
                    <option key={base} value={base} />
                  ))}
                </datalist>
              </Field>
              <Field id="model-lane" label="What it's for">
                <select
                  id="model-lane"
                  className={SELECT_CLASS}
                  value={form.lane}
                  onChange={(event) => set("lane", event.target.value as ModelFormState["lane"])}
                >
                  <option value="">Not set</option>
                  {(["quick", "full", "both"] as const).map((lane) => (
                    <option key={lane} value={lane}>
                      {laneLabel(lane)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="model-availability" label="Status">
                <select
                  id="model-availability"
                  className={SELECT_CLASS}
                  value={form.availability}
                  onChange={(event) => set("availability", event.target.value as ModelFormState["availability"])}
                >
                  <option value="">Not set</option>
                  {(["installed", "downloading", "planned", "cloud"] as const).map((value) => (
                    <option key={value} value={value}>
                      {value === "cloud" ? "Cloud (nothing to install)" : availabilityLabel(value)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field id="model-tags" label="Tags" hint="Separate tags with commas, e.g. vision, uncensored, code.">
              <Input
                id="model-tags"
                value={form.tags}
                placeholder="vision, code"
                onChange={(event) => set("tags", event.target.value)}
              />
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1" data-testid="model-tags-preview">
                  {tags.map((tag) => (
                    <span key={tag} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <ToggleSwitch
                checked={form.favorite}
                onCheckedChange={(checked) => set("favorite", checked)}
                aria-label="Favourite"
                data-testid="model-favorite-toggle"
              />
              Favourite (shown first in its group)
            </label>
          </SettingsSubsection>

          <SettingsSubsection title="Connection" data-testid="model-entry-section-connection">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="model-provider" label="Where it runs">
                <select
                  id="model-provider"
                  className={SELECT_CLASS}
                  value={form.provider}
                  onChange={(event) => set("provider", event.target.value as LaneAProvider)}
                >
                  {LANE_A_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {providerLabel(provider)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                id="model-id"
                label="Model id"
                hint="Exactly as the provider or Ollama spells it."
              >
                <Input
                  id="model-id"
                  className="font-mono"
                  value={form.model}
                  placeholder={
                    form.provider === "openrouter" ? "mistralai/mistral-small-3.2-24b-instruct" : "llama3.2"
                  }
                  onChange={(event) => set("model", event.target.value)}
                />
              </Field>
            </div>
            {providerUsesAddress(form.provider) ? (
              <Field
                id="model-address"
                label="Address of your model server"
                hint="Your PC must be switched on for this to work."
              >
                <Input
                  id="model-address"
                  value={form.baseUrl}
                  placeholder="http://100.124.232.68:11434/v1"
                  onChange={(event) => set("baseUrl", event.target.value)}
                />
              </Field>
            ) : (
              <p className="text-xs text-muted-foreground">
                The key for {providerLabel(form.provider)} is set on each agent, under Connections.
              </p>
            )}
          </SettingsSubsection>

          <SettingsSubsection
            title="Defaults for agents"
            description="What an agent starts from when it switches to this model. Leave empty to use the model's own."
            data-testid="model-entry-section-defaults"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id="model-thinking" label="Thinking">
                <select
                  id="model-thinking"
                  className={SELECT_CLASS}
                  value={form.thinking}
                  onChange={(event) => set("thinking", event.target.value as ModelFormState["thinking"])}
                >
                  <option value="">Model's own choice</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </Field>
              <Field id="model-creativity" label="Creativity">
                <Input
                  id="model-creativity"
                  inputMode="decimal"
                  value={form.temperature}
                  placeholder="Default"
                  onChange={(event) => set("temperature", event.target.value)}
                />
              </Field>
              <Field id="model-length" label="Longest answer">
                <Input
                  id="model-length"
                  inputMode="numeric"
                  value={form.maxOutputTokens}
                  placeholder="Default"
                  onChange={(event) => set("maxOutputTokens", event.target.value)}
                />
              </Field>
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            title="Details"
            summary={specsSummary}
            defaultOpen={false}
            description="Facts that help you pick a model. Paperclip does not check or enforce them."
            data-testid="model-entry-section-details"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="model-spec-params" label="Size in parameters">
                <Input
                  id="model-spec-params"
                  value={form.specs.params}
                  placeholder="27B"
                  onChange={(event) => setSpec("params", event.target.value)}
                />
              </Field>
              <Field id="model-spec-quant" label="Quantisation">
                <Input
                  id="model-spec-quant"
                  value={form.specs.quant}
                  placeholder="Q4_K_M"
                  onChange={(event) => setSpec("quant", event.target.value)}
                />
              </Field>
              <Field id="model-spec-size" label="Download size (GB)">
                <Input
                  id="model-spec-size"
                  inputMode="decimal"
                  value={form.specs.sizeGb}
                  placeholder="16.5"
                  onChange={(event) => setSpec("sizeGb", event.target.value)}
                />
              </Field>
              <Field id="model-spec-context" label="Context length (tokens)">
                <Input
                  id="model-spec-context"
                  inputMode="numeric"
                  value={form.specs.contextTokens}
                  placeholder="131072"
                  onChange={(event) => setSpec("contextTokens", event.target.value)}
                />
              </Field>
              <Field id="model-spec-fits" label="Fits your graphics card">
                <select
                  id="model-spec-fits"
                  className={SELECT_CLASS}
                  value={form.specs.fitsLocalGpu}
                  onChange={(event) => setSpec("fitsLocalGpu", event.target.value as SpecsFormState["fitsLocalGpu"])}
                >
                  <option value="">Not checked</option>
                  <option value="yes">Yes</option>
                  <option value="tight">Just about</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field id="model-spec-tools" label="Tool use">
                <select
                  id="model-spec-tools"
                  className={SELECT_CLASS}
                  value={form.specs.tools}
                  onChange={(event) => setSpec("tools", event.target.value as SpecsFormState["tools"])}
                >
                  <option value="">Not checked</option>
                  <option value="yes">Works</option>
                  <option value="partial">Partly works</option>
                  <option value="no">Does not work</option>
                </select>
              </Field>
              <Field id="model-spec-vision" label="Pictures">
                <select
                  id="model-spec-vision"
                  className={SELECT_CLASS}
                  value={form.specs.vision}
                  onChange={(event) => setSpec("vision", event.target.value as SpecsFormState["vision"])}
                >
                  <option value="">Not checked</option>
                  <option value="yes">Can look at pictures</option>
                  <option value="no">Text only</option>
                </select>
              </Field>
              <Field id="model-spec-thinking" label="Thinking support">
                <select
                  id="model-spec-thinking"
                  className={SELECT_CLASS}
                  value={form.specs.thinking}
                  onChange={(event) => setSpec("thinking", event.target.value as SpecsFormState["thinking"])}
                >
                  <option value="">Not checked</option>
                  <option value="yes">Always thinks</option>
                  <option value="toggle">Can be switched on and off</option>
                  <option value="no">Does not think</option>
                </select>
              </Field>
              <Field id="model-spec-license" label="Licence">
                <Input
                  id="model-spec-license"
                  value={form.specs.license}
                  placeholder="Apache 2.0"
                  onChange={(event) => setSpec("license", event.target.value)}
                />
              </Field>
              <Field id="model-spec-link" label="Model page link">
                <Input
                  id="model-spec-link"
                  value={form.specs.sourceUrl}
                  placeholder="https://huggingface.co/…"
                  onChange={(event) => setSpec("sourceUrl", event.target.value)}
                />
              </Field>
            </div>
            <Field id="model-spec-pull" label="Install command" hint="What you type on your PC to download it.">
              <Input
                id="model-spec-pull"
                className="font-mono"
                value={form.specs.pullCommand}
                placeholder="ollama pull qwen3:14b"
                onChange={(event) => setSpec("pullCommand", event.target.value)}
              />
            </Field>
          </SettingsSubsection>

          <SettingsSubsection title="Notes" data-testid="model-entry-section-notes">
            <Field id="model-note" label="Note (optional)">
              <Textarea
                id="model-note"
                rows={4}
                maxLength={MODEL_DIRECTORY_NOTE_MAX_LENGTH}
                value={form.note}
                onChange={(event) => set("note", event.target.value)}
              />
              <p className="text-right text-xs text-muted-foreground" data-testid="model-note-counter">
                {form.note.length} / {MODEL_DIRECTORY_NOTE_MAX_LENGTH}
              </p>
            </Field>
          </SettingsSubsection>
        </div>

        {issue && (
          <p className="text-sm text-destructive" data-testid="model-entry-issue">
            {issue}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onSave(bodyFromForm(form))} disabled={!canSave || busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {entry ? "Save changes" : "Add model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
