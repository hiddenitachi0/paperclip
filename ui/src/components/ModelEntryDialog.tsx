import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LANE_A_MAX_MAX_OUTPUT_TOKENS,
  LANE_A_MAX_TEMPERATURE,
  LANE_A_MIN_MAX_OUTPUT_TOKENS,
  LANE_A_MIN_TEMPERATURE,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDERS,
  laneAModelsForProvider,
  MODEL_DIRECTORY_NOTE_MAX_LENGTH,
  MODEL_DIRECTORY_RATINGS_MAX,
  KNOWN_MODEL_FAMILIES,
  describeOpenRouterHostsChange,
  diffOpenRouterHosts,
  openRouterHostsSeen,
  resolveOpenRouterHostRouting,
  type CreateModelDirectoryEntry,
  type OpenRouterHost,
  type OpenRouterHostRules,
  type OpenRouterHostSeen,
  type ModelDirectoryRating,
  type LaneAProvider,
  type ModelDirectoryAvailability,
  type ModelDirectoryEntry,
  type ModelDirectoryLane,
  type ModelDirectorySpecs,
} from "@paperclipai/shared";
import { Loader2, Plus, X } from "lucide-react";
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
  criteriaInUse,
  describeSpecs,
  familiesInUse,
  knownFamilySuggestions,
  isLoopbackAddress,
  laneLabel,
  localAddressIssue,
  makersInUse,
  modelIdChoices,
  parseTags,
  prefillForModel,
  type ModelPrefill,
  ratingsAverage,
  ratingsIssue,
  SUGGESTED_CRITERIA,
  tagsIssue,
  variantSuggestions,
} from "../lib/model-catalogue";
import { HelpTip, MODEL_HELP } from "./ModelHelp";
import { modelDirectoryApi } from "../api/modelDirectory";
import {
  hostChoicesFromText,
  hostTextsWithChoice,
  OpenRouterHostsTable,
  openRouterHostsQueryKey,
  useOpenRouterHosts,
} from "./OpenRouterHostsTable";

/**
 * The add / edit dialog of Settings > Models, in six blocks: name and
 * grouping (maker, model family, size), connection (where it runs, model id,
 * address or OpenRouter hosts), defaults for agents, test scores, details
 * (closed at first) and notes. Every value the catalogue shows is editable
 * here, and every field has a "?" with plain help text. Everything outside
 * "Connection" and "Defaults" is a label for the catalogue and never changes
 * how an agent calls the model.
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

/** One test score row as typed. `changed` marks rows touched since opening (they get a new date). */
export type RatingFormRow = {
  criterion: string;
  score: string;
  note: string;
  updatedAt?: string;
  changed?: boolean;
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
  /** Kept as it was (older rows group by it); the dialog edits family and size instead. */
  baseModel: string;
  family: string;
  variant: string;
  ratings: RatingFormRow[];
  lane: "" | ModelDirectoryLane;
  availability: "" | ModelDirectoryAvailability;
  /** Comma-separated, as typed. */
  tags: string;
  favorite: boolean;
  specs: SpecsFormState;
  /**
   * The saved (or suggested) OpenRouter routing. Its host list is edited
   * through `hosts`; the rest (order, ignore, fallbacks) is kept as it is.
   */
  providerRouting?: CreateModelDirectoryEntry["providerRouting"];
  /** OpenRouter only: the hosts to use ("Use"), comma-separated, as typed. Empty = no "Use" host. */
  hosts?: string;
  /** OpenRouter only: the hosts never to use ("Never"), comma-separated. */
  ignoreHosts?: string;
  /** True once a host choice was changed in this dialog (the routing is then rebuilt on save). */
  hostsTouched?: boolean;
  /** OpenRouter only: the host list seen at the last check (saved in specs), for "what changed". */
  hostsSeen?: OpenRouterHostSeen[] | null;
  hostsCheckedAt?: string | null;
};

/** What the host choices are combined with when the routing is built (company rules, live hosts). */
export type HostRoutingContext = {
  rules?: OpenRouterHostRules | null;
  hosts?: readonly Pick<OpenRouterHost, "slug" | "supportsTools">[] | null;
  /** A new setup: the company's preferred hosts apply (an edited one keeps its own list). */
  isNew?: boolean;
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
  family: "",
  variant: "",
  ratings: [],
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
    family: entry.family ?? entry.baseModel ?? "",
    variant: entry.variant ?? "",
    ratings: (entry.ratings ?? []).map((rating) => ({
      criterion: rating.criterion,
      score: String(rating.score),
      note: rating.note ?? "",
      updatedAt: rating.updatedAt,
    })),
    lane: entry.lane ?? "",
    availability: entry.availability ?? "",
    tags: (entry.tags ?? []).join(", "),
    favorite: Boolean(entry.favorite),
    specs: specsFormFromEntry(entry.specs ?? null),
    ...(entry.providerRouting ? { providerRouting: entry.providerRouting } : {}),
    hosts: (entry.providerRouting?.only ?? []).join(", "),
    ignoreHosts: (entry.providerRouting?.ignore ?? []).join(", "),
    hostsSeen: entry.specs?.openrouterHostsSeen ?? null,
    hostsCheckedAt: entry.specs?.openrouterHostsCheckedAt ?? null,
  };
}

/** "deepinfra, Together ,," -> ["deepinfra", "together"]. */
export function parseHosts(text: string | undefined): string[] {
  return [
    ...new Set(
      (text ?? "")
        .split(/[\s,]+/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * OpenRouter routing from the form: the per-host Use / Never choices combined
 * with the company's host rules (precedence: packages/shared/src/openrouter-hosts.ts
 * - an explicit Use beats the company's preferred AND blocked lists; blocked
 * hosts are always added to Never otherwise; preferred hosts only fill a NEW
 * setup with no Use host, and only when one of them runs the model with tools).
 * The saved order and fallback choice are kept. Undefined = leave as saved
 * (an edited setup whose hosts were not touched, with no company rule to add).
 */
export function routingFromForm(
  form: ModelFormState,
  ctx: HostRoutingContext = {},
): CreateModelDirectoryEntry["providerRouting"] | undefined {
  const base = form.providerRouting ?? null;
  const blocked = ctx.rules?.blocked ?? [];
  const preferred = ctx.isNew ? (ctx.rules?.preferred ?? []) : [];
  if (!form.hostsTouched && blocked.length === 0 && preferred.length === 0) {
    if (ctx.isNew) return base;
    return undefined;
  }
  return resolveOpenRouterHostRouting({
    choices: hostChoicesFromText(form.hosts, form.ignoreHosts),
    rules: { preferred, blocked },
    hosts: ctx.hosts ?? null,
    base,
  });
}

/** A new setup pre-filled from a known way to run a model (Settings > Models "Add"). */
export function formFromDraft(draft: CreateModelDirectoryEntry): ModelFormState {
  const form = formFromEntry({
    id: "",
    companyId: "",
    name: draft.name,
    provider: draft.provider,
    model: draft.model,
    baseUrl: draft.baseUrl ?? null,
    providerRouting: draft.providerRouting ?? null,
    defaultThinking: draft.defaultThinking ?? null,
    defaultTemperature: draft.defaultTemperature ?? null,
    defaultMaxOutputTokens: draft.defaultMaxOutputTokens ?? null,
    backupEntryIds: [],
    note: draft.note ?? null,
    maker: draft.maker ?? null,
    baseModel: draft.baseModel ?? null,
    lane: draft.lane ?? null,
    availability: draft.availability ?? null,
    tags: draft.tags ?? [],
    specs: draft.specs ?? null,
    favorite: draft.favorite ?? false,
    archivedAt: null,
    family: draft.family ?? null,
    variant: draft.variant ?? null,
    ratings: draft.ratings ?? [],
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: "",
    updatedAt: "",
  });
  return form;
}

/** Filled-in score rows as the API takes them; touched rows get today's date. */
export function ratingsFromForm(rows: readonly RatingFormRow[], now: Date = new Date()): ModelDirectoryRating[] {
  return rows
    .filter((row) => row.criterion.trim() !== "")
    .map((row) => {
      const note = row.note.trim();
      const updatedAt = row.changed || !row.updatedAt ? now.toISOString() : row.updatedAt;
      return {
        criterion: row.criterion.trim(),
        score: Number(row.score.trim().replace(",", ".")),
        ...(note ? { note } : {}),
        updatedAt,
      };
    });
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
export function bodyFromForm(form: ModelFormState, ctx: HostRoutingContext = {}): CreateModelDirectoryEntry {
  const maxTokens = decimal(form.maxOutputTokens);
  const specs = specsFromForm(form.specs);
  const seen =
    form.provider === "openrouter" && form.hostsSeen
      ? { openrouterHostsSeen: form.hostsSeen, openrouterHostsCheckedAt: form.hostsCheckedAt ?? null }
      : null;
  return {
    name: form.name,
    provider: form.provider,
    model: form.model,
    baseUrl: providerUsesAddress(form.provider) && form.baseUrl.trim() ? form.baseUrl.trim() : null,
    ...(form.provider === "openrouter"
      ? (() => {
          const routing = routingFromForm(form, ctx);
          return routing === undefined ? {} : { providerRouting: routing };
        })()
      : { providerRouting: null }),
    defaultThinking: form.thinking === "" ? null : form.thinking,
    defaultTemperature: decimal(form.temperature),
    defaultMaxOutputTokens: maxTokens,
    note: textOrNull(form.note),
    maker: textOrNull(form.maker),
    baseModel: textOrNull(form.baseModel),
    family: textOrNull(form.family),
    variant: textOrNull(form.variant),
    ratings: ratingsFromForm(form.ratings),
    lane: form.lane === "" ? null : form.lane,
    availability: form.availability === "" ? null : form.availability,
    tags: parseTags(form.tags),
    specs: seen ? { ...(specs ?? {}), ...seen } : specs,
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
  if (providerUsesAddress(form.provider)) {
    if (!form.baseUrl.trim()) {
      return "Type the address of the model server that runs this model, e.g. http://192.168.1.20:11434/v1.";
    }
    const address = localAddressIssue(form.baseUrl);
    if (address) return address;
  }
  if (
    form.provider === "openrouter" &&
    [...parseHosts(form.hosts), ...parseHosts(form.ignoreHosts)].some((host) => !/^[a-z0-9][a-z0-9._-]*$/.test(host))
  ) {
    return "Host names are the short lower-case names OpenRouter shows for each host, separated by commas.";
  }
  const tags = tagsIssue(parseTags(form.tags));
  if (tags) return tags;
  const ratings = ratingsIssue(form.ratings);
  if (ratings) return ratings;
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

/**
 * Fills the form from a prefill without overwriting what the person typed:
 * a field is filled only when it is empty or was filled automatically before
 * (its key is in `auto`). Returns the new form and the new set of
 * automatically filled keys ("name", "maker", "specs.params", ...).
 */
export function applyPrefill(
  form: ModelFormState,
  prefill: ModelPrefill,
  auto: ReadonlySet<string>,
): { form: ModelFormState; auto: Set<string> } {
  const nextAuto = new Set(auto);
  const next: ModelFormState = { ...form, specs: { ...form.specs } };
  const free = (key: string, current: string) => current.trim() === "" || auto.has(key);
  const put = (key: "name" | "maker" | "family" | "variant" | "baseUrl" | "note", value: string | undefined) => {
    if (!free(key, form[key])) return;
    if (value !== undefined) {
      next[key] = value;
      nextAuto.add(key);
    } else if (auto.has(key)) {
      // Filled for the previous model, not known for this one: clear it.
      next[key] = "";
      nextAuto.delete(key);
    }
  };
  put("name", prefill.name);
  put("maker", prefill.maker);
  put("family", prefill.family);
  put("variant", prefill.variant);
  put("baseUrl", prefill.baseUrl);
  put("note", prefill.note);
  if (prefill.lane && free("lane", form.lane)) {
    next.lane = prefill.lane;
    nextAuto.add("lane");
  }
  if (prefill.availability && free("availability", form.availability)) {
    next.availability = prefill.availability;
    nextAuto.add("availability");
  }
  if (prefill.providerRouting !== undefined && (form.providerRouting === undefined || auto.has("providerRouting"))) {
    next.providerRouting = prefill.providerRouting;
    next.hosts = (prefill.providerRouting?.only ?? []).join(", ");
    next.ignoreHosts = (prefill.providerRouting?.ignore ?? []).join(", ");
    nextAuto.add("providerRouting");
  } else if (prefill.providerRouting === undefined && auto.has("providerRouting")) {
    next.providerRouting = undefined;
    next.hosts = "";
    next.ignoreHosts = "";
    nextAuto.delete("providerRouting");
  }
  // Facts: a model change replaces every fact filled in automatically before.
  const specs = prefill.specs ?? {};
  const asText: Partial<SpecsFormState> = {
    ...(specs.params ? { params: specs.params } : {}),
    ...(specs.quant ? { quant: specs.quant } : {}),
    ...(typeof specs.sizeGb === "number" ? { sizeGb: String(specs.sizeGb) } : {}),
    ...(typeof specs.contextTokens === "number" ? { contextTokens: String(specs.contextTokens) } : {}),
    ...(specs.fitsLocalGpu ? { fitsLocalGpu: specs.fitsLocalGpu } : {}),
    ...(specs.tools ? { tools: specs.tools } : {}),
    ...(typeof specs.vision === "boolean" ? { vision: specs.vision ? "yes" : "no" } : {}),
    ...(specs.thinking ? { thinking: specs.thinking } : {}),
    ...(specs.license ? { license: specs.license } : {}),
    ...(specs.pullCommand ? { pullCommand: specs.pullCommand } : {}),
  };
  for (const key of Object.keys(form.specs) as Array<keyof SpecsFormState>) {
    const autoKey = `specs.${key}`;
    if (!free(autoKey, form.specs[key])) continue;
    const value = asText[key];
    if (value !== undefined) {
      (next.specs as Record<string, string>)[key] = value;
      nextAuto.add(autoKey);
    } else if (auto.has(autoKey)) {
      // Filled for the previous model, not known for this one: clear it.
      (next.specs as Record<string, string>)[key] = "";
      nextAuto.delete(autoKey);
    }
  }
  return { form: next, auto: nextAuto };
}

const SELECT_CLASS = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

function Field({
  id,
  label,
  hint,
  help,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  /** The "?" text: what the field is, in plain words. */
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        {help && <HelpTip topic={label.toLowerCase()} text={help} />}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ModelEntryDialog({
  open,
  entry,
  initial = null,
  installedTags,
  localAddress,
  gpuVramGb = null,
  allEntries,
  busy,
  onClose,
  onSave,
  companyId,
  hostRules = null,
}: {
  /** The company, for the live OpenRouter host list; without it only typed host names are offered. */
  companyId?: string | null;
  /** The company's OpenRouter host rules (Settings > Models > OpenRouter hosts). */
  hostRules?: OpenRouterHostRules | null;
  open: boolean;
  entry: ModelDirectoryEntry | null;
  /** For a new setup: start from these values (a known way to run a model). */
  initial?: CreateModelDirectoryEntry | null;
  /** Ollama tags the last "Resync local Ollama models" found installed. */
  installedTags?: readonly string[];
  /** The company's model server address (Settings > Models); null = not set, the dialog asks for it. */
  localAddress?: string | null;
  /** Graphics card memory in GB, for "fits the graphics card"; null = not set. */
  gpuVramGb?: number | null;
  /** Every saved model, for the maker, family, size and score suggestions. */
  allEntries: readonly ModelDirectoryEntry[];
  busy: boolean;
  onClose: () => void;
  onSave: (body: CreateModelDirectoryEntry) => void;
}) {
  const [form, setForm] = useState<ModelFormState>(EMPTY_MODEL_FORM);
  // Fields filled in automatically (from the picked model); typing in one takes it out.
  const autoFilled = useRef<Set<string>>(new Set());
  const prefillOptions = { installedTags, localAddress, gpuVramGb };
  const prefilled = (current: ModelFormState, provider: LaneAProvider, model: string): ModelFormState => {
    const result = applyPrefill(current, prefillForModel(provider, model, prefillOptions), autoFilled.current);
    autoFilled.current = result.auto;
    return result.form;
  };
  useEffect(() => {
    if (!open) return;
    autoFilled.current = new Set();
    if (entry) setForm(formFromEntry(entry));
    else if (initial) {
      const form = formFromDraft(initial);
      // Everything the draft filled counts as filled automatically, so picking another model id updates it.
      const keys = (["name", "maker", "family", "variant", "baseUrl", "note", "lane", "availability"] as const).filter(
        (key) => form[key] !== "",
      );
      const specKeys = (Object.keys(form.specs) as Array<keyof SpecsFormState>)
        .filter((key) => form.specs[key] !== "")
        .map((key) => `specs.${key}`);
      autoFilled.current = new Set<string>([
        ...keys,
        ...specKeys,
        ...(form.providerRouting !== undefined ? ["providerRouting"] : []),
      ]);
      setForm(form);
    }
    else setForm(prefilled(EMPTY_MODEL_FORM, EMPTY_MODEL_FORM.provider, ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry, initial]);
  const set = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) => {
    autoFilled.current.delete(key);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const setSpec = <K extends keyof SpecsFormState>(key: K, value: SpecsFormState[K]) => {
    autoFilled.current.delete(`specs.${key}`);
    setForm((current) => ({ ...current, specs: { ...current.specs, [key]: value } }));
  };
  /** A model id was picked or typed: fill in what follows from it. */
  const pickModel = (model: string) => {
    autoFilled.current.delete("model");
    // The remembered host list belongs to the previous model.
    setForm((current) =>
      prefilled(
        { ...current, model, ...(current.model !== model ? { hostsSeen: null, hostsCheckedAt: null } : {}) },
        current.provider,
        model,
      ),
    );
  };
  /** Another provider: Claude / OpenAI / Google get their standard model, then everything that follows. */
  const pickProvider = (provider: LaneAProvider) => {
    setForm((current) => {
      const fixed = LANE_A_PROVIDER_CATALOGUE[provider].freeForm ? [] : laneAModelsForProvider(provider);
      const keepModel = fixed.length === 0 ? !autoFilled.current.has("model") : fixed.includes(current.model);
      let model = keepModel ? current.model : "";
      if (!keepModel && fixed.length > 0) {
        model = LANE_A_PROVIDER_CATALOGUE[provider].defaultModel ?? fixed[0]!;
        autoFilled.current.add("model");
      } else if (!keepModel) autoFilled.current.delete("model");
      return prefilled({ ...current, provider, model }, provider, model);
    });
  };
  const modelChoices = useMemo(
    () => modelIdChoices(form.provider, { installedTags }),
    [form.provider, installedTags],
  );
  // Claude, OpenAI and Google only accept their own listed models; the rest take any id.
  const fixedModels = !LANE_A_PROVIDER_CATALOGUE[form.provider].freeForm;

  // OpenRouter: the hosts that run this model, live, and what changed since the last check.
  const queryClient = useQueryClient();
  const isOpenRouter = form.provider === "openrouter";
  const hostsQuery = useOpenRouterHosts(companyId, form.model, open && isOpenRouter);
  const liveHosts = hostsQuery.data && hostsQuery.data.model === form.model.trim() ? hostsQuery.data.hosts : null;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const refreshAsked = useRef(false);
  const lastSeenData = useRef<unknown>(null);
  useEffect(() => {
    if (!open) {
      setChangeNote(null);
      setRefreshError(null);
      lastSeenData.current = null;
      return;
    }
    const data = hostsQuery.data;
    if (!data || !isOpenRouter || data.model !== form.model.trim() || lastSeenData.current === data) return;
    lastSeenData.current = data;
    const current = openRouterHostsSeen(data.hosts);
    const previous = form.hostsSeen ?? null;
    if (previous && previous.length > 0) {
      const note = describeOpenRouterHostsChange(diffOpenRouterHosts(previous, current));
      setChangeNote(note === "Nothing changed." && !refreshAsked.current ? null : note);
    }
    refreshAsked.current = false;
    setForm((f) => ({ ...f, hostsSeen: current, hostsCheckedAt: data.fetchedAt }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hostsQuery.data, isOpenRouter, form.model]);
  const refreshHosts = async () => {
    if (!companyId) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      refreshAsked.current = true;
      const fresh = await modelDirectoryApi.openrouterHosts(companyId, form.model.trim(), { refresh: true });
      queryClient.setQueryData(openRouterHostsQueryKey(companyId, form.model), fresh);
    } catch (error) {
      refreshAsked.current = false;
      setRefreshError(error);
    } finally {
      setRefreshing(false);
    }
  };
  const hostCtx: HostRoutingContext = { rules: hostRules, hosts: liveHosts, isNew: !entry };
  const builtRouting = isOpenRouter ? routingFromForm(form, hostCtx) : null;
  const shownRouting = builtRouting === undefined ? (form.providerRouting ?? null) : builtRouting;
  const hostChoices = hostChoicesFromText(form.hosts, form.ignoreHosts);
  const chooseHost = (slug: string, choice: "use" | "never" | "default") => {
    autoFilled.current.delete("providerRouting");
    setForm((current) => {
      const texts = hostTextsWithChoice(current.hosts, current.ignoreHosts, slug, choice);
      return { ...current, hosts: texts.use, ignoreHosts: texts.never, hostsTouched: true };
    });
  };

  const setRating = (index: number, patch: Partial<RatingFormRow>) =>
    setForm((current) => ({
      ...current,
      ratings: current.ratings.map((row, i) => (i === index ? { ...row, ...patch, changed: true } : row)),
    }));

  const makers = useMemo(
    () => [...new Set([...makersInUse(allEntries), ...KNOWN_MODEL_FAMILIES.map((family) => family.maker)])].sort(),
    [allEntries],
  );
  const families = useMemo(
    () => knownFamilySuggestions(form.maker, familiesInUse(allEntries, form.maker)),
    [allEntries, form.maker],
  );
  const variants = useMemo(() => variantSuggestions(form.family, allEntries), [allEntries, form.family]);
  const criteria = useMemo(
    () => [...new Set([...criteriaInUse(allEntries), ...SUGGESTED_CRITERIA])],
    [allEntries],
  );
  const average = ratingsAverage(
    form.ratings
      .filter((row) => row.criterion.trim() && row.score.trim() !== "" && Number.isFinite(Number(row.score)))
      .map((row) => ({ criterion: row.criterion, score: Number(row.score) })),
  );
  const tags = parseTags(form.tags);
  const issue = formIssue(form);
  const canSave = form.name.trim() !== "" && form.model.trim() !== "" && issue === null;
  const ratingsSummary =
    form.ratings.length === 0
      ? "None yet. Add a score for anything you test, e.g. Tool calling 8."
      : `${form.ratings.length} ${form.ratings.length === 1 ? "score" : "scores"}${average !== null ? ` · average ${average}` : ""}`;
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
            <Field
              id="model-name"
              label="Name"
              help={MODEL_HELP.name}
              hint="Maker, model and size below decide where it is listed."
            >
              <Input
                id="model-name"
                value={form.name}
                placeholder="Qwen3 14B (local)"
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="model-maker" label="Maker" help={MODEL_HELP.maker}>
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
              <Field id="model-family" label="Model" help={MODEL_HELP.family}>
                <Input
                  id="model-family"
                  list="model-family-options"
                  value={form.family}
                  placeholder="Llama 3.2"
                  onChange={(event) => {
                    const value = event.target.value;
                    const known = KNOWN_MODEL_FAMILIES.find(
                      (family) => family.family.toLowerCase() === value.trim().toLowerCase(),
                    );
                    autoFilled.current.delete("family");
                    const fillMaker = known && (form.maker.trim() === "" || autoFilled.current.has("maker"));
                    if (fillMaker) autoFilled.current.add("maker");
                    setForm((current) => ({
                      ...current,
                      family: value,
                      // Picking a known model fills in its maker when that is still empty.
                      maker: fillMaker && known ? known.maker : current.maker,
                    }));
                  }}
                />
                <datalist id="model-family-options">
                  {families.map((family) => (
                    <option key={family} value={family} />
                  ))}
                </datalist>
              </Field>
              <Field id="model-variant" label="Size" help={MODEL_HELP.variant}>
                <Input
                  id="model-variant"
                  list="model-variant-options"
                  value={form.variant}
                  placeholder="3B"
                  onChange={(event) => set("variant", event.target.value)}
                />
                <datalist id="model-variant-options">
                  {variants.map((variant) => (
                    <option key={variant} value={variant} />
                  ))}
                </datalist>
              </Field>
              <Field id="model-lane" label="What it's for" help={MODEL_HELP.lane}>
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
              <Field id="model-availability" label="Status" help={MODEL_HELP.availability}>
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
            <Field id="model-tags" label="Tags" help={MODEL_HELP.tags} hint="Separate tags with commas.">
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
              <HelpTip topic="favourite" text={MODEL_HELP.favorite} />
            </label>
          </SettingsSubsection>

          <SettingsSubsection title="Connection" data-testid="model-entry-section-connection">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="model-provider" label="Where it runs" help={MODEL_HELP.provider}>
                <select
                  id="model-provider"
                  className={SELECT_CLASS}
                  value={form.provider}
                  onChange={(event) => pickProvider(event.target.value as LaneAProvider)}
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
                help={MODEL_HELP.modelId}
                hint={
                  fixedModels
                    ? "Pick one of the models it offers."
                    : "Pick a suggestion or type it exactly as the provider or Ollama spells it."
                }
              >
                {fixedModels ? (
                  <select
                    id="model-id"
                    className={SELECT_CLASS}
                    value={form.model}
                    onChange={(event) => pickModel(event.target.value)}
                  >
                    {!modelChoices.some((choice) => choice.value === form.model) && (
                      <option value={form.model}>{form.model || "Pick a model"}</option>
                    )}
                    {modelChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <Input
                      id="model-id"
                      className="font-mono"
                      list="model-id-options"
                      value={form.model}
                      placeholder={
                        form.provider === "openrouter" ? "mistralai/mistral-small-3.2-24b-instruct" : "llama3.2:3b"
                      }
                      onChange={(event) => pickModel(event.target.value)}
                    />
                    <datalist id="model-id-options">
                      {modelChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
            </div>
            {form.provider === "openrouter" && (
              <div className="space-y-2" data-testid="model-entry-hosts-section">
                <div className="flex items-center gap-1">
                  <Label>Hosts for this model</Label>
                  <HelpTip topic="hosts for this model" text={MODEL_HELP.hosts} />
                </div>
                {companyId && (
                  <OpenRouterHostsTable
                    hosts={liveHosts ?? undefined}
                    loading={hostsQuery.isFetching && !liveHosts}
                    error={refreshError ?? (form.model.trim() && !hostsQuery.isFetching && !liveHosts ? hostsQuery.error : null)}
                    choices={hostChoices}
                    onChoice={chooseHost}
                    rules={hostRules}
                    routing={shownRouting}
                    onRefresh={liveHosts || hostsQuery.isError ? () => void refreshHosts() : undefined}
                    refreshing={refreshing}
                    changeNote={changeNote}
                    checkedAt={hostsQuery.data?.fetchedAt ?? null}
                  />
                )}
                <p className="text-xs text-muted-foreground" data-testid="model-entry-hosts">
                  {shownRouting?.only?.length
                    ? `Only these hosts will be used: ${shownRouting.only.join(", ")}.`
                    : "No host marked Use: OpenRouter picks a host for each request."}
                  {shownRouting?.ignore?.length ? ` Never used: ${shownRouting.ignore.join(", ")}.` : ""}
                </p>
                <details
                  className="rounded-md border border-border px-2 py-1 text-xs"
                  open={!companyId || Boolean(hostsQuery.error) || undefined}
                >
                  <summary className="cursor-pointer text-muted-foreground">Type host names yourself</summary>
                  <div className="grid gap-2 pt-2 sm:grid-cols-2">
                    <Field id="model-hosts" label="Use only these hosts" hint="Short host names, separated by commas.">
                      <Input
                        id="model-hosts"
                        value={form.hosts ?? ""}
                        placeholder="host names"
                        onChange={(event) => {
                          autoFilled.current.delete("providerRouting");
                          const value = event.target.value;
                          setForm((current) => ({ ...current, hosts: value, hostsTouched: true }));
                        }}
                        data-testid="model-hosts-input"
                      />
                    </Field>
                    <Field id="model-hosts-never" label="Never use these hosts" hint="Short host names, separated by commas.">
                      <Input
                        id="model-hosts-never"
                        value={form.ignoreHosts ?? ""}
                        placeholder="host names"
                        onChange={(event) => {
                          autoFilled.current.delete("providerRouting");
                          const value = event.target.value;
                          setForm((current) => ({ ...current, ignoreHosts: value, hostsTouched: true }));
                        }}
                        data-testid="model-hosts-never-input"
                      />
                    </Field>
                  </div>
                </details>
              </div>
            )}
            {providerUsesAddress(form.provider) ? (
              <Field
                id="model-address"
                label="Model server address"
                help={MODEL_HELP.entryAddress}
                hint={
                  !form.baseUrl.trim() && !localAddress ? (
                    <span className="text-amber-700 dark:text-amber-400" data-testid="model-entry-needs-address">
                      This company has no model server address yet. Type it here, or set it once at the top of Settings
                      &gt; Models so new local models start from it.
                    </span>
                  ) : isLoopbackAddress(form.baseUrl) ? (
                    <span className="text-amber-700 dark:text-amber-400">
                      This points at Paperclip's own server. Use it only if the models run on that same machine.
                    </span>
                  ) : (
                    "The computer that runs this model must be switched on for agents to use it."
                  )
                }
              >
                <Input
                  id="model-address"
                  className="font-mono"
                  value={form.baseUrl}
                  placeholder="http://192.168.1.20:11434/v1"
                  onChange={(event) => set("baseUrl", event.target.value)}
                />
              </Field>
            ) : (
              <p className="text-xs text-muted-foreground">
                {form.provider === "anthropic"
                  ? "No key needed: Claude runs on Paperclip's own key unless an agent picks its own under Connections."
                  : `The key for ${providerLabel(form.provider)} is set on each agent, under Connections.`}
              </p>
            )}
          </SettingsSubsection>

          <SettingsSubsection
            title="Defaults for agents"
            description="What an agent starts from when it switches to this model. Leave empty to use the model's own."
            data-testid="model-entry-section-defaults"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id="model-thinking" label="Thinking" help={MODEL_HELP.thinking}>
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
              <Field id="model-creativity" label="Creativity" help={MODEL_HELP.creativity}>
                <Input
                  id="model-creativity"
                  inputMode="decimal"
                  value={form.temperature}
                  placeholder="Default"
                  onChange={(event) => set("temperature", event.target.value)}
                />
              </Field>
              <Field id="model-length" label="Longest answer" help={MODEL_HELP.maxTokens}>
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
            title="Test scores"
            summary={ratingsSummary}
            description="Score this setup from 0 (useless) to 10 (excellent) on whatever you test, so models can be compared later. Name each score yourself, e.g. Tool calling, Responsiveness, Coding. Scores are only used to sort and compare here."
            data-testid="model-entry-section-ratings"
          >
            {form.ratings.length > 0 && (
              <ul className="space-y-2" data-testid="model-ratings">
                {form.ratings.map((row, index) => (
                  <li key={index} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_9rem_auto]">
                    <Input
                      aria-label="What you tested"
                      list="model-criteria-options"
                      value={row.criterion}
                      placeholder="Tool calling"
                      maxLength={40}
                      onChange={(event) => setRating(index, { criterion: event.target.value })}
                      data-testid={`model-rating-criterion-${index}`}
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={10}
                        step={1}
                        aria-label="Score from 0 to 10"
                        className="w-full"
                        value={Number.isFinite(Number(row.score)) && row.score !== "" ? Number(row.score) : 5}
                        onChange={(event) => setRating(index, { score: event.target.value })}
                      />
                      <Input
                        aria-label="Score"
                        inputMode="numeric"
                        className="w-12 px-1 text-center"
                        value={row.score}
                        onChange={(event) => setRating(index, { score: event.target.value })}
                        data-testid={`model-rating-score-${index}`}
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove this score"
                      title="Remove this score"
                      onClick={() =>
                        setForm((current) => ({ ...current, ratings: current.ratings.filter((_, i) => i !== index) }))
                      }
                    >
                      <X />
                    </Button>
                    <Input
                      aria-label="Note about this score"
                      className="sm:col-span-3"
                      value={row.note}
                      maxLength={300}
                      placeholder="Note (optional), e.g. slow on long chats"
                      onChange={(event) => setRating(index, { note: event.target.value })}
                    />
                  </li>
                ))}
              </ul>
            )}
            <datalist id="model-criteria-options">
              {criteria.map((criterion) => (
                <option key={criterion} value={criterion} />
              ))}
            </datalist>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={form.ratings.length >= MODEL_DIRECTORY_RATINGS_MAX}
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  ratings: [...current.ratings, { criterion: "", score: "5", note: "", changed: true }],
                }))
              }
              data-testid="model-rating-add"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add a score
            </Button>
          </SettingsSubsection>

          <SettingsSubsection
            title="Details"
            summary={specsSummary}
            defaultOpen={false}
            description="Facts that help you pick a model. Paperclip does not check or enforce them."
            data-testid="model-entry-section-details"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="model-spec-params" label="Size in parameters" help={MODEL_HELP.params}>
                <Input
                  id="model-spec-params"
                  value={form.specs.params}
                  placeholder="27B"
                  onChange={(event) => setSpec("params", event.target.value)}
                />
              </Field>
              <Field id="model-spec-quant" label="Quantisation" help={MODEL_HELP.quant}>
                <Input
                  id="model-spec-quant"
                  value={form.specs.quant}
                  placeholder="Q4_K_M"
                  onChange={(event) => setSpec("quant", event.target.value)}
                />
              </Field>
              <Field id="model-spec-size" label="Download size (GB)" help={MODEL_HELP.sizeGb}>
                <Input
                  id="model-spec-size"
                  inputMode="decimal"
                  value={form.specs.sizeGb}
                  placeholder="16.5"
                  onChange={(event) => setSpec("sizeGb", event.target.value)}
                />
              </Field>
              <Field id="model-spec-context" label="Context length (tokens)" help={MODEL_HELP.context}>
                <Input
                  id="model-spec-context"
                  inputMode="numeric"
                  value={form.specs.contextTokens}
                  placeholder="131072"
                  onChange={(event) => setSpec("contextTokens", event.target.value)}
                />
              </Field>
              <Field id="model-spec-fits" label="Fits the graphics card" help={MODEL_HELP.fits}>
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
              <Field id="model-spec-tools" label="Tool use" help={MODEL_HELP.tools}>
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
              <Field id="model-spec-vision" label="Pictures" help={MODEL_HELP.vision}>
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
              <Field id="model-spec-thinking" label="Thinking support" help={MODEL_HELP.thinkingSupport}>
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
              <Field id="model-spec-license" label="Licence" help={MODEL_HELP.license}>
                <Input
                  id="model-spec-license"
                  value={form.specs.license}
                  placeholder="Apache 2.0"
                  onChange={(event) => setSpec("license", event.target.value)}
                />
              </Field>
              <Field id="model-spec-link" label="Model page link" help={MODEL_HELP.sourceUrl}>
                <Input
                  id="model-spec-link"
                  value={form.specs.sourceUrl}
                  placeholder="https://huggingface.co/…"
                  onChange={(event) => setSpec("sourceUrl", event.target.value)}
                />
              </Field>
            </div>
            <Field id="model-spec-pull" label="Install command" help={MODEL_HELP.pullCommand}>
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
            <Field id="model-note" label="Note (optional)" help={MODEL_HELP.note}>
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
          <Button onClick={() => onSave(bodyFromForm(form, hostCtx))} disabled={!canSave || busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {entry ? "Save changes" : "Add model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
