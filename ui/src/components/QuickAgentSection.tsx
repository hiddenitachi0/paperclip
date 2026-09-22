import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LANE_A_DEFAULT_MAX_OUTPUT_TOKENS,
  LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_INSTRUCTIONS_MAX_LENGTH,
  LANE_A_MAX_MAX_OUTPUT_TOKENS,
  LANE_A_MAX_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_MIN_MAX_OUTPUT_TOKENS,
  LANE_A_MIN_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_PROVIDERS,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_TRANSFORM_MAX_TOTAL_CHARS,
  laneAModelsForProvider,
  laneATransformWorstCaseDailyCents,
  normalizeLaneAProvider,
  type CompanySecret,
  type LaneAProvider,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { budgetsApi } from "../api/budgets";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SecretBindingPicker, type SecretBindingValue } from "./SecretBindingPicker";

/**
 * Quick agent settings: the on/off switch plus the instruction set the quick
 * agent follows. Both are board-only on the server (the API refuses anyone
 * else), so this card is only ever useful to the operator.
 *
 * DUR-3997: the card also chooses which provider answers (Claude, OpenAI,
 * Google, OpenRouter or a local model) and which of the company's saved keys
 * it uses. The key is stored as a secret binding at adapterConfig.laneA.apiKey,
 * never as text on the agent.
 */
export function QuickAgentSection({
  agent,
  companyId,
}: {
  agent: {
    id: string;
    urlKey: string;
    companyId: string;
    name: string;
    adapterConfig?: Record<string, unknown>;
    laneAEnabled?: boolean;
    laneAInstructions?: string | null;
    laneAModel?: string | null;
    laneAMaxOutputTokens?: number | null;
    laneATransformDailyCallCap?: number | null;
    laneAProvider?: string | null;
    laneABaseUrl?: string | null;
  };
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const savedEnabled = Boolean(agent.laneAEnabled);
  const savedInstructions = agent.laneAInstructions ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveCompanyId = companyId ?? agent.companyId;

  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [savedInstructions]);

  const instructions = draft ?? savedInstructions;
  const dirty = draft !== null && draft !== savedInstructions;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
  };

  const toggleMutation = useMutation({
    mutationFn: (laneAEnabled: boolean) => agentsApi.update(agent.id, { laneAEnabled }, companyId),
    onSuccess: (_result, laneAEnabled) => {
      invalidate();
      pushToast({
        title: laneAEnabled ? `${agent.name} is now a quick agent` : `${agent.name} is no longer a quick agent`,
        tone: "success",
      });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not change the quick agent switch");
    },
  });

  // DUR-3977: model / output ceiling / daily cap all go through the same
  // board-only PATCH the switch above uses. DUR-3997: so do the provider, the
  // key binding and the model address.
  const settingMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => agentsApi.update(agent.id, patch, companyId),
    onSuccess: () => {
      setError(null);
      invalidate();
      pushToast({ title: "Innstillingen er lagret", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Kunne ikke lagre innstillingen");
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      agentsApi.update(agent.id, { laneAInstructions: instructions.trim() ? instructions : null }, companyId),
    onSuccess: () => {
      setDraft(null);
      setError(null);
      invalidate();
      pushToast({ title: "Quick agent instructions saved", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the instructions");
    },
  });

  // ─── DUR-3997: provider, key, address, model ────────────────────────────
  const provider = normalizeLaneAProvider(agent.laneAProvider);
  const providerDescriptor = LANE_A_PROVIDER_CATALOGUE[provider];
  const keyBinding = useMemo(() => readLaneAKeyBinding(agent.adapterConfig), [agent.adapterConfig]);
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(effectiveCompanyId),
    queryFn: () => secretsApi.list(effectiveCompanyId),
    enabled: Boolean(effectiveCompanyId),
  });
  const boundSecret = keyBinding
    ? (secretsQuery.data ?? []).find((secret) => secret.id === keyBinding.secretId) ?? null
    : null;
  const rankSecret = useMemo(() => rankSecretForProvider(provider), [provider]);
  const providerModels = laneAModelsForProvider(provider);

  const keyStatus = keyBinding
    ? boundSecret
      ? `key "${boundSecret.name}"`
      : secretsQuery.isPending
        ? "key …"
        : "key missing (the saved secret is gone — pick another)"
    : provider === "anthropic"
      ? "Paperclip's own key"
      : provider === "local"
        ? "no key (fine for most local servers)"
        : "no key yet — pick one below";

  const saveKeyBinding = (next: SecretBindingValue | null) =>
    settingMutation.mutate({
      adapterConfig: {
        laneA: {
          apiKey: next ? { type: "secret_ref", secretId: next.secretId, version: next.version ?? "latest" } : null,
        },
      },
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Quick agent</CardTitle>
            <CardDescription>
              A quick agent answers you directly in chat instead of running as a full agent. It remembers the
              conversation and can do three things: hand work to a colleague, look up the weather, and read a task
              summary. Good for a secretary or a weather helper. Only you can switch this on.
            </CardDescription>
          </div>
          <ToggleSwitch
            checked={savedEnabled}
            onCheckedChange={(next) => toggleMutation.mutate(next)}
            disabled={toggleMutation.isPending}
            aria-label="Quick agent on or off"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Instructions</p>
          <p className="text-xs text-muted-foreground">
            Tell the quick agent who it is and what to do, in plain words. Example: "You are the front desk. Anything
            about invoices goes to Finn. Anything technical goes to Bob. Answer in Norwegian."
          </p>
        </div>
        <Textarea
          value={instructions}
          onChange={(event) => setDraft(event.target.value)}
          rows={8}
          maxLength={LANE_A_INSTRUCTIONS_MAX_LENGTH}
          placeholder="You are the front desk for this company. Route requests to the right colleague and keep answers short."
          className="text-sm"
          disabled={!savedEnabled && !dirty && !instructions}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {instructions.length} / {LANE_A_INSTRUCTIONS_MAX_LENGTH}
            {!savedEnabled && " · switch the quick agent on to start chatting"}
          </p>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(null); }}>
                Cancel
              </Button>
            )}
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save instructions"}
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* DUR-3997: who answers, and with whose key. */}
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Provider and key</p>
            <p className="text-xs text-muted-foreground">
              Which AI service answers this quick agent, and which of the company's saved keys it uses. Leave the
              provider on Claude with no key to keep using Paperclip's own key, as before.
            </p>
          </div>

          <p className="text-xs" data-testid="quick-agent-provider-status">
            <span className="text-muted-foreground">Using: </span>
            <span className="font-medium">{providerDescriptor.label}</span>
            <span className="text-muted-foreground"> · {keyStatus}</span>
          </p>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Provider</span>
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={agent.laneAProvider ?? ""}
              disabled={settingMutation.isPending}
              onChange={(event) =>
                // The model list changes with the provider, so the model is
                // cleared to the new provider's default at the same time.
                settingMutation.mutate({
                  laneAProvider: event.target.value ? event.target.value : null,
                  laneAModel: null,
                })
              }
            >
              <option value="">Claude (Paperclip's own key unless you pick one)</option>
              {LANE_A_PROVIDERS.map((key) => (
                <option key={key} value={key}>
                  {LANE_A_PROVIDER_CATALOGUE[key].label}
                </option>
              ))}
            </select>
          </label>

          <SecretBindingPicker
            label="Key"
            placeholder={provider === "local" ? "No key (optional)" : `Pick the ${providerDescriptor.label} key`}
            value={keyBinding}
            onChange={saveKeyBinding}
            allowVersionSelector={false}
            disabled={settingMutation.isPending}
            rankSecret={rankSecret}
            emptyHint={`No saved keys yet. Create one here or add it under Connections.`}
          />

          {providerDescriptor.baseUrlEditable && (
            <TextSetting
              label="Model address"
              hint={
                provider === "local"
                  ? "The OpenAI-compatible address of your local model server, for example http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio)."
                  : `Leave empty to use ${providerDescriptor.defaultBaseUrl}.`
              }
              value={agent.laneABaseUrl ?? null}
              placeholder={providerDescriptor.defaultBaseUrl ?? "http://localhost:11434/v1"}
              disabled={settingMutation.isPending}
              onSave={(next) => settingMutation.mutate({ laneABaseUrl: next })}
            />
          )}
        </div>

        {/* DUR-3977: the settings that decide what a batch of rewrites costs
            and how far it can run before it stops on its own. */}
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Modell og grenser</p>
            <p className="text-xs text-muted-foreground">
              Brukes både i chat og når et annet system ber om omskriving av tekst. Alt her kan stå tomt —
              da bruker vi standardverdiene.
            </p>
          </div>

          {providerDescriptor.freeForm ? (
            <TextSetting
              label="Model"
              hint={
                provider === "openrouter"
                  ? "The OpenRouter model id, for example openai/gpt-4.1-mini or meta-llama/llama-3.3-70b-instruct. Paperclip has no price list for OpenRouter, so its cost is recorded as 0."
                  : "The model name your local server exposes, for example llama3.1 or qwen2.5:7b. Local models cost nothing."
              }
              value={agent.laneAModel ?? null}
              placeholder={provider === "openrouter" ? "openai/gpt-4.1-mini" : "llama3.1"}
              disabled={settingMutation.isPending}
              onSave={(next) => settingMutation.mutate({ laneAModel: next })}
            />
          ) : (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Modell</span>
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={providerModels.includes(agent.laneAModel ?? "") ? (agent.laneAModel ?? "") : ""}
                disabled={settingMutation.isPending}
                onChange={(event) =>
                  settingMutation.mutate({ laneAModel: event.target.value ? event.target.value : null })
                }
              >
                <option value="">
                  Standard
                  {providerDescriptor.defaultModel
                    ? ` (${providerDescriptor.models[providerDescriptor.defaultModel]?.label ?? providerDescriptor.defaultModel})`
                    : ""}
                </option>
                {providerModels.map((model) => (
                  <option key={model} value={model}>
                    {providerDescriptor.models[model]?.label ?? model} ({model})
                  </option>
                ))}
              </select>
            </label>
          )}

          <NumberSetting
            label="Lengste svar (ord-deler)"
            hint={`Tomt = ${LANE_A_DEFAULT_MAX_OUTPUT_TOKENS}. Stopper et svar fra å bli uventet langt og dyrt.`}
            value={agent.laneAMaxOutputTokens ?? null}
            min={LANE_A_MIN_MAX_OUTPUT_TOKENS}
            max={LANE_A_MAX_MAX_OUTPUT_TOKENS}
            disabled={settingMutation.isPending}
            onSave={(next) => settingMutation.mutate({ laneAMaxOutputTokens: next })}
          />

          <NumberSetting
            label="Hvor mange tekster per døgn"
            hint={`Tomt = ${LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP}. Gjelder bare omskriving fra andre systemer, ikke chat. Når grensen er nådd stopper den til midnatt.`}
            value={agent.laneATransformDailyCallCap ?? null}
            min={LANE_A_MIN_TRANSFORM_DAILY_CALL_CAP}
            max={LANE_A_MAX_TRANSFORM_DAILY_CALL_CAP}
            disabled={settingMutation.isPending}
            onSave={(next) => settingMutation.mutate({ laneATransformDailyCallCap: next })}
          />

          <MonthlyTransformBudget
            agentId={agent.id}
            companyId={effectiveCompanyId}
            worstCaseDailyCents={laneATransformWorstCaseDailyCents({
              provider: agent.laneAProvider,
              model: agent.laneAModel,
              maxOutputTokens: agent.laneAMaxOutputTokens,
              dailyCallCap: agent.laneATransformDailyCallCap,
              maxTotalInputChars: LANE_A_TRANSFORM_MAX_TOTAL_CHARS,
            })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** The secret_ref bound at adapterConfig.laneA.apiKey, if any. */
function readLaneAKeyBinding(adapterConfig: Record<string, unknown> | undefined): SecretBindingValue | null {
  const laneA = adapterConfig?.laneA;
  if (typeof laneA !== "object" || laneA === null) return null;
  const apiKey = (laneA as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "object" || apiKey === null) return null;
  const ref = apiKey as { type?: unknown; secretId?: unknown; version?: unknown };
  if (ref.type !== "secret_ref" || typeof ref.secretId !== "string") return null;
  return {
    secretId: ref.secretId,
    version: ref.version === "latest" || typeof ref.version === "number" ? ref.version : "latest",
  };
}

/**
 * Puts the secrets that look like this provider's key first. Uses the
 * secret's `kind` tag when the company has tagged it (Connections slice 1),
 * else the name and key. Nothing is hidden: the whole list stays pickable.
 */
const PROVIDER_NAME_HINTS: Record<LaneAProvider, string[]> = {
  anthropic: ["anthropic", "claude"],
  openai: ["openai", "chatgpt", "gpt"],
  google: ["google", "gemini"],
  openrouter: ["openrouter"],
  local: ["local", "ollama", "lmstudio", "lm_studio", "llama", "vllm"],
};

function rankSecretForProvider(provider: LaneAProvider): (secret: CompanySecret) => number {
  const kindTag = provider === "local" ? "local_model_endpoint" : `${provider}_api_key`;
  const hints = PROVIDER_NAME_HINTS[provider];
  return (secret) => {
    const kind = (secret as { kind?: unknown }).kind;
    if (typeof kind === "string" && kind.length > 0) return kind === kindTag ? 0 : 2;
    const haystack = `${secret.name} ${secret.key}`.toLowerCase();
    return hints.some((hint) => haystack.includes(hint)) ? 1 : 2;
  };
}

/** A free-text value that may also be blank, meaning "use the default". */
function TextSetting({
  label,
  hint,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  label: string;
  hint: string;
  value: string | null;
  placeholder?: string;
  disabled?: boolean;
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ?? "");
  const dirty = draft !== null && draft !== (value ?? "");

  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || disabled}
          onClick={() => {
            const trimmed = shown.trim();
            onSave(trimmed === "" ? null : trimmed);
            setDraft(null);
          }}
        >
          Save
        </Button>
      </div>
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
}

/** A whole number that may also be blank, meaning "use the default". */
function NumberSetting({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string;
  hint: string;
  value: number | null;
  min: number;
  max: number;
  disabled?: boolean;
  onSave: (next: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  const dirty = draft !== null && draft !== (value === null ? "" : String(value));

  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={shown}
          placeholder="Standard"
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || disabled}
          onClick={() => {
            const trimmed = shown.trim();
            onSave(trimmed === "" ? null : Number(trimmed));
            setDraft(null);
          }}
        >
          Lagre
        </Button>
      </div>
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
}

/** Whole US cents -> "12,34" for display. */
function centsToDollarString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * The monthly ceiling on what rewriting text may cost for this one agent.
 * It is an ordinary budget policy (scope `agent`, metric
 * `lane_a_transform_cents`) — the same mechanism every other budget uses, so
 * hitting it produces the same card the operator already knows how to answer.
 *
 * THE UNIT IS DOLLARS, and saying so is the whole point of this comment.
 * `budget_policies.amount` is US cents everywhere in Paperclip — it is what
 * BudgetPolicyCard labels "Budget (USD)", and what cost_events.cost_cents is
 * summed in, because the bill Paperclip pays is the provider's and the
 * providers bill in dollars. An earlier version of this field was labelled
 * kroner while storing and enforcing the same cents, which made every ceiling
 * Filip set about 11x looser than he believed and every spend read-back about
 * 11x too small. Converting NOK->USD here would need a live rate the rest of
 * the system does not have; matching the rest of the system is the honest fix.
 */
function MonthlyTransformBudget({
  agentId,
  companyId,
  worstCaseDailyCents,
}: {
  agentId: string;
  companyId: string;
  /** What a full day at this agent's own limits could cost, if no budget is set. 0 = price unknown. */
  worstCaseDailyCents: number;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const overviewQuery = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
  });

  const policy = overviewQuery.data?.policies.find(
    (entry) => entry.scopeType === "agent" && entry.scopeId === agentId && entry.metric === "lane_a_transform_cents",
  );
  const savedDollars = policy && policy.amount > 0 ? centsToDollarString(policy.amount) : "";
  const shown = draft ?? savedDollars;
  const dirty = draft !== null && draft !== savedDollars;

  const saveMutation = useMutation({
    mutationFn: (dollars: number) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: "agent",
        scopeId: agentId,
        metric: "lane_a_transform_cents",
        windowKind: "calendar_month_utc",
        amount: Math.round(dollars * 100),
      }),
    onSuccess: () => {
      setDraft(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
      pushToast({ title: "Månedsgrensen er lagret", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Kunne ikke lagre månedsgrensen");
    },
  });

  const spentDollars = policy ? centsToDollarString(policy.observedAmount) : "0.00";

  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">
        Maks kostnad per måned for omskriving (dollar)
      </span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          value={shown}
          placeholder="Ingen grense"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate(Number(shown.trim() || 0))}
        >
          Lagre
        </Button>
      </div>
      <span className="block text-xs text-muted-foreground">
        {policy && policy.amount > 0
          ? `Brukt så langt denne måneden: $${spentDollars}. Når grensen er nådd slutter den å skrive om tekst, men jobber ellers videre — og du får spørsmål om å heve grensen.`
          : worstCaseDailyCents > 0
            ? // "Tomt = ingen grense" is true but useless as a default on the
              // first thing that can spend Paperclip's money from outside
              // Paperclip. Say what no-limit actually means, in money.
              `Tomt = ingen grense. Uten grense kan denne hurtigansatte i verste fall bruke rundt $${centsToDollarString(worstCaseDailyCents)} på ett døgn, med dagsgrensen og modellen som er satt over. Sett et tall hvis du vil være sikker.`
            : `Tomt = ingen grense. Paperclip kjenner ingen pris for denne modellen, så kostnaden føres som 0 — sett en grense hos leverandøren hvis du vil være sikker.`}
      </span>
      <span className="block text-xs text-muted-foreground">
        Beløpet er i dollar fordi modellkjøringen faktureres i dollar — samme enhet som de andre
        budsjettene i Paperclip.
      </span>
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}
