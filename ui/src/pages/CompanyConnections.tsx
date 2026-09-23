import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isTestableSecretKind,
  secretKindLabel,
  secretKindsByCategory,
  type CompanySecret,
  type SecretKind,
  type SecretKindDescriptor,
  type SecretKindProvider,
} from "@paperclipai/shared";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Plug, Plus, Wrench } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { secretsApi } from "../api/secrets";
import { instanceSettingsApi } from "../api/instanceSettings";
import { instanceServerAnthropicKeyApi } from "../api/instanceServerAnthropicKey";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "../lib/instance-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddIntegrationTokenDialog } from "../components/AddIntegrationTokenDialog";
import { DataSourcesSection } from "../components/DataSourcesSection";
import { ServiceTokensSection } from "../components/ServiceTokensSection";
import { TelegramBotsSection } from "../components/TelegramBotsSection";

/**
 * DUR-3997 slice 4: Connections, the front door over everything a company is
 * connected to.
 *
 * Nothing here is new storage. AI-provider keys are the company's secrets
 * whose `kind` belongs to a provider; data sources, Telegram bots and service
 * tokens are the cards that used to sit at the bottom of General; "All
 * secrets" is the raw list. The page only reads, tests and links, and it
 * opens the existing dialogs to add anything.
 *
 * Who may change things: the company owner and admins (and an instance
 * admin, or the local board with no sign-in). Operators and viewers see
 * status only. That is a UI decision — every button below calls a server
 * route that keeps its own check.
 *
 * Nothing on this page ever shows a secret value: names, kinds, hints and
 * test results only.
 */

/** The five provider cards, in the order the design names them. */
export const AI_PROVIDER_CARDS: ReadonlyArray<{
  provider: SecretKindProvider;
  label: string;
  blurb: string;
  addKind: SecretKind;
}> = [
  {
    provider: "anthropic",
    label: "Claude",
    blurb: "Claude models from Anthropic. Quick agents on Claude use Paperclip's own key unless the company adds one here.",
    addKind: "anthropic_api_key",
  },
  {
    provider: "openai",
    label: "OpenAI",
    blurb: "GPT models from platform.openai.com.",
    addKind: "openai_api_key",
  },
  {
    provider: "google",
    label: "Google",
    blurb: "Gemini models from aistudio.google.com.",
    addKind: "google_api_key",
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    blurb: "Many models through one account at openrouter.ai.",
    addKind: "openrouter_api_key",
  },
  {
    provider: "local",
    label: "Local model",
    blurb: "A model server you run yourself, such as Ollama, LM Studio or vLLM.",
    addKind: "local_model_endpoint",
  },
];

const AI_PROVIDER_KINDS: readonly SecretKindDescriptor[] =
  secretKindsByCategory().find((group) => group.category === "ai_provider")?.kinds ?? [];

/** The company's secrets that belong to one provider, by their kind tag. */
export function secretsForProvider(secrets: CompanySecret[], provider: SecretKindProvider): CompanySecret[] {
  const kindIds = new Set(AI_PROVIDER_KINDS.filter((kind) => kind.provider === provider).map((kind) => kind.id));
  return secrets.filter((secret) => secret.kind !== null && kindIds.has(secret.kind));
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{children}</div>;
}

function LastTest({ secret }: { secret: CompanySecret }) {
  if (!isTestableSecretKind(secret.kind)) {
    return <span className="text-muted-foreground">Cannot be tested</span>;
  }
  if (secret.lastTestOk === null || secret.lastTestOk === undefined) {
    return <span className="text-muted-foreground">Not tested yet</span>;
  }
  const when = secret.lastTestAt ? ` · ${timeAgo(secret.lastTestAt)}` : "";
  return secret.lastTestOk ? (
    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" /> Works{when}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-destructive" title={secret.lastTestMessage ?? undefined}>
      <AlertCircle className="h-3.5 w-3.5" /> Refused by the provider{when}
    </span>
  );
}

function ProviderCard({
  card,
  secrets,
  canManage,
  onAddKey,
  onTest,
  testingId,
  extra,
}: {
  card: (typeof AI_PROVIDER_CARDS)[number];
  secrets: CompanySecret[];
  canManage: boolean;
  onAddKey: (kind: SecretKind) => void;
  onTest: (secret: CompanySecret) => void;
  testingId: string | null;
  extra?: React.ReactNode;
}) {
  return (
    <Card data-testid={`provider-card-${card.provider}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-sm">{card.label}</CardTitle>
            <CardDescription>{card.blurb}</CardDescription>
          </div>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => onAddKey(card.addKind)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add key
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {secrets.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {card.label} key saved for this company yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {secrets.map((secret) => (
              <li key={secret.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    <span className="truncate">{secret.name}</span>
                    {secret.status !== "active" && (
                      <Badge variant="outline" className="text-[10px]">
                        {secret.status}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {secretKindLabel(secret.kind)} · <LastTest secret={secret} />
                  </p>
                </div>
                {canManage && isTestableSecretKind(secret.kind) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onTest(secret)}
                    disabled={testingId !== null}
                  >
                    {testingId === secret.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    Test
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {extra}
      </CardContent>
    </Card>
  );
}

/**
 * Paperclip's own Claude key lives under Instance settings and its route is
 * instance-admin only (assertInstanceAdmin), so it is only asked for as one.
 * Everyone else gets the line and the link; an instance admin also sees
 * whether it is set and what Claude said the last time it was tested.
 */
function PaperclipOwnClaudeKeyLine({ canSee }: { canSee: boolean }) {
  const statusQuery = useQuery({
    queryKey: queryKeys.instance.serverAnthropicKey,
    queryFn: () => instanceServerAnthropicKeyApi.get(),
    enabled: canSee,
    retry: false,
  });
  const status = statusQuery.data ?? null;
  const text = !canSee
    ? "Managed by an instance admin. Used by quick agents on Claude that have no company key."
    : status
      ? status.headline
      : statusQuery.isError
        ? "Could not check Paperclip's own key right now. Used by quick agents on Claude that have no company key."
        : "Checking…";
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2"
      data-testid="paperclip-own-claude-key"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">Paperclip's own Claude key</p>
        <p className="text-xs text-muted-foreground">{text}</p>
      </div>
      <Button size="sm" variant="ghost" asChild>
        <Link to={`${INSTANCE_SETTINGS_PATH_PREFIX}/claude`}>Open Claude sign-in</Link>
      </Button>
    </div>
  );
}

export function CompanyConnections() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;
  const [addKind, setAddKind] = useState<SecretKind | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Connections" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId ?? ""),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const businessDataEnabled = experimentalSettings?.enableBusinessData === true;

  const secrets = useMemo(() => secretsQuery.data ?? [], [secretsQuery.data]);
  const untaggedCount = useMemo(() => secrets.filter((secret) => secret.kind === null).length, [secrets]);

  const testMutation = useMutation({
    mutationFn: (secret: CompanySecret) => secretsApi.test(selectedCompanyId!, secret.id),
    onMutate: (secret) => setTestingId(secret.id),
    onSettled: () => setTestingId(null),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
      pushToast({ title: result.message, tone: result.ok ? "success" : "warn" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof ApiError ? error.message : "Could not test the key",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Connections</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every key or password you add anywhere ends up in Secrets, so there is one place to see, update or
          remove them.
        </p>
        {!canManage && !role.isLoading && (
          <p className="text-xs text-muted-foreground" data-testid="connections-read-only-note">
            You can see the status of every connection here. Only the company owner or an admin can add or change
            them.
          </p>
        )}
      </div>

      {/* AI providers */}
      <div className="space-y-4" data-testid="connections-ai-providers">
        <SectionHeading>AI providers</SectionHeading>
        <p className="text-xs text-muted-foreground">
          A quick agent picks one of these keys. The company's own key wins over Paperclip's own key.
        </p>
        {secretsQuery.isError ? (
          // A failed list must not read as "no keys saved": show the error and
          // nothing else, so an outage never looks like an empty company.
          <p className="flex items-center gap-2 text-sm text-destructive" data-testid="connections-secrets-error">
            <AlertCircle className="h-4 w-4" />
            Could not load the company's keys: {(secretsQuery.error as Error).message}
            <Button variant="ghost" size="sm" onClick={() => secretsQuery.refetch()}>
              Retry
            </Button>
          </p>
        ) : (
          AI_PROVIDER_CARDS.map((card) => (
            <ProviderCard
              key={card.provider}
              card={card}
              secrets={secretsForProvider(secrets, card.provider)}
              canManage={canManage}
              onAddKey={setAddKind}
              onTest={(secret) => testMutation.mutate(secret)}
              testingId={testingId}
              extra={
                card.provider === "anthropic" ? <PaperclipOwnClaudeKeyLine canSee={role.isInstanceAdmin} /> : undefined
              }
            />
          ))
        )}
      </div>

      {/* Data sources */}
      <div className="space-y-4" data-testid="connections-data-sources">
        <SectionHeading>Data sources</SectionHeading>
        {businessDataEnabled ? (
          <DataSourcesSection companyId={selectedCompanyId} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Data sources</CardTitle>
              <CardDescription>
                Business data is switched off for this Paperclip. An instance admin can switch it on under
                Instance settings → Experimental; the Shopify data source then appears here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>

      {/* Messaging */}
      <div className="space-y-4" data-testid="connections-messaging">
        <SectionHeading>Messaging</SectionHeading>
        <TelegramBotsSection companyId={selectedCompanyId} readOnly={!canManage} />
        <ServiceTokensSection companyId={selectedCompanyId} readOnly={!canManage} />
      </div>

      {/* All secrets + Tools */}
      <div className="space-y-4" data-testid="connections-all-secrets">
        <SectionHeading>All secrets</SectionHeading>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {secretsQuery.isPending
                  ? "Loading…"
                  : secretsQuery.isError
                    ? "Could not load the secrets."
                    : `${secrets.length} secret${secrets.length === 1 ? "" : "s"} in this company`}
              </p>
              <p className="text-xs text-muted-foreground">
                The full list, including keys that do not belong to a provider above.
                {!secretsQuery.isError && untaggedCount > 0
                  ? ` ${untaggedCount} of them ${untaggedCount === 1 ? "has" : "have"} no kind yet, so ${untaggedCount === 1 ? "it does" : "they do"} not show under a provider — open ${untaggedCount === 1 ? "it" : "them"} in Secrets and choose what kind of key ${untaggedCount === 1 ? "it is" : "they are"}.`
                  : ""}
              </p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/company/settings/secrets">
                <KeyRound className="mr-1.5 h-3.5 w-3.5" /> Open Secrets
              </Link>
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              Tools (MCP servers) stay in the main menu. Their keys are picked from Secrets too.
            </p>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/tools">
                <Wrench className="mr-1.5 h-3.5 w-3.5" /> Open Tools
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {canManage && (
        <AddIntegrationTokenDialog
          open={addKind !== null}
          onOpenChange={(open) => {
            if (!open) setAddKind(null);
          }}
          companyId={selectedCompanyId}
          initialKind={addKind}
        />
      )}
    </div>
  );
}
