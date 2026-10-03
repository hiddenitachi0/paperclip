import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BROWSER_ACCESS_LEVELS,
  LANE_A_DEFAULT_MAX_OUTPUT_TOKENS,
  LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_INSTRUCTIONS_MAX_LENGTH,
  LANE_A_MAX_MAX_OUTPUT_TOKENS,
  LANE_A_MAX_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_MIN_MAX_OUTPUT_TOKENS,
  LANE_A_MIN_TRANSFORM_DAILY_CALL_CAP,
  LANE_A_PROVIDERS,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDER_ROUTING_MAX_ENTRIES,
  LANE_A_ANTHROPIC_MAX_TEMPERATURE,
  LANE_A_TEMPERATURE_PRESETS,
  LANE_A_THINKING_MODES,
  LANE_A_TRANSFORM_MAX_TOTAL_CHARS,
  LANE_A_TRUST_LEVELS,
  LANE_A_TRUST_LEVEL_LABELS,
  laneAModelAcceptsReasoningEffort,
  laneAModelAcceptsTemperature,
  laneAModelsForProvider,
  laneATransformWorstCaseDailyCents,
  normalizeLaneAProvider,
  normalizeLaneATrustLevel,
  normalizeLaneAProviderRouting,
  parseLaneAProviderSlugList,
  formatAgentDisplayName,
  readLaneABrowserAccess,
  readLaneAWebSearchSwitch,
  WEB_SEARCH_FREE_CREDIT_TEXT,
  WEB_SEARCH_PRICE_TEXT,
  type BrowserAccessLevel,
  type CompanySecret,
  type LaneAProvider,
  type LaneAThinkingMode,
  type LaneATrustLevel,
  type LaneAProviderRouting,
  type LaneABackupModelConfig,
  type LaneAKeywordRoute,
} from "@paperclipai/shared";
import { AlertCircle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { Link } from "@/lib/router";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { budgetsApi } from "../api/budgets";
import { dataConnectionsApi } from "../api/dataConnections";
import { instanceServerAnthropicKeyApi } from "../api/instanceServerAnthropicKey";
import { instanceSettingsApi } from "../api/instanceSettings";
import { mcpToolLibraryApi } from "../api/mcpToolLibrary";
import { pluginsApi } from "../api/plugins";
import { secretsApi } from "../api/secrets";
import { webSearchApi } from "../api/webSearch";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef } from "../lib/utils";
import {
  dataLine,
  instructionsLine,
  modelAndKeyLine,
  readinessBlocksSwitchOn,
  toolsLine,
  type DataSourceCheck,
  type ReadinessLine,
} from "../lib/quick-agent-readiness";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SecretBindingPicker, type SecretBindingValue } from "./SecretBindingPicker";
import { QuickAgentBackupModels } from "./QuickAgentBackupModels";

/**
 * Quick agent settings: the on/off switch plus the instruction set the quick
 * agent follows. Both are board-only on the server (the API refuses anyone
 * else), so this card is only ever useful to the operator.
 *
 * DUR-3997: the card also chooses which provider answers (Claude, OpenAI,
 * Google, OpenRouter or a local model) and which of the company's saved keys
 * it uses. The key is stored as a secret binding at adapterConfig.laneA.apiKey,
 * never as text on the agent.
 *
 * DUR-3997 slice 4: a four-line readiness checklist at the top (model and
 * key, tools, data, instructions). Only the first line can block: the switch
 * cannot be turned ON until the agent has a model and a key that Paperclip
 * can use, and the line says exactly what to do. Switching OFF is always
 * allowed. Everything is computed from endpoints the page already calls; no
 * new server route.
 */

/** Plain-language labels for the "Browser access" dial (DUR-4020). */
const BROWSER_ACCESS_LABELS: Record<BrowserAccessLevel, string> = {
  off: "Off",
  browse_and_forms: "Can browse and fill forms",
  book_and_buy: "Can browse, book, and pay",
};

export function QuickAgentSection({
  agent,
  companyId,
}: {
  agent: {
    id: string;
    urlKey: string;
    companyId: string;
    name: string;
    /** DUR-4000: the person doing this job, for "Sales agent 1 (Maja)" in what this card says. */
    persona?: { displayName: string | null } | null;
    adapterConfig?: Record<string, unknown>;
    laneAEnabled?: boolean;
    laneAInstructions?: string | null;
    laneAModel?: string | null;
    laneAMaxOutputTokens?: number | null;
    laneATransformDailyCallCap?: number | null;
    laneAProvider?: string | null;
    laneABaseUrl?: string | null;
    laneATemperature?: number | null;
    /** DUR-4367: "on" | "off" | null ("model default"). */
    laneAThinking?: string | null;
    /** DUR-4070: the trust-level ceiling (limited/standard/full). Null/absent reads as "full". */
    laneATrustLevel?: string | null;
    /** DUR-4070: company-member userIds this quick agent may chat with, besides the company's owner. */
    laneAAssignedUserIds?: string[] | null;
    laneAProviderRouting?: LaneAProviderRouting | null;
    /** DUR-4347: up to five backup models, two try-next lists (by backup id) and keyword rules. */
    laneABackupModels?: LaneABackupModelConfig[] | null;
    laneANoAnswerChainIds?: string[] | null;
    laneARefusalChainIds?: string[] | null;
    laneAKeywordRoutes?: LaneAKeywordRoute[] | null;
  };
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const savedEnabled = Boolean(agent.laneAEnabled);
  const savedInstructions = agent.laneAInstructions ?? "";
  const displayName = formatAgentDisplayName(agent, agent.persona);
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
        title: laneAEnabled ? `${displayName} is now a quick agent` : `${displayName} is no longer a quick agent`,
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
      pushToast({ title: "Setting saved", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the setting");
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

  // adapterConfig is merged one level deep on the server, so laneA is always
  // sent whole: saving the key keeps the web switch, and the other way round.
  const currentLaneA = useMemo(() => {
    const laneA = agent.adapterConfig?.laneA;
    return typeof laneA === "object" && laneA !== null ? (laneA as Record<string, unknown>) : {};
  }, [agent.adapterConfig]);
  const saveKeyBinding = (next: SecretBindingValue | null) =>
    settingMutation.mutate({
      adapterConfig: {
        laneA: {
          ...currentLaneA,
          apiKey: next ? { type: "secret_ref", secretId: next.secretId, version: next.version ?? "latest" } : null,
        },
      },
    });

  // "Can search the web": off unless switched on here.
  const webSearchOn = readLaneAWebSearchSwitch(agent.adapterConfig);
  const webSearchQuery = useQuery({
    queryKey: queryKeys.companies.webSearch(effectiveCompanyId),
    queryFn: () => webSearchApi.get(effectiveCompanyId),
    enabled: Boolean(effectiveCompanyId),
    retry: false,
  });
  const saveWebSearch = (next: boolean) =>
    settingMutation.mutate({ adapterConfig: { laneA: { ...currentLaneA, webSearch: next } } });

  // "Browser access": off unless raised here. Board-only, same as webSearch.
  const browserAccess = readLaneABrowserAccess(agent.adapterConfig);
  const saveBrowserAccess = (next: BrowserAccessLevel) =>
    settingMutation.mutate({ adapterConfig: { laneA: { ...currentLaneA, browserAccess: next } } });

  // ─── DUR-4070: trust level + who may chat with this quick agent ────────
  const trustLevel = normalizeLaneATrustLevel(agent.laneATrustLevel);
  const saveTrustLevel = (next: LaneATrustLevel) => settingMutation.mutate({ laneATrustLevel: next });
  const assignedUserIds = agent.laneAAssignedUserIds ?? [];
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(effectiveCompanyId),
    queryFn: () => accessApi.listMembers(effectiveCompanyId),
    enabled: Boolean(effectiveCompanyId),
  });
  const toggleAssignedUser = (userId: string, next: boolean) =>
    settingMutation.mutate({
      laneAAssignedUserIds: next
        ? [...assignedUserIds, userId]
        : assignedUserIds.filter((id) => id !== userId),
    });

  // ─── DUR-3997 slice 4: readiness ────────────────────────────────────────
  // Paperclip's own key is only readable by an instance admin (the route is
  // assertInstanceAdmin), so it is only asked for as one; everyone else gets
  // "cannot see, assume it is there".
  const { isInstanceAdmin } = useCompanyRole(effectiveCompanyId);
  const instanceKeyQuery = useQuery({
    queryKey: queryKeys.instance.serverAnthropicKey,
    queryFn: () => instanceServerAnthropicKeyApi.get(),
    enabled: provider === "anthropic" && !keyBinding && isInstanceAdmin,
    retry: false,
  });
  const agentToolsQuery = useQuery({
    queryKey: queryKeys.mcpTools.forAgent(agent.id),
    queryFn: () => mcpToolLibraryApi.listForAgent(agent.id),
  });
  // Add-on (plugin) tools ticked for this agent. A failure here must not hide
  // the Tools-library count, so it only ever adds to the line.
  const addOnToolsQuery = useQuery({
    queryKey: queryKeys.plugins.agentToolGrants(agent.id),
    queryFn: () => pluginsApi.agentToolGrants(agent.id),
    retry: false,
  });
  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const businessDataEnabled = experimentalQuery.data?.enableBusinessData === true;
  const datasetSourcesQuery = useQuery({
    queryKey: queryKeys.companies.datasetSources(effectiveCompanyId),
    queryFn: () => dataConnectionsApi.listDatasetSources(effectiveCompanyId),
    enabled: Boolean(effectiveCompanyId) && businessDataEnabled,
    retry: false,
  });

  const readiness: ReadinessLine[] = useMemo(() => {
    const model = modelAndKeyLine({
      provider,
      providerLabel: providerDescriptor.label,
      model: agent.laneAModel ?? null,
      bindingSecretId: keyBinding?.secretId ?? null,
      boundSecret: keyBinding ? (secretsQuery.data ? boundSecret : undefined) : null,
      secretsFailed: secretsQuery.isError,
      instanceKey: !isInstanceAdmin || instanceKeyQuery.isError
        ? null
        : instanceKeyQuery.data
          ? {
              configured: instanceKeyQuery.data.configured,
              lastTestOk: instanceKeyQuery.data.lastTestOk,
              lastTestMessage: instanceKeyQuery.data.lastTestMessage,
            }
          : undefined,
      baseUrl: agent.laneABaseUrl ?? null,
    });
    const addOnSettled = addOnToolsQuery.data !== undefined || addOnToolsQuery.isError;
    const addOnAvailable = new Set((addOnToolsQuery.data?.availableTools ?? []).map((tool) => tool.name));
    const tools = toolsLine({
      enabledCount:
        agentToolsQuery.data && addOnSettled ? agentToolsQuery.data.filter((tool) => tool.enabled).length : undefined,
      // Only ticks that still point at an installed, switched-on add-on tool count.
      addOnCount: (addOnToolsQuery.data?.grantedToolNames ?? []).filter((name) => addOnAvailable.has(name)).length,
      failed: agentToolsQuery.isError,
      toolsTabPath: `/agents/${agentRouteRef(agent)}/tools`,
    });
    let dataCheck: DataSourceCheck;
    if (experimentalQuery.isPending) dataCheck = { kind: "checking" };
    else if (!businessDataEnabled) dataCheck = { kind: "feature_off" };
    else if (datasetSourcesQuery.isPending) dataCheck = { kind: "checking" };
    else if (datasetSourcesQuery.isError) {
      const status = datasetSourcesQuery.error instanceof ApiError ? datasetSourcesQuery.error.status : null;
      dataCheck = status === 403 ? { kind: "forbidden" } : status === 404 ? { kind: "feature_off" } : { kind: "failed" };
    } else {
      dataCheck = {
        kind: "loaded",
        hasSales: (datasetSourcesQuery.data ?? []).some((source) => source.dataset === "sales"),
      };
    }
    return [model, tools, dataLine(dataCheck), instructionsLine(savedInstructions)];
  }, [
    provider,
    providerDescriptor.label,
    keyBinding,
    secretsQuery.data,
    secretsQuery.isError,
    boundSecret,
    isInstanceAdmin,
    instanceKeyQuery.isError,
    instanceKeyQuery.data,
    agent,
    agentToolsQuery.data,
    agentToolsQuery.isError,
    addOnToolsQuery.data,
    addOnToolsQuery.isError,
    experimentalQuery.isPending,
    businessDataEnabled,
    datasetSourcesQuery.isPending,
    datasetSourcesQuery.isError,
    datasetSourcesQuery.error,
    datasetSourcesQuery.data,
    savedInstructions,
  ]);
  const modelLine = readiness[0];
  // Switching ON needs a usable model and key (a "todo" — say, a key whose last
  // test hit a rate limit — is a warning, not a block). Switching OFF is always
  // allowed, so a key that stops working can never trap an agent in the "on"
  // state.
  const cannotSwitchOn = !savedEnabled && readinessBlocksSwitchOn(modelLine.state);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Quick agent</CardTitle>
            <p className="text-xs text-muted-foreground">{displayName}</p>
            <CardDescription>
              A quick agent answers you directly in chat instead of running as a full agent in its own workspace.
              It remembers the conversation, keeps notes you ask it to remember (you can read and edit them here
              once it is on), and can hand work to a colleague, look up the weather, tell the time anywhere and read a task summary. Switch on "Can search the web" below to let it look up live facts. Good for a secretary or a weather helper. Only you can switch this on.
            </CardDescription>
          </div>
          <ToggleSwitch
            checked={savedEnabled}
            onCheckedChange={(next) => toggleMutation.mutate(next)}
            disabled={toggleMutation.isPending || cannotSwitchOn}
            aria-label="Quick agent on or off"
          />
        </div>
        {cannotSwitchOn && (
          <p className="text-xs text-muted-foreground" data-testid="quick-agent-switch-reason">
            {modelLine.state === "checking"
              ? "Checking the model and key before the switch can be used…"
              : `Cannot switch on yet: ${modelLine.text}`}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <ReadinessChecklist lines={readiness} />

        <div className="space-y-1.5 border-t pt-4">
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
              onSave={(next) => settingMutation.mutateAsync({ laneABaseUrl: next })}
            />
          )}
        </div>

        {/* Web search: off by default, per quick agent. */}
        <div className="space-y-2 border-t pt-4" data-testid="quick-agent-web-search">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Can search the web</p>
              <p className="text-xs text-muted-foreground">
                Lets this quick agent search the web with the company's Brave Search key and read the pages it finds
                or that you link, so it can answer things like today's football scores or a price. It tells you which
                site an answer came from. Every quick agent can always tell the time anywhere. Brave charges{" "}
                {WEB_SEARCH_PRICE_TEXT} and gives {WEB_SEARCH_FREE_CREDIT_TEXT}; Paperclip stops at{" "}
                {webSearchQuery.data?.dailyCap ?? 100} searches a day for the whole company.
              </p>
            </div>
            <ToggleSwitch
              checked={webSearchOn}
              onCheckedChange={(next) => saveWebSearch(next)}
              disabled={settingMutation.isPending}
              aria-label="Can search the web"
            />
          </div>
          {webSearchOn && webSearchQuery.data && webSearchQuery.data.keyStatus !== "ok" && (
            <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="quick-agent-web-search-no-key">
              The company has no usable Brave Search key yet, so this quick agent can only read pages you link, not
              search.{" "}
              <Link to="/company/settings/connections" className="underline">
                Pick a key under Connections → Web search
              </Link>
              .
            </p>
          )}
          {webSearchQuery.data && (
            <p className="text-xs text-muted-foreground">
              Searches today (whole company): {webSearchQuery.data.usedToday} of {webSearchQuery.data.dailyCap}.
            </p>
          )}
        </div>

        {/* Browser access: off by default, applies to full runs only. DUR-4020. */}
        <div className="space-y-2 border-t pt-4" data-testid="quick-agent-browser-access">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Browser access</p>
            <p className="text-xs text-muted-foreground">
              Lets this agent open a real browser to look at web pages and fill in forms for you. "Can browse,
              book, and pay" also lets it use a payment card or website login you've saved under Connections to
              finish a booking or a purchase — it never sees a card number or password itself, only Paperclip
              does. This only applies when the agent does a full run — a quick agent never gets browser access,
              even with this switched on. Off by default. Only you can change this.
            </p>
          </div>
          <select
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            data-testid="quick-agent-browser-access-select"
            value={browserAccess}
            disabled={settingMutation.isPending}
            onChange={(event) => saveBrowserAccess(event.target.value as BrowserAccessLevel)}
          >
            {BROWSER_ACCESS_LEVELS.map((level) => (
              <option key={level} value={level}>
                {BROWSER_ACCESS_LABELS[level]}
              </option>
            ))}
          </select>
        </div>

        {/* DUR-4070: the trust-level ceiling. */}
        <div className="space-y-2 border-t pt-4" data-testid="quick-agent-trust-level">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Trust level</p>
            <p className="text-xs text-muted-foreground">
              One dial for add-on tools, business data, company files, web search, browser access, and its
              memory notebook. Limited switches all of those off, no matter what is ticked elsewhere on this
              agent. Only you can change this.
            </p>
          </div>
          <select
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            data-testid="quick-agent-trust-level-select"
            value={trustLevel}
            disabled={settingMutation.isPending}
            onChange={(event) => saveTrustLevel(event.target.value as LaneATrustLevel)}
          >
            {LANE_A_TRUST_LEVELS.map((level) => (
              <option key={level} value={level}>
                {LANE_A_TRUST_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
        </div>

        {/* DUR-4070: who may chat with this quick agent at all. */}
        <div className="space-y-2 border-t pt-4" data-testid="quick-agent-assigned-people">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Who can chat with {displayName}</p>
            <p className="text-xs text-muted-foreground">
              The company's owner can always chat with {displayName}. Tick anyone else who should be able to.
              Everyone not ticked gets a plain "not assigned" reply instead of an answer — in the chat box and
              on Telegram alike. Only you can change this.
            </p>
          </div>
          {membersQuery.isPending ? (
            <p className="text-xs text-muted-foreground">Loading the member list…</p>
          ) : membersQuery.isError ? (
            <p className="text-xs text-destructive">Could not load the member list.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="quick-agent-assigned-people-list">
              {(membersQuery.data?.members ?? [])
                .filter((member) => member.status === "active")
                .map((member) => {
                  const isOwner = member.membershipRole === "owner";
                  const checked = isOwner || assignedUserIds.includes(member.principalId);
                  const label = member.user?.name || member.user?.email || member.principalId;
                  return (
                    <li key={member.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isOwner || settingMutation.isPending}
                        onChange={(event) => toggleAssignedUser(member.principalId, event.target.checked)}
                      />
                      <span>
                        {label}
                        {isOwner && <span className="text-xs text-muted-foreground"> (owner, always allowed)</span>}
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>

        {/* DUR-3977: the settings that decide what a batch of rewrites costs
            and how far it can run before it stops on its own. */}
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Model and limits</p>
            <p className="text-xs text-muted-foreground">
              Used both in chat and when another system asks for a text to be rewritten. Everything here can be left
              empty — then the defaults apply.
            </p>
          </div>

          {providerDescriptor.freeForm ? (
            <>
              {!agent.laneAModel && (
                <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="quick-agent-model-missing-notice">
                  Pick a model for {providerDescriptor.label} — quick answers won't work until one is set, and a
                  message to this agent will be turned into a task instead.
                </p>
              )}
              <TextSetting
                label="Model"
                hint={
                  provider === "openrouter"
                    ? "The OpenRouter model id, for example openai/gpt-4.1-mini or meta-llama/llama-3.3-70b-instruct. Paperclip has a price for some OpenRouter models; others are recorded as costing 0 until priced."
                    : "The model name your local server exposes, for example llama3.1 or qwen2.5:7b. Local models cost nothing."
                }
                value={agent.laneAModel ?? null}
                placeholder={provider === "openrouter" ? "openai/gpt-4.1-mini" : "llama3.1"}
                disabled={settingMutation.isPending}
                onSave={(next) => settingMutation.mutateAsync({ laneAModel: next })}
              />
            </>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Model</span>
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={providerModels.includes(agent.laneAModel ?? "") ? (agent.laneAModel ?? "") : ""}
                disabled={settingMutation.isPending}
                onChange={(event) =>
                  settingMutation.mutate({ laneAModel: event.target.value ? event.target.value : null })
                }
              >
                <option value="">
                  Default
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

          {provider === "openrouter" && (
            <ModelHostsSetting
              value={agent.laneAProviderRouting ?? null}
              disabled={settingMutation.isPending}
              onSave={(next) => settingMutation.mutateAsync({ laneAProviderRouting: next })}
            />
          )}

          <CreativitySetting
            value={agent.laneATemperature ?? null}
            provider={provider}
            model={agent.laneAModel ?? null}
            disabled={settingMutation.isPending}
            onSave={(next) => settingMutation.mutateAsync({ laneATemperature: next })}
          />

          <ThinkingSetting
            value={(agent.laneAThinking as LaneAThinkingMode | null) ?? null}
            provider={provider}
            model={agent.laneAModel ?? null}
            disabled={settingMutation.isPending}
            onSave={(next) => settingMutation.mutateAsync({ laneAThinking: next })}
          />

          <QuickAgentBackupModels
            saved={{
              backups: agent.laneABackupModels,
              noAnswerChainIds: agent.laneANoAnswerChainIds,
              refusalChainIds: agent.laneARefusalChainIds,
              keywordRoutes: agent.laneAKeywordRoutes,
            }}
            main={{ provider, baseUrl: agent.laneABaseUrl ?? null, hasKey: Boolean(keyBinding) }}
            saving={settingMutation.isPending}
            onSave={(patch) => settingMutation.mutateAsync(patch)}
          />

          <NumberSetting
            label="Longest answer (tokens)"
            hint={`Empty = ${LANE_A_DEFAULT_MAX_OUTPUT_TOKENS}. Stops an answer from becoming unexpectedly long and expensive.`}
            value={agent.laneAMaxOutputTokens ?? null}
            min={LANE_A_MIN_MAX_OUTPUT_TOKENS}
            max={LANE_A_MAX_MAX_OUTPUT_TOKENS}
            disabled={settingMutation.isPending}
            onSave={(next) => settingMutation.mutate({ laneAMaxOutputTokens: next })}
          />

          <NumberSetting
            label="How many texts per day"
            hint={`Empty = ${LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP}. Only applies to rewrites from other systems, not chat. When the limit is reached it stops until midnight.`}
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

/**
 * The four readiness lines. Green means done; a grey circle means optional
 * and not set; red means the agent cannot be switched on until it is fixed.
 */
function ReadinessChecklist({ lines }: { lines: ReadinessLine[] }) {
  return (
    <div className="space-y-1.5" data-testid="quick-agent-readiness">
      <p className="text-sm font-medium">Is it ready?</p>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={line.id} className="flex items-start gap-2 text-xs" data-testid={`readiness-${line.id}`} data-state={line.state}>
            {line.state === "ok" ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Ready" />
            ) : line.state === "blocked" || line.state === "error" ? (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Needs attention" />
            ) : line.state === "checking" ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Checking" />
            ) : (
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Optional" />
            )}
            <span className="min-w-0">
              <span className="font-medium">{line.label}: </span>
              <span className={line.state === "blocked" || line.state === "error" ? "text-destructive" : "text-muted-foreground"}>{line.text}</span>
              {line.link && (
                <>
                  {" "}
                  <Link to={line.link.to} className="underline hover:text-foreground">
                    {line.link.label}
                  </Link>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
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

/**
 * A free-text value that may also be blank, meaning "use the default".
 *
 * DUR-4353: this field used to save only on an explicit click of "Save", so
 * a typed model id or model address was silently lost the moment the person
 * clicked elsewhere, switched provider, or left the page — nothing told them
 * the draft was never sent. It now also saves on blur and on Enter, warns
 * before leaving the page with an unsaved draft, and shows a small
 * saving/saved/unsaved indicator next to the label so a failed save (shown
 * right here, not only in the card's own error line) is never mistaken for
 * a successful one.
 */
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
  onSave: (next: string | null) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? (value ?? "");
  const dirty = draft !== null && draft !== (value ?? "");

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async () => {
    if (!dirty || status === "saving") return;
    const trimmed = shown.trim();
    const next = trimmed === "" ? null : trimmed;
    setStatus("saving");
    setProblem(null);
    try {
      await onSave(next);
      setDraft(null);
      setStatus("saved");
    } catch (err) {
      setStatus(null);
      setProblem(err instanceof ApiError ? err.message : "Could not save this setting.");
    }
  };

  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {label}
        {status === "saving" && <span data-testid="text-setting-status">Saving…</span>}
        {status === "saved" && (
          <span className="text-emerald-600 dark:text-emerald-400" data-testid="text-setting-status">
            Saved
          </span>
        )}
        {status === null && dirty && (
          <span className="text-amber-600 dark:text-amber-400" data-testid="text-setting-status">
            Unsaved
          </span>
        )}
      </span>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setStatus(null);
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <Button size="sm" variant="secondary" disabled={!dirty || disabled} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <span className="block text-xs text-muted-foreground">{hint}</span>
      {problem && <span className="block text-xs text-destructive">{problem}</span>}
    </label>
  );
}

/**
 * "Creativity": the sampling temperature every model call of this quick agent
 * is made with. Saves as soon as it is changed (there is no Save button to
 * forget) and says so next to the control. Empty = the model's own default,
 * i.e. nothing is sent.
 */
function CreativitySetting({
  value,
  provider,
  model,
  disabled,
  onSave,
}: {
  value: number | null;
  provider: LaneAProvider;
  model: string | null;
  disabled?: boolean;
  onSave: (next: number | null) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const isPreset = value === null || LANE_A_TEMPERATURE_PRESETS.some((preset) => preset.value === value);
  const acceptsTemperature = laneAModelAcceptsTemperature(provider, model);

  const change = async (raw: string) => {
    const next = raw === "" ? null : Number(raw);
    setStatus("saving");
    try {
      await onSave(next);
      setStatus("saved");
    } catch {
      // The card already shows why it could not be saved.
      setStatus(null);
    }
  };

  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        Creativity
        {status === "saving" && <span data-testid="creativity-status">Saving…</span>}
        {status === "saved" && (
          <span className="text-emerald-600 dark:text-emerald-400" data-testid="creativity-status">
            Saved
          </span>
        )}
      </span>
      <select
        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
        value={value === null ? "" : String(value)}
        disabled={disabled}
        data-testid="creativity-select"
        onChange={(event) => void change(event.target.value)}
      >
        <option value="">Model default</option>
        {LANE_A_TEMPERATURE_PRESETS.map((preset) => (
          <option key={preset.value} value={String(preset.value)}>
            {preset.label} ({preset.value})
          </option>
        ))}
        {!isPreset && <option value={String(value)}>Custom ({value})</option>}
      </select>
      <span className="block text-xs text-muted-foreground">
        Higher makes replies more playful and varied; lower makes them more predictable. Work agents usually stay
        precise.
      </span>
      {!acceptsTemperature && value !== null && (
        <span className="block text-xs text-muted-foreground" data-testid="creativity-not-used">
          The model picked above decides this for itself, so this setting is not used with it. Claude Haiku, OpenAI
          GPT-4.1, Google, OpenRouter and local models follow it.
        </span>
      )}
      {acceptsTemperature && provider === "anthropic" && value !== null && value > LANE_A_ANTHROPIC_MAX_TEMPERATURE && (
        <span className="block text-xs text-muted-foreground" data-testid="creativity-capped">
          Claude goes no higher than {LANE_A_ANTHROPIC_MAX_TEMPERATURE}, so this works like {LANE_A_ANTHROPIC_MAX_TEMPERATURE} here.
        </span>
      )}
    </label>
  );
}

// DUR-4367: "Thinking" (on / off / model default). Off asks the model to
// skip its reasoning pass, which is most of the latency for a local
// reasoning model — the fix for Telegram answers taking ~3x as long as the
// same message sent directly to the model.
function ThinkingSetting({
  value,
  provider,
  model,
  disabled,
  onSave,
}: {
  value: LaneAThinkingMode | null;
  provider: LaneAProvider;
  model: string | null;
  disabled?: boolean;
  onSave: (next: LaneAThinkingMode | null) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const acceptsOff = laneAModelAcceptsReasoningEffort(provider, model);

  const change = async (raw: string) => {
    const next = raw === "" ? null : (raw as LaneAThinkingMode);
    setStatus("saving");
    try {
      await onSave(next);
      setStatus("saved");
    } catch {
      // The card already shows why it could not be saved.
      setStatus(null);
    }
  };

  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        Thinking
        {status === "saving" && <span data-testid="thinking-status">Saving…</span>}
        {status === "saved" && (
          <span className="text-emerald-600 dark:text-emerald-400" data-testid="thinking-status">
            Saved
          </span>
        )}
      </span>
      <select
        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
        value={value ?? ""}
        disabled={disabled}
        data-testid="thinking-select"
        onChange={(event) => void change(event.target.value)}
      >
        <option value="">Model default</option>
        {LANE_A_THINKING_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode === "off" ? "Off" : "On"}
          </option>
        ))}
      </select>
      <span className="block text-xs text-muted-foreground">
        Off skips the model's reasoning pass, which is usually most of the wait for a local reasoning model — on
        gives it room to think first. Work agents that answer in Telegram or chat usually want it off.
      </span>
      {!acceptsOff && value === "off" && (
        <span className="block text-xs text-muted-foreground" data-testid="thinking-not-used">
          The model picked above does not take this setting, so it decides for itself.
        </span>
      )}
    </label>
  );
}

/**
 * "Model hosts" (OpenRouter only): OpenRouter can send the same model to
 * different hosts, and some of them don't support tools. The operator lists
 * the hosts to use only, and/or the ones never to use. Both empty = no
 * preference (null), i.e. OpenRouter picks, as before. Any other routing
 * fields already stored (a try-first order, the fallback switch) are kept.
 */
function ModelHostsSetting({
  value,
  disabled,
  onSave,
}: {
  value: LaneAProviderRouting | null;
  disabled?: boolean;
  onSave: (next: LaneAProviderRouting | null) => Promise<unknown>;
}) {
  const saved = normalizeLaneAProviderRouting(value);
  const savedOnly = (saved?.only ?? []).join(", ");
  const savedIgnore = (saved?.ignore ?? []).join(", ");
  const [onlyDraft, setOnlyDraft] = useState<string | null>(null);
  const [ignoreDraft, setIgnoreDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const only = onlyDraft ?? savedOnly;
  const ignore = ignoreDraft ?? savedIgnore;
  const dirty =
    (onlyDraft !== null && onlyDraft !== savedOnly) || (ignoreDraft !== null && ignoreDraft !== savedIgnore);

  const save = async () => {
    const parsedOnly = parseLaneAProviderSlugList(only);
    const parsedIgnore = parseLaneAProviderSlugList(ignore);
    const invalid = [...parsedOnly.invalid, ...parsedIgnore.invalid];
    if (invalid.length > 0) {
      setProblem(
        `"${invalid[0]}" is not a host name. Use the short names OpenRouter shows, like deepinfra or mistral, separated by commas.`,
      );
      return;
    }
    if (
      parsedOnly.slugs.length > LANE_A_PROVIDER_ROUTING_MAX_ENTRIES ||
      parsedIgnore.slugs.length > LANE_A_PROVIDER_ROUTING_MAX_ENTRIES
    ) {
      setProblem(`List at most ${LANE_A_PROVIDER_ROUTING_MAX_ENTRIES} hosts in each field.`);
      return;
    }
    setProblem(null);
    const { only: _oldOnly, ignore: _oldIgnore, ...kept } = saved ?? {};
    const next: LaneAProviderRouting = {
      ...kept,
      ...(parsedOnly.slugs.length > 0 ? { only: parsedOnly.slugs } : {}),
      ...(parsedIgnore.slugs.length > 0 ? { ignore: parsedIgnore.slugs } : {}),
    };
    try {
      await onSave(normalizeLaneAProviderRouting(next));
      setOnlyDraft(null);
      setIgnoreDraft(null);
    } catch (err) {
      // DUR-4353: this used to rely on the card's own error line, far above
      // this field, to say why the save failed — easy to miss, which is how
      // a rejected save could look just like a silently-dropped one. Show it
      // here, next to the fields it is actually about, and keep what was
      // typed so the operator does not have to retype it.
      setProblem(err instanceof ApiError ? err.message : "Could not save the model hosts.");
    }
  };

  return (
    <div className="space-y-2" data-testid="quick-agent-model-hosts">
      <div className="space-y-1">
        <p className="text-xs font-medium">Model hosts</p>
        <p className="text-xs text-muted-foreground">
          OpenRouter can send the same model to different hosts. Some hosts don't support tools. List the hosts you
          want (for example deepinfra) to stop it picking one that doesn't.
        </p>
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Use only these hosts</span>
        <Input
          type="text"
          value={only}
          placeholder="deepinfra"
          disabled={disabled}
          data-testid="model-hosts-only"
          onChange={(event) => setOnlyDraft(event.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Never use these hosts</span>
        <Input
          type="text"
          value={ignore}
          placeholder="venice"
          disabled={disabled}
          data-testid="model-hosts-ignore"
          onChange={(event) => setIgnoreDraft(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || disabled}
          data-testid="model-hosts-save"
          onClick={() => void save()}
        >
          Save
        </Button>
        <span className="text-xs text-muted-foreground">
          Separate hosts with commas. Leave both empty to let OpenRouter pick.
        </span>
      </div>
      {problem && (
        <p className="text-xs text-destructive" data-testid="model-hosts-problem">
          {problem}
        </p>
      )}
    </div>
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
          placeholder="Default"
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
          Save
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
      pushToast({ title: "Monthly limit saved", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the monthly limit");
    },
  });

  const spentDollars = policy ? centsToDollarString(policy.observedAmount) : "0.00";

  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">
        Maximum cost per month for rewriting (dollars)
      </span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          value={shown}
          placeholder="No limit"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate(Number(shown.trim() || 0))}
        >
          Save
        </Button>
      </div>
      <span className="block text-xs text-muted-foreground">
        {policy && policy.amount > 0
          ? `Spent so far this month: $${spentDollars}. When the limit is reached it stops rewriting text but keeps working otherwise — and you are asked whether to raise the limit.`
          : worstCaseDailyCents > 0
            ? // "Empty = no limit" is true but useless as a default on the
              // first thing that can spend Paperclip's money from outside
              // Paperclip. Say what no-limit actually means, in money.
              `Empty = no limit. Without a limit this quick agent could in the worst case spend around $${centsToDollarString(worstCaseDailyCents)} in one day, with the daily cap and model set above. Set a number if you want to be sure.`
            : `Empty = no limit. Paperclip has no price for this model, so its cost is recorded as 0 — set a limit with the provider if you want to be sure.`}
      </span>
      <span className="block text-xs text-muted-foreground">
        The amount is in dollars because model runs are billed in dollars — the same unit as the other
        budgets in Paperclip.
      </span>
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}
