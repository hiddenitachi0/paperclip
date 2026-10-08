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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Backups": up to five other models a quick agent can fall back on, two
 * ordered lists that say which backup to try when the main model does not
 * answer or refuses, and keyword rules that start a message on a chosen
 * backup. Everything is edited as one draft and saved together, because the
 * lists point at backups by id and must never be saved out of step.
 *
 * Each backup can be filled from one of the company's saved models (Settings
 * > Models), the same way the main model can. A backup picked that way keeps
 * a link to the saved model (`directoryEntryId`), so it follows later edits
 * to it; changing any of its fields by hand turns it back into a custom
 * backup. Saved models never carry a key: a backup still borrows the main
 * model's key, exactly as before.
 */

type PoolDraft = {
  id: string;
  provider: LaneAProvider;
  model: string;
  baseUrl: string;
  /** "" = model default. */
  temperature: string;
  /** The saved model this backup follows, or null for a custom backup. */
  directoryEntryId: string | null;
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

/**
 * A backup that follows a saved model runs on that saved model's current
 * settings (the server reads them at call time), so it is shown with them
 * too, not with the copy stored when it was last saved. Saving then also
 * refreshes that stored copy.
 */
function draftFromSaved(saved: Saved, savedModels: ModelDirectoryEntry[] | undefined): Draft {
  return {
    pool: (saved.backups ?? []).map((entry) => {
      const linked = entry.directoryEntryId
        ? savedModels?.find((candidate) => candidate.id === entry.directoryEntryId)
        : undefined;
      if (linked) return { id: entry.id, ...backupFieldsFromDirectoryEntry(linked) };
      return {
        id: entry.id,
        provider: normalizeLaneAProvider(entry.provider),
        model: entry.model,
        baseUrl: entry.baseUrl ?? "",
        temperature: entry.temperature === null || entry.temperature === undefined ? "" : String(entry.temperature),
        directoryEntryId: entry.directoryEntryId ?? null,
      };
    }),
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

/**
 * What picking a saved model fills on one backup: every field a backup has,
 * with the ones that do not apply to the saved model's provider cleared (an
 * address only for a provider that takes one). Host routing, thinking and
 * answer length are not part of a backup, so they are not copied.
 */
export function backupFieldsFromDirectoryEntry(
  entry: ModelDirectoryEntry,
): Pick<PoolDraft, "provider" | "model" | "baseUrl" | "temperature" | "directoryEntryId"> {
  const provider = normalizeLaneAProvider(entry.provider);
  const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
  return {
    provider,
    model: entry.model,
    baseUrl: descriptor.baseUrlEditable ? (entry.baseUrl ?? "") : "",
    temperature:
      entry.defaultTemperature === null || entry.defaultTemperature === undefined ? "" : String(entry.defaultTemperature),
    directoryEntryId: entry.id,
  };
}

/**
 * `knownSavedModelIds`: the company's saved model ids when they are loaded.
 * A link to a saved model that has since been deleted is dropped (the server
 * would refuse it, and the backup already runs on its own copy of the
 * fields); when the list is not known, links are sent as they are.
 */
function draftToPatch(draft: Draft, knownSavedModelIds: ReadonlySet<string> | null = null): BackupSettingsPatch {
  return {
    laneABackupModels: draft.pool.map((entry) => {
      const descriptor = LANE_A_PROVIDER_CATALOGUE[entry.provider];
      const baseUrl = entry.baseUrl.trim();
      const link =
        entry.directoryEntryId && (!knownSavedModelIds || knownSavedModelIds.has(entry.directoryEntryId))
          ? entry.directoryEntryId
          : null;
      return {
        id: entry.id,
        provider: entry.provider,
        model: entry.model.trim(),
        ...(descriptor.baseUrlEditable && baseUrl ? { baseUrl } : {}),
        ...(entry.temperature !== "" ? { temperature: Number(entry.temperature) } : {}),
        ...(link ? { directoryEntryId: link } : {}),
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

export function QuickAgentBackupModels({
  saved,
  main,
  savedModels,
  disabled,
  saving,
  onSave,
}: {
  saved: Saved;
  main: { provider: LaneAProvider; baseUrl: string | null; hasKey: boolean };
  /**
   * The company's saved models (Settings > Models), offered as a one-click
   * fill on every backup. Undefined while they are loading or could not be
   * loaded; then only manual entry is offered.
   */
  savedModels?: ModelDirectoryEntry[];
  /** True when the person looking cannot edit (the whole form's own permission bar). */
  disabled?: boolean;
  saving?: boolean;
  onSave: (patch: BackupSettingsPatch) => Promise<unknown>;
}) {
  const savedDraft = useMemo(() => draftFromSaved(saved, savedModels), [saved, savedModels]);
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

  const dirty = JSON.stringify(draft) !== savedKey;
  const problems = draftProblems(draft);
  const readOnly = Boolean(disabled);
  const busy = readOnly || Boolean(saving);

  const savedModelList = savedModels ?? [];
  const savedModelById = (id: string | null): ModelDirectoryEntry | undefined =>
    id ? savedModelList.find((candidate) => candidate.id === id) : undefined;

  const label = (id: string): string => {
    const index = draft.pool.findIndex((entry) => entry.id === id);
    if (index < 0) return "A backup that was removed";
    const entry = draft.pool[index]!;
    const linked = savedModelById(entry.directoryEntryId);
    if (linked) return `Backup ${index + 1} (${linked.name})`;
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

  /** A change made by hand: the backup no longer follows a saved model. */
  const editEntry = (id: string, patch: Partial<PoolDraft>) => updateEntry(id, { ...patch, directoryEntryId: null });

  const pickSavedModel = (entry: PoolDraft, savedModelId: string) => {
    if (!savedModelId) {
      // "Custom": keep what is filled in, stop following the saved model.
      updateEntry(entry.id, { directoryEntryId: null });
      return;
    }
    const picked = savedModelById(savedModelId);
    if (picked) updateEntry(entry.id, backupFieldsFromDirectoryEntry(picked));
  };

  const addEntry = (fromSavedModel?: ModelDirectoryEntry) =>
    setDraft((current) => {
      if (current.pool.length >= LANE_A_BACKUP_MODELS_MAX) return current;
      const provider: LaneAProvider = "anthropic";
      const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
      const fields = fromSavedModel
        ? backupFieldsFromDirectoryEntry(fromSavedModel)
        : { provider, model: descriptor.defaultModel ?? "", baseUrl: "", temperature: "", directoryEntryId: null };
      return { ...current, pool: [...current.pool, { id: newId("bk"), ...fields }] };
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
    editEntry(entry.id, {
      provider,
      model: descriptor.freeForm ? "" : (descriptor.defaultModel ?? ""),
      baseUrl: descriptor.baseUrlEditable ? entry.baseUrl : "",
    });
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
      await onSave(draftToPatch(draft, savedModels ? new Set(savedModels.map((entry) => entry.id)) : null));
    } catch {
      // The card above already shows why it could not be saved.
    }
  };

  const canAddRoute = draft.pool.length > 0 && draft.routes.length < LANE_A_KEYWORD_ROUTES_MAX;
  const atLimit = draft.pool.length >= LANE_A_BACKUP_MODELS_MAX;
  // Saved models not already used as a backup, for the one-step "add" picker.
  const addableSavedModels = savedModelList.filter(
    (candidate) => !draft.pool.some((entry) => entry.directoryEntryId === candidate.id),
  );

  return (
    <div className="space-y-4" data-testid="quick-agent-backups">
      <p className="text-xs text-muted-foreground">
        Add up to {LANE_A_BACKUP_MODELS_MAX} other models. When the main model does not answer, or refuses, the next one
        is tried. The person chatting only sees the final reply.
      </p>

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
          const linked = savedModelById(entry.directoryEntryId);
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

              {savedModelList.length > 0 && (
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">Saved model</span>
                  <select
                    className={selectClass}
                    value={linked ? linked.id : ""}
                    disabled={busy}
                    data-testid={`backup-saved-model-${index}`}
                    onChange={(event) => pickSavedModel(entry, event.target.value)}
                  >
                    <option value="">Custom (set it up below)</option>
                    {savedModelList.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                  <span className="block text-xs text-muted-foreground" data-testid={`backup-saved-model-hint-${index}`}>
                    {linked
                      ? "Follows this saved model, so changes to it under Settings > Models apply here too. Changing a field below makes this a custom backup."
                      : "Picking a saved model fills the fields below and clears the ones that don't apply to it."}
                  </span>
                </label>
              )}

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
                    onChange={(event) => editEntry(entry.id, { model: event.target.value })}
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
                    onChange={(event) => editEntry(entry.id, { model: event.target.value })}
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
                    onChange={(event) => editEntry(entry.id, { baseUrl: event.target.value })}
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
                  onChange={(event) => editEntry(entry.id, { temperature: event.target.value })}
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

      <div className="flex flex-wrap items-center gap-2">
        {addableSavedModels.length > 0 && (
          <select
            className={`${selectClass} sm:w-auto`}
            value=""
            disabled={busy || atLimit}
            aria-label="Add a saved model as a backup"
            data-testid="backup-add-saved"
            onChange={(event) => {
              const picked = savedModelById(event.target.value);
              if (picked) addEntry(picked);
            }}
          >
            <option value="">Add a saved model as a backup…</option>
            {addableSavedModels.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || atLimit}
          data-testid="backup-add"
          onClick={() => addEntry()}
        >
          {savedModelList.length > 0 ? "Add a custom backup" : "Add a backup"}
        </Button>
      </div>
      {atLimit && (
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
