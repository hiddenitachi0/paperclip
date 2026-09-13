import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LANE_A_DEFAULT_MAX_OUTPUT_TOKENS,
  LANE_A_DEFAULT_MODEL,
  LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_INSTRUCTIONS_MAX_LENGTH,
  LANE_A_MAX_MAX_OUTPUT_TOKENS,
  LANE_A_MAX_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_MIN_MAX_OUTPUT_TOKENS,
  LANE_A_MIN_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_MODELS,
  LANE_A_MODEL_CATALOGUE,
  LANE_A_TRANSFORM_MAX_TOTAL_CHARS,
  laneATransformWorstCaseDailyCents,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { budgetsApi } from "../api/budgets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/**
 * Quick agent settings: the on/off switch plus the instruction set the quick
 * agent follows. Both are board-only on the server (the API refuses anyone
 * else), so this card is only ever useful to the operator.
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
    laneAEnabled?: boolean;
    laneAInstructions?: string | null;
    laneAModel?: string | null;
    laneAMaxOutputTokens?: number | null;
    laneATransformDailyCallCap?: number | null;
  };
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const savedEnabled = Boolean(agent.laneAEnabled);
  const savedInstructions = agent.laneAInstructions ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  // board-only PATCH the switch above uses.
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

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Modell</span>
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={agent.laneAModel ?? ""}
              disabled={settingMutation.isPending}
              onChange={(event) =>
                settingMutation.mutate({ laneAModel: event.target.value ? event.target.value : null })
              }
            >
              <option value="">Standard ({LANE_A_MODEL_CATALOGUE[LANE_A_DEFAULT_MODEL].label})</option>
              {LANE_A_MODELS.map((model) => (
                <option key={model} value={model}>
                  {LANE_A_MODEL_CATALOGUE[model].label} ({model})
                </option>
              ))}
            </select>
          </label>

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
            companyId={companyId ?? agent.companyId}
            worstCaseDailyCents={laneATransformWorstCaseDailyCents({
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
 * summed in, because the bill Paperclip pays is Anthropic's and Anthropic
 * bills in dollars. An earlier version of this field was labelled kroner while
 * storing and enforcing the same cents, which made every ceiling Filip set
 * about 11x looser than he believed and every spend read-back about 11x too
 * small. Converting NOK->USD here would need a live rate the rest of the
 * system does not have; matching the rest of the system is the honest fix.
 */
function MonthlyTransformBudget({
  agentId,
  companyId,
  worstCaseDailyCents,
}: {
  agentId: string;
  companyId: string;
  /** What a full day at this agent's own limits could cost, if no budget is set. */
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
          : // "Tomt = ingen grense" is true but useless as a default on the
            // first thing that can spend Paperclip's money from outside
            // Paperclip. Say what no-limit actually means, in money.
            `Tomt = ingen grense. Uten grense kan denne hurtigansatte i verste fall bruke rundt $${centsToDollarString(worstCaseDailyCents)} på ett døgn, med dagsgrensen og modellen som er satt over. Sett et tall hvis du vil være sikker.`}
      </span>
      <span className="block text-xs text-muted-foreground">
        Beløpet er i dollar fordi modellkjøringen faktureres i dollar — samme enhet som de andre
        budsjettene i Paperclip.
      </span>
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}
