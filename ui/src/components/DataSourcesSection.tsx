import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DATA_CONNECTION_KINDS,
  DATA_CONNECTION_KIND_LABELS,
  FILE_SERVER_DEFAULT_PORTS,
  isFileServerKind,
  SUPPORTED_DATA_CONNECTION_KINDS,
  type DataConnectionAccessLevel,
  type DataConnectionCheckResult,
  type DataConnectionKind,
  type DataConnectionSummary,
  type DataReadEventSummary,
  type DataTrialCalculationResult,
  type FileServerKind,
  type ShopifyCredentialInput,
} from "@paperclipai/shared";
import { dataConnectionsApi, type CreateDataConnectionRequest } from "../api/dataConnections";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * DUR-3972 slice S2: "Datakilder" -- where the owner of a company connects it
 * to its own shop data, checks what Paperclip can see, runs a trial
 * calculation to compare with Shopify Analytics, and decides what the
 * company's agents may read.
 *
 * Written for the person doing that job, in Norwegian like the Telegram card
 * next to it: no ids, no jargon, and every Shopify permission name has its
 * meaning written next to it.
 *
 * The key fields are never pre-filled and the key is never shown again: the
 * server stores it as a locked company password and answers with the last
 * four characters only. The fields are emptied the moment a save succeeds.
 */

const REQUIRED_SCOPES: Array<{ scope: string; meaning: string }> = [
  { scope: "read_orders", meaning: "lese ordre" },
  { scope: "read_all_orders", meaning: "lese alle ordre, ikke bare de siste 60 dagene" },
  { scope: "read_products", meaning: "lese produkter" },
];

const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const LONG_MONTHS = [
  "januar",
  "februar",
  "mars",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "desember",
];

const pad2 = (value: number) => String(value).padStart(2, "0");

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** The two last finished months, oldest first: on 21 September, July and August. */
export function lastTwoClosedMonths(now: Date = new Date()): [string, string] {
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const beforeThat = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return [monthKeyOf(beforeThat), monthKeyOf(previous)];
}

function datePartsIn(iso: string, timeZone: string | null) {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return { day: get("day"), month: get("month"), year: get("year"), hour: get("hour"), minute: get("minute") };
  } catch {
    return {
      day: pad2(date.getDate()),
      month: pad2(date.getMonth() + 1),
      year: String(date.getFullYear()),
      hour: pad2(date.getHours()),
      minute: pad2(date.getMinutes()),
    };
  }
}

/** "12.03.2019" */
export function formatDate(iso: string, timeZone: string | null = null): string {
  const p = datePartsIn(iso, timeZone);
  return `${p.day}.${p.month}.${p.year}`;
}

/** "21.09 10:14" */
function formatShortDateTime(iso: string): string {
  const p = datePartsIn(iso, null);
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

function formatMonthKey(key: string, style: "short" | "long" = "short"): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const index = Number(match[2]) - 1;
  const names = style === "short" ? SHORT_MONTHS : LONG_MONTHS;
  return `${names[index] ?? match[2]} ${match[1]}`;
}

function describePeriod(token: unknown): string | null {
  if (typeof token !== "string") return null;
  if (token === "last_month") return "forrige måned";
  if (token === "month_before_last") return "måneden før forrige";
  if (token === "this_month_to_date") return "denne måneden så langt";
  if (/^\d{4}-\d{2}$/.test(token)) return formatMonthKey(token);
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const CHANNEL_TEXT: Record<string, string> = {
  quick_chat: " i chatten",
  telegram: " via Telegram",
  settings_test: "",
};

const OUTCOME_TEXT: Record<string, string> = {
  ok: "",
  no_data: " – ingen data for perioden",
  ambiguous: " – spurte hvilken produkttype som var ment",
  refused: " – avvist",
  rate_limited: " – stoppet av en grense for antall oppslag",
  upstream_error: " – Shopify svarte ikke som forventet",
};

/**
 * One lookup in plain words, for example
 * "Salgsanalytikeren leste Salg (Sofa, aug 2026 og jul 2026) via Telegram, 21.09 10:14".
 * Never an id: agents by name, people as "fra innstillingene".
 */
export function describeReadEvent(event: DataReadEventSummary): string {
  const when = formatShortDateTime(event.createdAt);
  const outcome = OUTCOME_TEXT[event.outcome] ?? "";
  if (event.dataset === "connection_check") {
    return `Test av koblingen fra innstillingene${outcome}, ${when}`;
  }
  const params = event.params ?? {};
  const details: string[] = [];
  const types = [...stringList(params.productTypes), ...stringList(params.product_types)];
  const typeQuery = typeof params.productTypeQuery === "string"
    ? params.productTypeQuery
    : typeof params.product_type_query === "string"
      ? params.product_type_query
      : null;
  if (types.length > 0) details.push(types.join(", "));
  else if (typeQuery) details.push(`«${typeQuery}»`);
  const periods = stringList(params.periods).map(describePeriod).filter((entry): entry is string => Boolean(entry));
  if (periods.length > 0) details.push(periods.join(" og "));
  const action = params.action === "catalog" ? "leste listen over produkttyper" : "leste Salg";
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";
  if (event.channel === "settings_test") {
    const what = params.action === "catalog" ? "Oppslag i produkttypene" : "Prøveberegning av Salg";
    return `${what}${detailText} fra innstillingene${outcome}, ${when}`;
  }
  const who = event.agentName ?? (event.agentId ? "En ansatt som ikke finnes lenger" : "Noen");
  return `${who} ${action}${detailText}${CHANNEL_TEXT[event.channel] ?? ""}${outcome}, ${when}`;
}

function statusText(connection: DataConnectionSummary): string {
  switch (connection.status) {
    case "active":
      return "På – testet og klar";
    case "disabled":
      return "Slått av";
    case "error":
      return "Testen fant problemer";
    default:
      return "Ikke testet ennå";
  }
}

/** The plain sentence out of an API error, including the first field message on a validation error. */
function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body as { details?: unknown } | null;
  if (Array.isArray(body?.details)) {
    const first = body!.details.find(
      (entry): entry is { message: string } =>
        Boolean(entry) && typeof entry === "object" && typeof (entry as { message?: unknown }).message === "string",
    );
    if (first) return first.message;
  }
  return error.message || fallback;
}

type CredentialKind = ShopifyCredentialInput["kind"];

const KIND_COMING_SOON_TEXT = "Kommer snart – lagret, ikke koblet til ennå.";

function kindSupported(kind: DataConnectionKind): boolean {
  return SUPPORTED_DATA_CONNECTION_KINDS.includes(kind);
}

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

/** The write-only Shopify key fields. Never pre-filled, always type=password. */
function CredentialFields({
  idPrefix,
  kind,
  onKindChange,
  accessToken,
  setAccessToken,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
}: {
  idPrefix: string;
  kind: CredentialKind;
  onKindChange: (kind: CredentialKind) => void;
  accessToken: string;
  setAccessToken: (value: string) => void;
  clientId: string;
  setClientId: (value: string) => void;
  clientSecret: string;
  setClientSecret: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${idPrefix}-kind`}>
          Hva slags nøkkel ga Shopify deg?
        </label>
        <select
          id={`${idPrefix}-kind`}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          value={kind}
          onChange={(event) => onKindChange(event.target.value as CredentialKind)}
        >
          <option value="client_credentials">Klient-ID og klienthemmelighet (app laget i Shopify Dev Dashboard)</option>
          <option value="admin_access_token">Tilgangsnøkkel som starter med shpat_ (eldre app laget i butikkens admin)</option>
        </select>
      </div>
      {kind === "admin_access_token" ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`${idPrefix}-token`}>
            Tilgangsnøkkel
          </label>
          <Input
            id={`${idPrefix}-token`}
            type="password"
            autoComplete="off"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            placeholder="shpat_…"
          />
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[12rem] flex-1 space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`${idPrefix}-client-id`}>
              Klient-ID
            </label>
            <Input
              id={`${idPrefix}-client-id`}
              type="password"
              autoComplete="off"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </div>
          <div className="min-w-[12rem] flex-1 space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`${idPrefix}-client-secret`}>
              Klienthemmelighet
            </label>
            <Input
              id={`${idPrefix}-client-secret`}
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function useCredentialState() {
  const [kind, setKind] = useState<CredentialKind>("client_credentials");
  const [accessToken, setAccessToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const credential: ShopifyCredentialInput =
    kind === "admin_access_token"
      ? { kind, accessToken: accessToken.trim() }
      : { kind, clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  const filled = kind === "admin_access_token" ? Boolean(accessToken.trim()) : Boolean(clientId.trim() && clientSecret.trim());
  const clear = () => {
    setAccessToken("");
    setClientId("");
    setClientSecret("");
  };
  return {
    credential,
    filled,
    clear,
    fieldProps: { kind, onKindChange: setKind, accessToken, setAccessToken, clientId, setClientId, clientSecret, setClientSecret },
  };
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  );
}

function ScopeHelp() {
  return (
    <p className="text-xs text-muted-foreground">
      Appen i Shopify skal ha nøyaktig tre tilganger:{" "}
      {REQUIRED_SCOPES.map((entry, index) => (
        <span key={entry.scope}>
          {index > 0 ? (index === REQUIRED_SCOPES.length - 1 ? " og " : ", ") : ""}
          {entry.meaning} (<span className="font-mono">{entry.scope}</span>)
        </span>
      ))}
      . Ingen tilganger som kan endre noe, og ingen kundedata.
    </p>
  );
}

function TestFindings({
  connection,
  lastTest,
}: {
  connection: DataConnectionSummary;
  lastTest: DataConnectionCheckResult | null;
}) {
  const observed = connection.observed;
  const problems = connection.lastCheckError ? connection.lastCheckError.split("\n").filter(Boolean) : [];
  if (!observed && problems.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Trykk Test for å se hvilken butikk nøkkelen hører til og hva Paperclip får lese.
      </p>
    );
  }
  const scopes = observed?.grantedScopes ?? [];
  const writeScopes = scopes.filter((scope) => /^(unauthenticated_)?write_/.test(scope));
  const missingAllOrders = observed !== null && !scopes.includes("read_all_orders");
  const coverage = observed?.productTypeCoverage ?? null;
  const notes = lastTest?.notes ?? [];
  return (
    <div className="space-y-3" data-testid="data-connection-findings">
      {observed && (
        <div className="space-y-0.5 rounded-md border px-3 py-2">
          <PropertyRow label="Butikk">
            {observed.shopName ?? "Ukjent"}
            {observed.shopDomain ? <span className="text-muted-foreground"> ({observed.shopDomain})</span> : null}
          </PropertyRow>
          <PropertyRow label="Valuta">{observed.currencyCode ?? "Ukjent"}</PropertyRow>
          <PropertyRow label="Tidssone">{observed.ianaTimezone ?? "Ukjent"}</PropertyRow>
          <PropertyRow label="Skrivetilgang">
            {writeScopes.length === 0 ? (
              "Ingen skrivetilgang – Paperclip kan bare lese"
            ) : (
              <span className="text-destructive">Nøkkelen kan endre ting i butikken – må fjernes i Shopify</span>
            )}
          </PropertyRow>
          <PropertyRow label="Ordre">
            {observed.earliestVisibleOrderAt
              ? `Kan se ordre tilbake til ${formatDate(observed.earliestVisibleOrderAt, observed.ianaTimezone)}`
              : scopes.includes("read_orders")
                ? "Ser ingen ordre i butikken"
                : "Kan ikke lese ordre"}
          </PropertyRow>
          {connection.lastCheckAt && (
            <PropertyRow label="Sist testet">{formatShortDateTime(connection.lastCheckAt)}</PropertyRow>
          )}
        </div>
      )}

      {missingAllOrders && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm" role="alert">
          Shopify viser bare ordre fra de siste 60 dagene til denne nøkkelen, så måneder lenger tilbake kan ikke regnes
          ut. Legg til tilgangen «lese alle ordre, ikke bare de siste 60 dagene» (
          <span className="font-mono">read_all_orders</span>) på appen i Shopify, og trykk Test igjen. Skriv
          «rapportering på tidligere måneder» hvis Shopify spør hvorfor.
        </div>
      )}

      {problems.length > 0 && (
        <ul className="space-y-1 text-sm text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {coverage && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            Produkttyper i butikken ({coverage.types.length})
          </p>
          {coverage.types.length > 0 ? (
            <ul className="max-h-48 overflow-y-auto rounded-md border text-sm">
              {coverage.types.map((type) => (
                <li key={type.productType} className="flex justify-between gap-3 border-b px-3 py-1 last:border-b-0">
                  <span>{type.productType}</span>
                  <span className="text-xs text-muted-foreground">
                    {type.products} {type.products === 1 ? "produkt" : "produkter"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Ingen produkter har produkttype.</p>
          )}
          <p className="text-xs text-muted-foreground">
            {coverage.productsWithoutType === 0
              ? `Alle ${coverage.productsScanned} produktene har en produkttype.`
              : `${coverage.productsWithoutType} av ${coverage.productsScanned} produkter har ingen produkttype. De telles for seg som «(uten produkttype)» i svar.`}
            {coverage.complete ? "" : " Butikken har flere produkter enn Paperclip talte, så listen er ikke komplett."}
          </p>
        </div>
      )}
    </div>
  );
}

function TrialCalculation({ companyId, connection }: { companyId: string; connection: DataConnectionSummary }) {
  const [defaultFirst, defaultSecond] = lastTwoClosedMonths();
  const [firstMonth, setFirstMonth] = useState(defaultFirst);
  const [secondMonth, setSecondMonth] = useState(defaultSecond);
  const [byType, setByType] = useState(true);
  const [result, setResult] = useState<DataTrialCalculationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const ready = connection.status === "active";
  const periods = [firstMonth, secondMonth].filter((value) => /^\d{4}-\d{2}$/.test(value));

  const trialMutation = useMutation({
    mutationFn: () =>
      dataConnectionsApi.trial(companyId, connection.id, {
        periods,
        groupBy: byType ? "product_type" : "none",
      }),
    onSuccess: (data) => {
      setError(null);
      setResult(data);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.dataReads(companyId) });
    },
    onError: (err) => {
      setResult(null);
      setError(errorMessage(err, "Kunne ikke kjøre prøveberegningen"));
    },
  });

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="data-trial">
      <p className="text-sm font-medium">Prøveberegning</p>
      <p className="text-xs text-muted-foreground">
        Regn ut solgte enheter for én eller to måneder akkurat slik de ansatte vil få dem, og sammenlign med Shopify
        Analytics (rapporten «Net items sold by product type» for de samme månedene) før du slår på Salg. Hver
        forskjell bør kunne forklares.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`data-trial-first-${connection.id}`}>
            Første måned
          </label>
          <Input
            id={`data-trial-first-${connection.id}`}
            type="month"
            value={firstMonth}
            onChange={(event) => setFirstMonth(event.target.value)}
            className="w-44"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`data-trial-second-${connection.id}`}>
            Andre måned (kan stå tom)
          </label>
          <Input
            id={`data-trial-second-${connection.id}`}
            type="month"
            value={secondMonth}
            onChange={(event) => setSecondMonth(event.target.value)}
            className="w-44"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={byType} onChange={(event) => setByType(event.target.checked)} />
          Del opp etter produkttype
        </label>
        <Button
          size="sm"
          onClick={() => trialMutation.mutate()}
          disabled={!ready || periods.length === 0 || trialMutation.isPending}
        >
          {trialMutation.isPending ? "Regner…" : "Regn ut"}
        </Button>
      </div>
      {!ready && (
        <p className="text-xs text-muted-foreground">
          Prøveberegningen kan kjøres når koblingen er testet og slått på.
        </p>
      )}
      {trialMutation.isPending && (
        <p className="text-xs text-muted-foreground">Går gjennom ordrene i Shopify. Det kan ta opptil et halvt minutt.</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && !result.ok && (
        <p className="text-sm text-destructive" role="alert">
          {result.message}
        </p>
      )}
      {result && result.ok && (
        <div className="space-y-2">
          <pre className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-sans text-sm" data-testid="data-trial-card">
            {result.card}
          </pre>
          {result.reconciliationNotes.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Merknader til sammenligningen</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {result.reconciliationNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionPanel({
  companyId,
  connection,
  onError,
}: {
  companyId: string;
  connection: DataConnectionSummary;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [lastTest, setLastTest] = useState<DataConnectionCheckResult | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [cap, setCap] = useState(String(connection.dailyLookupCap));
  const rotateCredential = useCredentialState();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.dataConnections(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.dataReads(companyId) });
  };
  const fail = (fallback: string) => (err: unknown) => onError(errorMessage(err, fallback));

  const testMutation = useMutation({
    mutationFn: () => dataConnectionsApi.test(companyId, connection.id),
    onSuccess: (result) => {
      onError(null);
      setLastTest(result);
      invalidate();
      pushToast({
        title: result.canActivate ? "Testen gikk gjennom. Koblingen er slått på." : "Testen fant problemer",
        tone: result.canActivate ? "success" : "warn",
      });
    },
    onError: fail("Kunne ikke teste koblingen"),
  });

  const rotateMutation = useMutation({
    mutationFn: () => dataConnectionsApi.update(companyId, connection.id, { credential: rotateCredential.credential }),
    onSuccess: () => {
      // Clear the key first: it must not sit in the page after it is saved.
      rotateCredential.clear();
      setRotating(false);
      setLastTest(null);
      onError(null);
      invalidate();
      pushToast({ title: "Ny nøkkel lagret. Trykk Test før den tas i bruk.", tone: "success" });
    },
    onError: fail("Kunne ikke lagre den nye nøkkelen"),
  });

  const statusMutation = useMutation({
    mutationFn: (status: "active" | "disabled") => dataConnectionsApi.update(companyId, connection.id, { status }),
    onSuccess: (_data, status) => {
      onError(null);
      invalidate();
      pushToast({ title: status === "active" ? "Koblingen er slått på" : "Koblingen er slått av", tone: "success" });
    },
    onError: fail("Kunne ikke endre koblingen"),
  });

  const capMutation = useMutation({
    mutationFn: (value: number) => dataConnectionsApi.update(companyId, connection.id, { dailyLookupCap: value }),
    onSuccess: () => {
      onError(null);
      invalidate();
      pushToast({ title: "Grensen er lagret", tone: "success" });
    },
    onError: fail("Kunne ikke lagre grensen"),
  });

  const removeMutation = useMutation({
    mutationFn: () => dataConnectionsApi.remove(companyId, connection.id),
    onSuccess: () => {
      setConfirmRemove(false);
      onError(null);
      invalidate();
      pushToast({ title: "Koblingen er fjernet og nøkkelen slettet", tone: "success" });
    },
    onError: fail("Kunne ikke fjerne koblingen"),
  });

  const capValue = Number.parseInt(cap, 10);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= 100_000;

  if (!connection.supported) {
    // Saved, credential locked to it, but no adapter yet: nothing to test,
    // nothing to calculate. It can be removed (and its key deleted) at any time.
    return (
      <li className="space-y-3 px-3 py-3" data-testid="data-connection-pending">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {connection.name} – {connection.target}
            </p>
            <p className="text-xs text-muted-foreground">
              {connection.kindLabel} · Nøkkel {connection.credentialHint}
            </p>
            <p className="text-xs text-muted-foreground">{KIND_COMING_SOON_TEXT}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {confirmRemove ? (
              <>
                <Button size="sm" variant="destructive" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending}>
                  Ja, fjern koblingen
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Avbryt
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                Fjern
              </Button>
            )}
          </div>
        </div>
        {confirmRemove && (
          <p className="text-xs text-destructive">Den lagrede nøkkelen slettes. Du kan koble til igjen senere.</p>
        )}
      </li>
    );
  }

  return (
    <li className="space-y-3 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {connection.name} – {connection.target}
          </p>
          <p className="text-xs text-muted-foreground">
            Nøkkel {connection.credentialHint} · {statusText(connection)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending ? "Tester…" : "Test"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              rotateCredential.clear();
              setRotating(!rotating);
            }}
          >
            Bytt nøkkel
          </Button>
          {connection.status === "disabled" ? (
            <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate("active")} disabled={statusMutation.isPending}>
              Slå på
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate("disabled")} disabled={statusMutation.isPending}>
              Slå av
            </Button>
          )}
          {confirmRemove ? (
            <>
              <Button size="sm" variant="destructive" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending}>
                Ja, fjern koblingen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Avbryt
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
              Fjern
            </Button>
          )}
        </div>
      </div>

      {confirmRemove && (
        <p className="text-xs text-destructive">
          De ansatte slutter å kunne lese fra denne butikken, og den lagrede nøkkelen slettes. Loggen over oppslag blir
          liggende. Du kan koble til igjen senere med en ny nøkkel.
        </p>
      )}

      {rotating && (
        <div className="space-y-2 rounded-md border p-3">
          <CredentialFields idPrefix={`data-rotate-${connection.id}`} {...rotateCredential.fieldProps} />
          <p className="text-xs text-muted-foreground">
            Den gamle nøkkelen slutter å gjelde med en gang. Koblingen må testes på nytt før den brukes igjen.
          </p>
          <Button
            size="sm"
            onClick={() => rotateMutation.mutate()}
            disabled={!rotateCredential.filled || rotateMutation.isPending}
          >
            Lagre ny nøkkel
          </Button>
        </div>
      )}

      <TestFindings connection={connection} lastTest={lastTest} />

      <TrialCalculation companyId={companyId} connection={connection} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`data-cap-${connection.id}`}>
            Oppslag per dag
          </label>
          <Input
            id={`data-cap-${connection.id}`}
            type="number"
            min={1}
            max={100000}
            value={cap}
            onChange={(event) => setCap(event.target.value)}
            className="w-32"
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => capMutation.mutate(capValue)}
          disabled={!capValid || capValue === connection.dailyLookupCap || capMutation.isPending}
        >
          Lagre grense
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          Hvor mange oppslag alle i selskapet til sammen kan gjøre per døgn. Når grensen er nådd, svarer de ansatte at
          den er brukt opp, til midnatt.
        </p>
      </div>
    </li>
  );
}

function DatasetChoice({
  companyId,
  connections,
  onError,
}: {
  companyId: string;
  connections: DataConnectionSummary[];
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const current = connections.find((connection) => connection.datasets.includes("sales")) ?? null;
  const usable = connections.filter(
    (connection) => connection.status === "active" && connection.supported && connection.datasetsOffered.includes("sales"),
  );
  const [chosenId, setChosenId] = useState<string>(usable[0]?.id ?? "");
  const target = current ?? usable.find((connection) => connection.id === chosenId) ?? usable[0] ?? null;

  const salesMutation = useMutation({
    mutationFn: (connectionId: string | null) => dataConnectionsApi.setDatasetSource(companyId, "sales", connectionId),
    onSuccess: (data) => {
      onError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.dataConnections(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.datasetSources(companyId) });
      pushToast({
        title: data.source ? "De ansatte kan nå lese salgstall" : "De ansatte kan ikke lenger lese salgstall",
        tone: "success",
      });
    },
    onError: (err) => onError(errorMessage(err, "Kunne ikke endre hva de ansatte kan lese")),
  });

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="data-datasets">
      <p className="text-sm font-medium">Hva de ansatte i selskapet kan lese</p>
      <p className="text-xs text-muted-foreground">
        Gjelder alle de ansatte i dette selskapet, også de som ansettes senere. De kan bare lese, aldri endre noe, og
        aldri se tall fra et annet selskap.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Salg"
          checked={current !== null}
          disabled={salesMutation.isPending || (current === null && target === null)}
          onChange={(event) => salesMutation.mutate(event.target.checked ? (target?.id ?? null) : null)}
        />
        <span>
          <span className="font-medium">Salg</span>
          <span className="block text-xs text-muted-foreground">
            {current
              ? `Antall solgte og returnerte enheter per måned og produkttype, fra ${current.target}.`
              : target
                ? `Antall solgte og returnerte enheter per måned og produkttype, fra ${target.target}. Kjør prøveberegningen først.`
                : "Koble til og test en butikk først."}
          </span>
        </span>
      </label>
      {current === null && usable.length > 1 && (
        <select
          aria-label="Hvilken butikk skal salgstallene komme fra?"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          value={chosenId}
          onChange={(event) => setChosenId(event.target.value)}
        >
          {usable.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} – {connection.target}
            </option>
          ))}
        </select>
      )}
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <input type="checkbox" aria-label="Lager" checked={false} disabled readOnly />
        <span>
          <span className="font-medium">Lager</span>
          <span className="block text-xs">Kommer senere.</span>
        </span>
      </label>
    </div>
  );
}

function RecentLookups({ companyId }: { companyId: string }) {
  const readsQuery = useQuery({
    queryKey: queryKeys.companies.dataReads(companyId),
    queryFn: () => dataConnectionsApi.listReads(companyId, 20),
  });
  const reads = readsQuery.data ?? [];
  return (
    <div className="space-y-1.5" data-testid="data-reads">
      <p className="text-sm font-medium">Siste oppslag</p>
      {readsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Henter…</p>
      ) : reads.length === 0 ? (
        <p className="text-xs text-muted-foreground">Ingen oppslag ennå.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {reads.map((event) => (
            <li key={event.id} className="px-3 py-1.5">
              {describeReadEvent(event)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

/**
 * "Koble til": pick a kind, fill its fields, save. Every secret field is
 * type=password (or a password-styled textarea for a private key), never
 * pre-filled, and emptied the moment a save succeeds. A kind that is not
 * readable yet is saved all the same and shown as "kommer snart".
 */
function NewConnectionForm({
  companyId,
  onSaved,
  onError,
}: {
  companyId: string;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [kind, setKind] = useState<DataConnectionKind>("shopify");
  const [name, setName] = useState("");
  // Shopify
  const [shopDomain, setShopDomain] = useState("");
  const newCredential = useCredentialState();
  // WooCommerce
  const [storeUrl, setStoreUrl] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  // Fiken
  const [companySlug, setCompanySlug] = useState("");
  const [apiToken, setApiToken] = useState("");
  // File servers (FTP / FTPS / SFTP)
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [access, setAccess] = useState<DataConnectionAccessLevel>("read");
  const [acknowledgedUnencrypted, setAcknowledgedUnencrypted] = useState(false);
  const [sftpCredentialKind, setSftpCredentialKind] = useState<"password" | "private_key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");

  const clearSecrets = () => {
    newCredential.clear();
    setConsumerKey("");
    setConsumerSecret("");
    setApiToken("");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
  };

  const displayName = name.trim() || DATA_CONNECTION_KIND_LABELS[kind];
  const portValue = Number.parseInt(port, 10);

  function buildRequest(): CreateDataConnectionRequest | null {
    switch (kind) {
      case "shopify":
        if (!shopDomain.trim() || !newCredential.filled) return null;
        return { kind, name: displayName, shopDomain: shopDomain.trim(), credential: newCredential.credential };
      case "woocommerce":
        if (!storeUrl.trim() || !consumerKey.trim() || !consumerSecret.trim()) return null;
        return {
          kind,
          name: displayName,
          storeUrl: storeUrl.trim(),
          credential: { kind: "consumer_key_secret", consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim() },
        };
      case "fiken":
        if (!companySlug.trim() || !apiToken.trim()) return null;
        return { kind, name: displayName, companySlug: companySlug.trim(), credential: { kind: "api_token", apiToken: apiToken.trim() } };
      case "ftp_file":
      case "ftps_file":
      case "sftp_file": {
        if (!host.trim() || !username.trim() || !remotePath.trim() || !Number.isInteger(portValue)) return null;
        const base = {
          name: displayName,
          host: host.trim(),
          port: portValue,
          username: username.trim(),
          remotePath: remotePath.trim(),
          access,
        };
        // Only SFTP takes a private key; FTP and FTPS take a password.
        if (kind === "sftp_file") {
          const useKey = sftpCredentialKind === "private_key";
          if (useKey ? !privateKey.trim() : !password) return null;
          return {
            kind,
            ...base,
            credential: useKey
              ? { kind: "private_key", privateKey: privateKey.trim(), ...(passphrase ? { passphrase } : {}) }
              : { kind: "password", password },
          };
        }
        if (!password) return null;
        if (kind === "ftp_file") {
          if (!acknowledgedUnencrypted) return null;
          return { kind, ...base, credential: { kind: "password", password }, acknowledgedUnencrypted: true };
        }
        return { kind, ...base, credential: { kind: "password", password } };
      }
    }
  }

  const request = buildRequest();

  const createMutation = useMutation({
    mutationFn: (data: CreateDataConnectionRequest) => dataConnectionsApi.create(companyId, data),
    onSuccess: (_created, data) => {
      // Clear the key first: it must not sit in the page after it is saved.
      clearSecrets();
      setShopDomain("");
      setStoreUrl("");
      setCompanySlug("");
      setHost("");
      setPort("22");
      setUsername("");
      setRemotePath("");
      setName("");
      onError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.dataConnections(companyId) });
      pushToast({
        title: kindSupported(data.kind)
          ? "Butikken er koblet til. Trykk Test for å sjekke den."
          : `${DATA_CONNECTION_KIND_LABELS[data.kind]} er lagret. ${KIND_COMING_SOON_TEXT}`,
        tone: "success",
      });
      onSaved();
    },
    onError: (err) => onError(errorMessage(err, "Kunne ikke koble til datakilden")),
  });

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="data-new-connection">
      <p className="text-sm font-medium">Koble til {DATA_CONNECTION_KIND_LABELS[kind]}</p>
      <Field id="data-source-kind" label="Hva slags datakilde?">
        <select
          id="data-source-kind"
          className={SELECT_CLASS}
          value={kind}
          onChange={(event) => {
            clearSecrets();
            const next = event.target.value as DataConnectionKind;
            setKind(next);
            setSftpCredentialKind("password");
            setAcknowledgedUnencrypted(false);
            if (isFileServerKind(next)) setPort(String(FILE_SERVER_DEFAULT_PORTS[next as FileServerKind]));
          }}
        >
          {DATA_CONNECTION_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_CONNECTION_KIND_LABELS[entry]}
              {kindSupported(entry) ? "" : " (kommer snart)"}
            </option>
          ))}
        </select>
      </Field>
      {!kindSupported(kind) && (
        <p className="text-xs text-muted-foreground" data-testid="data-kind-coming-soon">
          {DATA_CONNECTION_KIND_LABELS[kind]} kan lagres nå, men Paperclip kan ikke lese fra den ennå. Nøkkelen lagres
          låst til denne koblingen og tas i bruk når støtten er klar.
        </p>
      )}

      {kind === "shopify" && (
        <>
          <Field
            id="data-shop-domain"
            label="Butikkens Shopify-adresse"
            help="Adressen som slutter på .myshopify.com. Du finner den i Shopify under Innstillinger → Domener."
          >
            <Input
              id="data-shop-domain"
              value={shopDomain}
              onChange={(event) => setShopDomain(event.target.value)}
              placeholder="nordstrand.myshopify.com"
              autoComplete="off"
            />
          </Field>
          <CredentialFields idPrefix="data-new" {...newCredential.fieldProps} />
          <ScopeHelp />
        </>
      )}

      {kind === "woocommerce" && (
        <>
          <Field id="data-store-url" label="Butikkens adresse" help="Den offentlige https-adressen til nettbutikken.">
            <Input
              id="data-store-url"
              value={storeUrl}
              onChange={(event) => setStoreUrl(event.target.value)}
              placeholder="https://butikken.no"
              autoComplete="off"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[12rem] flex-1">
              <Field id="data-new-consumer-key" label="Consumer key">
                <Input
                  id="data-new-consumer-key"
                  type="password"
                  autoComplete="off"
                  value={consumerKey}
                  onChange={(event) => setConsumerKey(event.target.value)}
                  placeholder="ck_…"
                />
              </Field>
            </div>
            <div className="min-w-[12rem] flex-1">
              <Field id="data-new-consumer-secret" label="Consumer secret">
                <Input
                  id="data-new-consumer-secret"
                  type="password"
                  autoComplete="off"
                  value={consumerSecret}
                  onChange={(event) => setConsumerSecret(event.target.value)}
                  placeholder="cs_…"
                />
              </Field>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Lag nøkkelen i WooCommerce under Innstillinger → Avansert → REST API, med tilgang «Les» (Read), ikke
            «Les/skriv».
          </p>
        </>
      )}

      {kind === "fiken" && (
        <>
          <Field
            id="data-fiken-slug"
            label="Selskapets Fiken-slug"
            help="Du finner den i adressen når du er inne i selskapet i Fiken, for eksempel fiken-demo-firma-as."
          >
            <Input
              id="data-fiken-slug"
              value={companySlug}
              onChange={(event) => setCompanySlug(event.target.value)}
              placeholder="fiken-demo-firma-as"
              autoComplete="off"
            />
          </Field>
          <Field id="data-new-api-token" label="API-nøkkel fra Fiken">
            <Input
              id="data-new-api-token"
              type="password"
              autoComplete="off"
              value={apiToken}
              onChange={(event) => setApiToken(event.target.value)}
            />
          </Field>
        </>
      )}

      {isFileServerKind(kind) && (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[12rem] flex-1">
              <Field id="data-sftp-host" label="Server">
                <Input
                  id="data-sftp-host"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="files.example.com"
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="w-24">
              <Field id="data-sftp-port" label="Port">
                <Input
                  id="data-sftp-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </Field>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[12rem] flex-1">
              <Field id="data-sftp-username" label="User name">
                <Input
                  id="data-sftp-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="min-w-[12rem] flex-1">
              <Field id="data-sftp-path" label="Base folder" help="The full path on the server. Paths agents ask for are confined to this folder.">
                <Input
                  id="data-sftp-path"
                  value={remotePath}
                  onChange={(event) => setRemotePath(event.target.value)}
                  placeholder="/reports"
                  autoComplete="off"
                />
              </Field>
            </div>
          </div>
          <Field
            id="data-sftp-access"
            label="Access"
            help="Read-only for a partner's server. Read and write only for the company's own server, where agents may push reports later."
          >
            <select
              id="data-sftp-access"
              className={SELECT_CLASS}
              value={access}
              onChange={(event) => setAccess(event.target.value as DataConnectionAccessLevel)}
            >
              <option value="read">Read only</option>
              <option value="read_write">Read and write</option>
            </select>
          </Field>
          {kind === "sftp_file" && (
            <Field id="data-new-sftp-credential-kind" label="How does Paperclip sign in?">
              <select
                id="data-new-sftp-credential-kind"
                className={SELECT_CLASS}
                value={sftpCredentialKind}
                onChange={(event) => {
                  clearSecrets();
                  setSftpCredentialKind(event.target.value as "password" | "private_key");
                }}
              >
                <option value="password">With a password</option>
                <option value="private_key">With a private key (SSH)</option>
              </select>
            </Field>
          )}
          {kind === "sftp_file" && sftpCredentialKind === "private_key" ? (
            <>
              <Field id="data-new-private-key" label="Private key" help="The whole key, from -----BEGIN to -----END.">
                <textarea
                  id="data-new-private-key"
                  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm"
                  style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
                  autoComplete="off"
                  spellCheck={false}
                  value={privateKey}
                  onChange={(event) => setPrivateKey(event.target.value)}
                />
              </Field>
              <Field id="data-new-passphrase" label="Passphrase (if the key has one)">
                <Input
                  id="data-new-passphrase"
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field id="data-new-sftp-password" label="Password">
              <Input
                id="data-new-sftp-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
          {kind === "ftp_file" && (
            <label className="flex items-start gap-2 text-xs text-destructive" htmlFor="data-ftp-ack">
              <input
                id="data-ftp-ack"
                type="checkbox"
                checked={acknowledgedUnencrypted}
                onChange={(event) => setAcknowledgedUnencrypted(event.target.checked)}
              />
              <span>
                Plain FTP sends the password and every file unencrypted. I understand the password travels unencrypted.
                Choose FTPS or SFTP for an encrypted connection.
              </span>
            </label>
          )}
        </>
      )}

      <Field id="data-connection-name" label="Navn (valgfritt)" help={`Vises i listen. Tomt betyr «${DATA_CONNECTION_KIND_LABELS[kind]}».`}>
        <Input
          id="data-connection-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={DATA_CONNECTION_KIND_LABELS[kind]}
          autoComplete="off"
          maxLength={80}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Nøkkelen lagres som et låst passord som bare denne koblingen kan bruke, og vises aldri igjen. Du kan bytte den
        når som helst.
      </p>
      <Button onClick={() => request && createMutation.mutate(request)} disabled={!request || createMutation.isPending}>
        {createMutation.isPending ? "Kobler til…" : kindSupported(kind) ? "Koble til" : "Lagre"}
      </Button>
    </div>
  );
}

export function DataSourcesSection({ companyId }: { companyId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const connectionsQuery = useQuery({
    queryKey: queryKeys.companies.dataConnections(companyId),
    queryFn: () => dataConnectionsApi.list(companyId),
    retry: false,
  });

  const header = (
    <CardHeader>
      <CardTitle>Datakilder</CardTitle>
      <CardDescription>
        Her kobler du selskapet til sine egne salgstall, slik at de ansatte kan svare på spørsmål som «hvor mange
        sofaer solgte vi i august mot juli?». Paperclip tar vare på nøkkelen og gjør alle oppslag selv: de ansatte ser
        aldri nøkkelen, kan bare lese og aldri endre noe, og får bare tall fra dette selskapet. Alle oppslag blir
        logget nedenfor.
      </CardDescription>
    </CardHeader>
  );

  if (connectionsQuery.error) {
    const err = connectionsQuery.error;
    const message =
      err instanceof ApiError && err.status === 403
        ? "Bare eieren av selskapet eller en administrator for hele Paperclip kan se og endre datakilder."
        : errorMessage(err, "Kunne ikke hente datakildene.");
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    );
  }

  const connections = connectionsQuery.data ?? [];

  return (
    <Card>
      {header}
      <CardContent className="space-y-4">
        {connectionsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Henter…</p>
        ) : (
          <>
            {connections.length > 0 && (
              <ul className="divide-y rounded-md border">
                {connections.map((connection) => (
                  <ConnectionPanel key={connection.id} companyId={companyId} connection={connection} onError={setError} />
                ))}
              </ul>
            )}
            {connections.length === 0 || adding ? (
              <NewConnectionForm companyId={companyId} onSaved={() => setAdding(false)} onError={setError} />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                Legg til datakilde
              </Button>
            )}
          </>
        )}

        {connections.length > 0 && (
          <DatasetChoice companyId={companyId} connections={connections} onError={setError} />
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {connections.length > 0 && <RecentLookups companyId={companyId} />}
      </CardContent>
    </Card>
  );
}
