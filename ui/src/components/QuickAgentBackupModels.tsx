import { useEffect, useMemo, useState } from "react";
import {
  LANE_A_BACKUP_MODELS_MAX,
  LANE_A_KEYWORD_ROUTES_MAX,
  LANE_A_KEYWORD_ROUTE_PHRASES_MAX,
  LANE_A_KEYWORD_ROUTE_PHRASE_MAX_LENGTH,
  LANE_A_PROVIDERS,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_TEMPERATURE_PRESETS,
  laneABackupModelEntryIssue,
  laneAModelsForProvider,
  normalizeLaneAProvider,
  type LaneABackupModelConfig,
  type LaneAKeywordRoute,
  type LaneAProvider,
  type ModelDirectoryEntry,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { filterEntries, pickerGroups } from "@/lib/model-catalogue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Backups": up to five other models a quick agent can fall back on, two
 * ordered lists that say which backup to try when the main model does not
 * answer or refuses, and keyword rules that start a message on a chosen
 * backup. Everything is edited as one draft and saved together, because the
 * lists point at backups by id and must never be saved out of step.
 */

type PoolDraft = {
  id: string;
  provider: LaneAProvider;
  model: string;
  baseUrl: string;
  /** "" = model default. */
  temperature: string;
  /** Saved model (Settings > Models) this backup uses; "" = typed in by hand. */
  directoryEntryId: string;
};

type RouteDraft = { id: string; phrases: string; backupId: string };

type Draft = {
  pool: PoolDraft[];
  noAnswer: string[];
  refusal: string[];
  routes: RouteDraft[];
};

export type BackupSettingsPatch = {
  laneABackupModels: LaneABackupModelConfig[];
  laneANoAnswerChainIds: string[];
  laneARefusalChainIds: string[];
  laneAKeywordRoutes: LaneAKeywordRoute[];
};

type Saved = {
  backups?: LaneABackupModelConfig[] | null;
  noAnswerChainIds?: string[] | null;
  refusalChainIds?: string[] | null;
  keywordRoutes?: LaneAKeywordRoute[] | null;
};

const selectClass = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : `${Date.now().toString(36)}${idCounter}`;
  return `${prefix}_${random}`;
}

function draftFromSaved(saved: Saved): Draft {
  return {
    pool: (saved.backups ?? []).map((entry) => ({
      id: entry.id,
      provider: normalizeLaneAProvider(entry.provider),
      model: entry.model,
      baseUrl: entry.baseUrl ?? "",
      temperature: entry.temperature === null || entry.temperature === undefined ? "" : String(entry.temperature),
      directoryEntryId: entry.directoryEntryId ?? "",
    })),
    noAnswer: [...(saved.noAnswerChainIds ?? [])],
    refusal: [...(saved.refusalChainIds ?? [])],
    routes: (saved.keywordRoutes ?? []).map((route) => ({
      id: route.id,
      phrases: route.phrases.join(", "),
      backupId: route.backupId,
    })),
  };
}

function parsePhrases(text: string): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const phrase = part.trim();
    if (!phrase || seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    phrases.push(phrase);
  }
  return phrases;
}

function move<T>(list: T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Plain reason an entry cannot be saved, or null. */
function entryProblem(entry: PoolDraft): string | null {
  const issue = laneABackupModelEntryIssue({ provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl });
  if (issue) return issue;
  if (entry.model.trim() === "") return "Pick a model.";
  return null;
}

function draftToPatch(draft: Draft): BackupSettingsPatch {
  return {
    laneABackupModels: draft.pool.map((entry) => {
      const descriptor = LANE_A_PROVIDER_CATALOGUE[entry.provider];
      const baseUrl = entry.baseUrl.trim();
      return {
        id: entry.id,
        provider: entry.provider,
        model: entry.model.trim(),
        ...(descriptor.baseUrlEditable && baseUrl ? { baseUrl } : {}),
        ...(entry.temperature !== "" ? { temperature: Number(entry.temperature) } : {}),
        ...(entry.directoryEntryId ? { directoryEntryId: entry.directoryEntryId } : {}),
      };
    }),
    laneANoAnswerChainIds: draft.noAnswer,
    laneARefusalChainIds: draft.refusal,
    laneAKeywordRoutes: draft.routes.map((route) => ({
      id: route.id,
      phrases: parsePhrases(route.phrases),
      backupId: route.backupId,
    })),
  };
}

/** Everything wrong with the draft, in plain words; empty when it can be saved. */
function draftProblems(draft: Draft): string[] {
  const problems: string[] = [];
  draft.pool.forEach((entry, index) => {
    const problem = entryProblem(entry);
    if (problem) problems.push(`Backup ${index + 1}: ${problem}`);
  });
  draft.routes.forEach((route, index) => {
    const phrases = parsePhrases(route.phrases);
    if (phrases.length === 0) problems.push(`Keyword rule ${index + 1}: add at least one word or phrase.`);
    if (phrases.length > LANE_A_KEYWORD_ROUTE_PHRASES_MAX) {
      problems.push(`Keyword rule ${index + 1}: use at most ${LANE_A_KEYWORD_ROUTE_PHRASES_MAX} words or phrases.`);
    }
    if (phrases.some((phrase) => phrase.length > LANE_A_KEYWORD_ROUTE_PHRASE_MAX_LENGTH)) {
      problems.push(
        `Keyword rule ${index + 1}: each word or phrase can be at most ${LANE_A_KEYWORD_ROUTE_PHRASE_MAX_LENGTH} letters long.`,
      );
    }
    if (!route.backupId) problems.push(`Keyword rule ${index + 1}: pick which backup to use.`);
  });
  return problems;
}

export type BackupCheckResult = { ok: boolean; text: string };

/**
 * "Test this one": answers in plain words whether this backup could run.
 * A backup can only borrow the main model's saved key when it uses the same
 * provider and address; Claude and local models can run without one.
 */
export function checkBackupEntry(
  entry: PoolDraft,
  main: { provider: LaneAProvider; baseUrl: string | null; hasKey: boolean },
): BackupCheckResult {
  const problem = entryProblem(entry);
  if (problem) return { ok: false, text: problem };
  const label = LANE_A_PROVIDER_CATALOGUE[entry.provider].label;
  const descriptor = LANE_A_PROVIDER_CATALOGUE[entry.provider];
  const entryUrl = descriptor.baseUrlEditable ? entry.baseUrl.trim() || null : null;
  const sameAsMain = entry.provider === main.provider && entryUrl === (main.baseUrl?.trim() || null);
  if (sameAsMain && main.hasKey) return { ok: true, text: `Ready. It uses the same ${label} key as the main model.` };
  if (entry.provider === "anthropic") {
    return { ok: true, text: "Ready, as long as Paperclip's own Claude key is set." };
  }
  if (entry.provider === "local") {
    return {
      ok: true,
      text: `Ready to try. Paperclip will reach out to ${entryUrl} when it is needed; make sure that computer is switched on.`,
    };
  }
  return {
    ok: false,
    text: `No key to use. A backup can only borrow the main model's key, so it needs the same provider and address as the main model, or ${LANE_A_PROVIDER_CATALOGUE.anthropic.label} or a local model, which need no key here.`,
  };
}

/**
 * The draft fields a saved model fills in. The server uses the saved model's
 * own settings at call time; these copies are what is used if that saved
 * model is later deleted.
 */
export function backupFieldsFromSavedModel(
  entry: Pick<ModelDirectoryEntry, "id" | "provider" | "model" | "baseUrl" | "defaultTemperature">,
): Pick<PoolDraft, "provider" | "model" | "baseUrl" | "temperature" | "directoryEntryId"> {
  const provider = normalizeLaneAProvider(entry.provider);
  return {
    provider,
    model: entry.model,
    baseUrl: LANE_A_PROVIDER_CATALOGUE[provider].baseUrlEditable ? (entry.baseUrl ?? "") : "",
    temperature:
      entry.defaultTemperature === null || entry.defaultTemperature === undefined ? "" : String(entry.defaultTemperature),
    directoryEntryId: entry.id,
  };
}

export function QuickAgentBackupModels({
  saved,
  main,
  savedModels = [],
  disabled,
  saving,
  onSave,
}: {
  saved: Saved;
  main: { provider: LaneAProvider; baseUrl: string | null; hasKey: boolean };
  /** Saved models from Settings > Models (archived ones are left out). */
  savedModels?: readonly ModelDirectoryEntry[];
  /** True when the person looking cannot edit (the whole form's own permission bar). */
  disabled?: boolean;
  saving?: boolean;
  onSave: (patch: BackupSettingsPatch) => Promise<unknown>;
}) {
  const savedDraft = useMemo(() => draftFromSaved(saved), [saved]);
  const savedKey = JSON.stringify(savedDraft);
  const [draft, setDraft] = useState<Draft>(savedDraft);
  const [checks, setChecks] = useState<Record<string, BackupCheckResult>>({});
  const [showProblems, setShowProblems] = useState(false);

  // A fresh copy from the server replaces the draft (after a save, or when
  // another tab changed it).
  useEffect(() => {
    setDraft(savedDraft);
    setShowProblems(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const pickable = useMemo(() => filterEntries(savedModels, {}), [savedModels]);
  // "Meta · Llama 3.2" > "3B · On your PC (llama3.2:latest)", so two setups of one model can be told apart.
  const pickableGroups = useMemo(() => pickerGroups(pickable), [pickable]);
  const savedModelById = useMemo(() => new Map(savedModels.map((entry) => [entry.id, entry])), [savedModels]);

  const dirty = JSON.stringify(draft) !== savedKey;
  const problems = draftProblems(draft);
  const readOnly = Boolean(disabled);
  const busy = readOnly || Boolean(saving);

  const label = (id: string): string => {
    const index = draft.pool.findIndex((entry) => entry.id === id);
    if (index < 0) return "A backup that was removed";
    const entry = draft.pool[index]!;
    const savedModel = entry.directoryEntryId ? savedModelById.get(entry.directoryEntryId) : undefined;
    if (savedModel) return `Backup ${index + 1} (${savedModel.name})`;
    const providerLabel = LANE_A_PROVIDER_CATALOGUE[entry.provider].label;
    return `Backup ${index + 1} (${providerLabel}${entry.model ? `, ${entry.model}` : ""})`;
  };

  const updateEntry = (id: string, patch: Partial<PoolDraft>) => {
    setChecks((current) => {
      const { [id]: _dropped, ...rest } = current;
      return rest;
    });
    setDraft((current) => ({
      ...current,
      pool: current.pool.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    }));
  };

  const addEntry = () =>
    setDraft((current) => {
      if (current.pool.length >= LANE_A_BACKUP_MODELS_MAX) return current;
      const provider: LaneAProvider = "anthropic";
      const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
      return {
        ...current,
        pool: [
          ...current.pool,
          {
            id: newId("bk"),
            provider,
            model: descriptor.defaultModel ?? "",
            baseUrl: "",
            temperature: "",
            directoryEntryId: "",
          },
        ],
      };
    });

  const removeEntry = (id: string) =>
    setDraft((current) => ({
      pool: current.pool.filter((entry) => entry.id !== id),
      noAnswer: current.noAnswer.filter((value) => value !== id),
      refusal: current.refusal.filter((value) => value !== id),
      routes: current.routes.filter((route) => route.backupId !== id),
    }));

  const changeProvider = (entry: PoolDraft, raw: string) => {
    const provider = normalizeLaneAProvider(raw);
    const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
    updateEntry(entry.id, {
      provider,
      model: descriptor.freeForm ? "" : (descriptor.defaultModel ?? ""),
      baseUrl: descriptor.baseUrlEditable ? entry.baseUrl : "",
    });
  };

  const pickSavedModel = (entry: PoolDraft, value: string) => {
    if (!value) {
      // "Type it myself": keep the fields as they are, just stop following the saved model.
      updateEntry(entry.id, { directoryEntryId: "" });
      return;
    }
    const savedModel = savedModelById.get(value);
    if (savedModel) updateEntry(entry.id, backupFieldsFromSavedModel(savedModel));
  };

  const setChain = (which: "noAnswer" | "refusal", next: string[]) =>
    setDraft((current) => ({ ...current, [which]: next }));

  const save = async () => {
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    setShowProblems(false);
    try {
      await onSave(draftToPatch(draft));
    } catch {
      // The card above already shows why it could not be saved.
    }
  };

  const canAddRoute = draft.pool.length > 0 && draft.routes.length < LANE_A_KEYWORD_ROUTES_MAX;

  return (
    <div className="space-y-4 border-t pt-4" data-testid="quick-agent-backups">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Backups (if this one does not answer)</p>
        <p className="text-xs text-muted-foreground">
          Add up to {LANE_A_BACKUP_MODELS_MAX} other models. When the main model does not answer, or refuses, the next
          one is tried. The person chatting only sees the final reply.
        </p>
      </div>

      {draft.pool.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="backup-empty">
          No backups yet. If the main model does not answer, the person gets an error message.
        </p>
      )}

      <ol className="space-y-3">
        {draft.pool.map((entry, index) => {
          const descriptor = LANE_A_PROVIDER_CATALOGUE[entry.provider];
          const models = laneAModelsForProvider(entry.provider);
          const check = checks[entry.id];
          const linked = entry.directoryEntryId !== "";
          const linkedModel = linked ? savedModelById.get(entry.directoryEntryId) : undefined;
          return (
            <li
              key={entry.id}
              className="space-y-2 rounded-md border border-border p-3"
              data-testid={`backup-entry-${index}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">Backup {index + 1}</span>
                <span className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || index === 0}
                    aria-label={`Move backup ${index + 1} up`}
                    onClick={() => setDraft((current) => ({ ...current, pool: move(current.pool, index, -1) }))}
                  >
                    Move up
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || index === draft.pool.length - 1}
                    aria-label={`Move backup ${index + 1} down`}
                    onClick={() => setDraft((current) => ({ ...current, pool: move(current.pool, index, 1) }))}
                  >
                    Move down
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={`Remove backup ${index + 1}`}
                    onClick={() => removeEntry(entry.id)}
                  >
                    Remove
                  </Button>
                </span>
              </div>

              {(pickable.length > 0 || linked) && (
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">Saved model</span>
                  <select
                    className={selectClass}
                    value={entry.directoryEntryId}
                    disabled={busy}
                    data-testid={`backup-saved-model-${index}`}
                    onChange={(event) => pickSavedModel(entry, event.target.value)}
                  >
                    <option value="">Type it myself</option>
                    {linked && !linkedModel && (
                      <option value={entry.directoryEntryId}>A saved model that is no longer in the list</option>
                    )}
                    {pickableGroups.map((group) => (
                      <optgroup key={group.key} label={group.label}>
                        {group.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {linked ? (
                    <span className="block text-xs text-muted-foreground" data-testid={`backup-saved-model-summary-${index}`}>
                      {linkedModel
                        ? `Uses "${linkedModel.name}" (${LANE_A_PROVIDER_CATALOGUE[entry.provider].label}, ${entry.model}). Changes you make to it in Settings > Models apply here too.`
                        : `This saved model was archived or deleted. It keeps using ${LANE_A_PROVIDER_CATALOGUE[entry.provider].label}, ${entry.model}. Pick another saved model or choose "Type it myself".`}{" "}
                      <Link to="/company/settings/models" className="underline">
                        Manage saved models
                      </Link>
                      .
                    </span>
                  ) : (
                    <span className="block text-xs text-muted-foreground">
                      Pick one of your saved models, or type the details in below.
                    </span>
                  )}
                </label>
              )}

              {!linked && (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">Who answers</span>
                    <select
                      className={selectClass}
                      value={entry.provider}
                      disabled={busy}
                      data-testid={`backup-provider-${index}`}
                      onChange={(event) => changeProvider(entry, event.target.value)}
                    >
                      {LANE_A_PROVIDERS.map((provider) => (
                        <option key={provider} value={provider}>
                          {LANE_A_PROVIDER_CATALOGUE[provider].label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {descriptor.freeForm ? (
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">Model</span>
                      <Input
                        value={entry.model}
                        disabled={busy}
                        data-testid={`backup-model-${index}`}
                        placeholder={entry.provider === "openrouter" ? "openai/gpt-4.1-mini" : "llama3.1"}
                        onChange={(event) => updateEntry(entry.id, { model: event.target.value })}
                      />
                    </label>
                  ) : (
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">Model</span>
                      <select
                        className={selectClass}
                        value={models.includes(entry.model) ? entry.model : ""}
                        disabled={busy}
                        data-testid={`backup-model-${index}`}
                        onChange={(event) => updateEntry(entry.id, { model: event.target.value })}
                      >
                        {!models.includes(entry.model) && <option value="">Pick a model</option>}
                        {models.map((model) => (
                          <option key={model} value={model}>
                            {descriptor.models[model]?.label ?? model} ({model})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {descriptor.baseUrlEditable && (
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">Address</span>
                      <Input
                        value={entry.baseUrl}
                        disabled={busy}
                        data-testid={`backup-baseurl-${index}`}
                        placeholder={descriptor.defaultBaseUrl ?? "http://localhost:11434/v1"}
                        onChange={(event) => updateEntry(entry.id, { baseUrl: event.target.value })}
                      />
                    </label>
                  )}

                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">Creativity</span>
                    <select
                      className={selectClass}
                      value={entry.temperature}
                      disabled={busy}
                      data-testid={`backup-temperature-${index}`}
                      onChange={(event) => updateEntry(entry.id, { temperature: event.target.value })}
                    >
                      <option value="">Model default</option>
                      {LANE_A_TEMPERATURE_PRESETS.map((preset) => (
                        <option key={preset.value} value={String(preset.value)}>
                          {preset.label} ({preset.value})
                        </option>
                      ))}
                      {entry.temperature !== "" &&
                        !LANE_A_TEMPERATURE_PRESETS.some((preset) => String(preset.value) === entry.temperature) && (
                          <option value={entry.temperature}>Custom ({entry.temperature})</option>
                        )}
                    </select>
                  </label>
                </>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={readOnly}
                  data-testid={`backup-test-${index}`}
                  onClick={() => setChecks((current) => ({ ...current, [entry.id]: checkBackupEntry(entry, main) }))}
                >
                  Test this one
                </Button>
                {check && (
                  <span
                    className={`text-xs ${check.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                    role="status"
                    data-testid={`backup-test-result-${index}`}
                  >
                    {check.text}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || draft.pool.length >= LANE_A_BACKUP_MODELS_MAX}
        data-testid="backup-add"
        onClick={addEntry}
      >
        Add a backup
      </Button>
      {draft.pool.length >= LANE_A_BACKUP_MODELS_MAX && (
        <p className="text-xs text-muted-foreground" data-testid="backup-limit">
          That is the most you can add ({LANE_A_BACKUP_MODELS_MAX}). Remove one to add another.
        </p>
      )}

      {draft.pool.length > 0 && (
        <div className="space-y-4">
          <ChainEditor
            title="If it does not answer"
            hint="Tried in this order when the model is too slow, switched off or cannot be reached."
            testId="backup-chain-no-answer"
            ids={draft.noAnswer}
            pool={draft.pool.map((entry) => entry.id)}
            label={label}
            disabled={busy}
            onChange={(next) => setChain("noAnswer", next)}
          />
          <ChainEditor
            title="If it refuses"
            hint="Tried in this order when the model says it cannot or will not help with a message."
            testId="backup-chain-refusal"
            ids={draft.refusal}
            pool={draft.pool.map((entry) => entry.id)}
            label={label}
            disabled={busy}
            onChange={(next) => setChain("refusal", next)}
          />

          <div className="space-y-2" data-testid="backup-routes">
            <div className="space-y-1">
              <p className="text-xs font-medium">Start with a different model for certain words</p>
              <p className="text-xs text-muted-foreground">
                If a message contains one of these words or phrases, that backup answers first instead of the main
                model. The first rule that matches is used.
              </p>
            </div>
            <ul className="space-y-2">
              {draft.routes.map((route, index) => (
                <li key={route.id} className="space-y-2 rounded-md border border-border p-3" data-testid={`backup-route-${index}`}>
                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">Words or phrases (separate with commas)</span>
                    <Input
                      value={route.phrases}
                      disabled={busy}
                      data-testid={`backup-route-phrases-${index}`}
                      placeholder="invoice, refund"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          routes: current.routes.map((r) => (r.id === route.id ? { ...r, phrases: event.target.value } : r)),
                        }))
                      }
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">Then start with</span>
                    <select
                      className={selectClass}
                      value={route.backupId}
                      disabled={busy}
                      data-testid={`backup-route-target-${index}`}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          routes: current.routes.map((r) => (r.id === route.id ? { ...r, backupId: event.target.value } : r)),
                        }))
                      }
                    >
                      {!route.backupId && <option value="">Pick a backup</option>}
                      {draft.pool.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {label(entry.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || index === 0}
                      aria-label={`Move keyword rule ${index + 1} up`}
                      onClick={() => setDraft((current) => ({ ...current, routes: move(current.routes, index, -1) }))}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || index === draft.routes.length - 1}
                      aria-label={`Move keyword rule ${index + 1} down`}
                      onClick={() => setDraft((current) => ({ ...current, routes: move(current.routes, index, 1) }))}
                    >
                      Move down
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={`Remove keyword rule ${index + 1}`}
                      onClick={() =>
                        setDraft((current) => ({ ...current, routes: current.routes.filter((r) => r.id !== route.id) }))
                      }
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !canAddRoute}
              data-testid="backup-route-add"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  routes: [...current.routes, { id: newId("kw"), phrases: "", backupId: current.pool[0]?.id ?? "" }],
                }))
              }
            >
              Add a word rule
            </Button>
          </div>
        </div>
      )}

      {showProblems && problems.length > 0 && (
        <ul className="space-y-1 text-xs text-destructive" role="alert" data-testid="backup-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={!dirty || Boolean(saving)} data-testid="backup-save" onClick={() => void save()}>
            {saving ? "Saving…" : "Save backups"}
          </Button>
          {dirty && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(saving)}
              data-testid="backup-discard"
              onClick={() => {
                setDraft(savedDraft);
                setChecks({});
                setShowProblems(false);
              }}
            >
              Undo changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ChainEditor({
  title,
  hint,
  testId,
  ids,
  pool,
  label,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  testId: string;
  ids: string[];
  pool: string[];
  label: (id: string) => string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const available = pool.filter((id) => !ids.includes(id));
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="space-y-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {ids.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing is tried after the main model.</p>
      ) : (
        <ol className="space-y-1.5">
          {ids.map((id, index) => (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid={`${testId}-item-${index}`}>
              <span>
                {index + 1}. {label(id)}
              </span>
              <span className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || index === 0}
                  aria-label={`Try ${label(id)} earlier (${title})`}
                  onClick={() => onChange(move(ids, index, -1))}
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || index === ids.length - 1}
                  aria-label={`Try ${label(id)} later (${title})`}
                  onClick={() => onChange(move(ids, index, 1))}
                >
                  Move down
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Take ${label(id)} out (${title})`}
                  onClick={() => onChange(ids.filter((value) => value !== id))}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {available.length > 0 && (
        <select
          className={selectClass}
          value=""
          disabled={disabled}
          aria-label={`Add a backup to "${title}"`}
          data-testid={`${testId}-add`}
          onChange={(event) => {
            if (event.target.value) onChange([...ids, event.target.value]);
          }}
        >
          <option value="">Add a backup to this list…</option>
          {available.map((id) => (
            <option key={id} value={id}>
              {label(id)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
