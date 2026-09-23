import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DATA_CONNECTION_KINDS,
  DATA_CONNECTION_KIND_LABELS,
  SUPPORTED_DATA_CONNECTION_KINDS,
  type DataConnectionCheckResult,
  type DataConnectionKind,
  type DataConnectionSummary,
  type DataReadEventSummary,
  type DataTrialCalculationResult,
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
 * DUR-3972 slice S2: "Data sources" -- where the owner of a company connects it
 * to its own shop data, checks what Paperclip can see, runs a trial
 * calculation to compare with Shopify Analytics, and decides what the
 * company's agents may read.
 *
 * Written for the person doing that job, in plain English like the Telegram
 * card next to it: no ids, no jargon, and every Shopify permission name has
 * its meaning written next to it.
 *
 * The key fields are never pre-filled and the key is never shown again: the
 * server stores it as a locked company password and answers with the last
 * four characters only. The fields are emptied the moment a save succeeds.
 */

const REQUIRED_SCOPES: Array<{ scope: string; meaning: string }> = [
  { scope: "read_orders", meaning: "read orders" },
  { scope: "read_all_orders", meaning: "read all orders, not only the last 60 days" },
  { scope: "read_products", meaning: "read products" },
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
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
  if (token === "last_month") return "last month";
  if (token === "month_before_last") return "the month before last";
  if (token === "this_month_to_date") return "this month so far";
  if (/^\d{4}-\d{2}$/.test(token)) return formatMonthKey(token);
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const CHANNEL_TEXT: Record<string, string> = {
  quick_chat: " in chat",
  telegram: " via Telegram",
  settings_test: "",
};

const OUTCOME_TEXT: Record<string, string> = {
  ok: "",
  no_data: " – no data for the period",
  ambiguous: " – asked which product type was meant",
  refused: " – refused",
  rate_limited: " – stopped by a lookup limit",
  upstream_error: " – Shopify did not answer as expected",
};

/**
 * One lookup in plain words, for example
 * "Sales analyst read Sales (Sofa, Aug 2026 and Jul 2026) via Telegram, 21.09 10:14".
 * Never an id: agents by name, people as "from settings".
 */
export function describeReadEvent(event: DataReadEventSummary): string {
  const when = formatShortDateTime(event.createdAt);
  const outcome = OUTCOME_TEXT[event.outcome] ?? "";
  if (event.dataset === "connection_check") {
    return `Connection test from settings${outcome}, ${when}`;
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
  else if (typeQuery) details.push(`“${typeQuery}”`);
  const periods = stringList(params.periods).map(describePeriod).filter((entry): entry is string => Boolean(entry));
  if (periods.length > 0) details.push(periods.join(" and "));
  const action = params.action === "catalog" ? "read the list of product types" : "read Sales";
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";
  if (event.channel === "settings_test") {
    const what = params.action === "catalog" ? "Product type lookup" : "Trial calculation of Sales";
    return `${what}${detailText} from settings${outcome}, ${when}`;
  }
  const who = event.agentName ?? (event.agentId ? "An employee who no longer exists" : "Someone");
  return `${who} ${action}${detailText}${CHANNEL_TEXT[event.channel] ?? ""}${outcome}, ${when}`;
}

function statusText(connection: DataConnectionSummary): string {
  switch (connection.status) {
    case "active":
      return "On – tested and ready";
    case "disabled":
      return "Switched off";
    case "error":
      return "The test found problems";
    default:
      return "Not tested yet";
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

const KIND_COMING_SOON_TEXT = "Coming soon – saved, not connected yet.";

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
          What kind of key did Shopify give you?
        </label>
        <select
          id={`${idPrefix}-kind`}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          value={kind}
          onChange={(event) => onKindChange(event.target.value as CredentialKind)}
        >
          <option value="client_credentials">Client ID and client secret (app created in Shopify Dev Dashboard)</option>
          <option value="admin_access_token">Access token starting with shpat_ (older app created in the shop's admin)</option>
        </select>
      </div>
      {kind === "admin_access_token" ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`${idPrefix}-token`}>
            Access token
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
              Client ID
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
              Client secret
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
      The app in Shopify must have exactly three permissions:{" "}
      {REQUIRED_SCOPES.map((entry, index) => (
        <span key={entry.scope}>
          {index > 0 ? (index === REQUIRED_SCOPES.length - 1 ? " and " : ", ") : ""}
          {entry.meaning} (<span className="font-mono">{entry.scope}</span>)
        </span>
      ))}
      . No permissions that can change anything, and no customer data.
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
        Press Test to see which shop the key belongs to and what Paperclip is allowed to read.
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
          <PropertyRow label="Shop">
            {observed.shopName ?? "Unknown"}
            {observed.shopDomain ? <span className="text-muted-foreground"> ({observed.shopDomain})</span> : null}
          </PropertyRow>
          <PropertyRow label="Currency">{observed.currencyCode ?? "Unknown"}</PropertyRow>
          <PropertyRow label="Time zone">{observed.ianaTimezone ?? "Unknown"}</PropertyRow>
          <PropertyRow label="Write access">
            {writeScopes.length === 0 ? (
              "No write access – Paperclip can only read"
            ) : (
              <span className="text-destructive">The key can change things in the shop – must be removed in Shopify</span>
            )}
          </PropertyRow>
          <PropertyRow label="Orders">
            {observed.earliestVisibleOrderAt
              ? `Can see orders back to ${formatDate(observed.earliestVisibleOrderAt, observed.ianaTimezone)}`
              : scopes.includes("read_orders")
                ? "Sees no orders in the shop"
                : "Cannot read orders"}
          </PropertyRow>
          {connection.lastCheckAt && (
            <PropertyRow label="Last tested">{formatShortDateTime(connection.lastCheckAt)}</PropertyRow>
          )}
        </div>
      )}

      {missingAllOrders && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm" role="alert">
          Shopify only shows this key orders from the last 60 days, so months further back cannot be calculated.
          Add the permission “read all orders, not only the last 60 days” (
          <span className="font-mono">read_all_orders</span>) to the app in Shopify, and press Test again. Write
          “reporting on earlier months” if Shopify asks why.
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
            Product types in the shop ({coverage.types.length})
          </p>
          {coverage.types.length > 0 ? (
            <ul className="max-h-48 overflow-y-auto rounded-md border text-sm">
              {coverage.types.map((type) => (
                <li key={type.productType} className="flex justify-between gap-3 border-b px-3 py-1 last:border-b-0">
                  <span>{type.productType}</span>
                  <span className="text-xs text-muted-foreground">
                    {type.products} {type.products === 1 ? "product" : "products"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No products have a product type.</p>
          )}
          <p className="text-xs text-muted-foreground">
            {coverage.productsWithoutType === 0
              ? `All ${coverage.productsScanned} products have a product type.`
              : `${coverage.productsWithoutType} of ${coverage.productsScanned} products have no product type. They are counted separately, as “no product type”, in answers.`}
            {coverage.complete ? "" : " The shop has more products than Paperclip counted, so the list is not complete."}
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
      setError(errorMessage(err, "Could not run the trial calculation"));
    },
  });

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="data-trial">
      <p className="text-sm font-medium">Trial calculation</p>
      <p className="text-xs text-muted-foreground">
        Calculate units sold for one or two months exactly as the employees will get them, and compare with Shopify
        Analytics (the report “Net items sold by product type” for the same months) before switching on Sales. Every
        difference should be explainable.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`data-trial-first-${connection.id}`}>
            First month
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
            Second month (can be left empty)
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
          Split by product type
        </label>
        <Button
          size="sm"
          onClick={() => trialMutation.mutate()}
          disabled={!ready || periods.length === 0 || trialMutation.isPending}
        >
          {trialMutation.isPending ? "Calculating…" : "Calculate"}
        </Button>
      </div>
      {!ready && (
        <p className="text-xs text-muted-foreground">
          The trial calculation can be run once the connection has been tested and switched on.
        </p>
      )}
      {trialMutation.isPending && (
        <p className="text-xs text-muted-foreground">Going through the orders in Shopify. This can take up to half a minute.</p>
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
              <p className="text-xs font-medium">Notes on the comparison</p>
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
        title: result.canActivate ? "The test passed. The connection is switched on." : "The test found problems",
        tone: result.canActivate ? "success" : "warn",
      });
    },
    onError: fail("Could not test the connection"),
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
      pushToast({ title: "New key saved. Press Test before it is used.", tone: "success" });
    },
    onError: fail("Could not save the new key"),
  });

  const statusMutation = useMutation({
    mutationFn: (status: "active" | "disabled") => dataConnectionsApi.update(companyId, connection.id, { status }),
    onSuccess: (_data, status) => {
      onError(null);
      invalidate();
      pushToast({ title: status === "active" ? "The connection is switched on" : "The connection is switched off", tone: "success" });
    },
    onError: fail("Could not change the connection"),
  });

  const capMutation = useMutation({
    mutationFn: (value: number) => dataConnectionsApi.update(companyId, connection.id, { dailyLookupCap: value }),
    onSuccess: () => {
      onError(null);
      invalidate();
      pushToast({ title: "The limit is saved", tone: "success" });
    },
    onError: fail("Could not save the limit"),
  });

  const removeMutation = useMutation({
    mutationFn: () => dataConnectionsApi.remove(companyId, connection.id),
    onSuccess: () => {
      setConfirmRemove(false);
      onError(null);
      invalidate();
      pushToast({ title: "The connection is removed and the key deleted", tone: "success" });
    },
    onError: fail("Could not remove the connection"),
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
              {connection.kindLabel} · Key {connection.credentialHint}
            </p>
            <p className="text-xs text-muted-foreground">{KIND_COMING_SOON_TEXT}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {confirmRemove ? (
              <>
                <Button size="sm" variant="destructive" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending}>
                  Yes, remove the connection
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            )}
          </div>
        </div>
        {confirmRemove && (
          <p className="text-xs text-destructive">The stored key will be deleted. You can connect again later.</p>
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
            Key {connection.credentialHint} · {statusText(connection)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending ? "Testing…" : "Test"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              rotateCredential.clear();
              setRotating(!rotating);
            }}
          >
            Replace key
          </Button>
          {connection.status === "disabled" ? (
            <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate("active")} disabled={statusMutation.isPending}>
              Switch on
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate("disabled")} disabled={statusMutation.isPending}>
              Switch off
            </Button>
          )}
          {confirmRemove ? (
            <>
              <Button size="sm" variant="destructive" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending}>
                Yes, remove the connection
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>

      {confirmRemove && (
        <p className="text-xs text-destructive">
          The employees will stop being able to read from this shop, and the stored key will be deleted. The lookup log
          stays. You can connect again later with a new key.
        </p>
      )}

      {rotating && (
        <div className="space-y-2 rounded-md border p-3">
          <CredentialFields idPrefix={`data-rotate-${connection.id}`} {...rotateCredential.fieldProps} />
          <p className="text-xs text-muted-foreground">
            The old key stops working immediately. The connection must be tested again before it is used.
          </p>
          <Button
            size="sm"
            onClick={() => rotateMutation.mutate()}
            disabled={!rotateCredential.filled || rotateMutation.isPending}
          >
            Save new key
          </Button>
        </div>
      )}

      <TestFindings connection={connection} lastTest={lastTest} />

      <TrialCalculation companyId={companyId} connection={connection} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`data-cap-${connection.id}`}>
            Lookups per day
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
          Save limit
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          How many lookups everyone in the company can make per day in total. When the limit is reached, the employees
          answer that it is used up, until midnight.
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
        title: data.source ? "The employees can now read sales figures" : "The employees can no longer read sales figures",
        tone: "success",
      });
    },
    onError: (err) => onError(errorMessage(err, "Could not change what the employees can read")),
  });

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="data-datasets">
      <p className="text-sm font-medium">What the employees in the company can read</p>
      <p className="text-xs text-muted-foreground">
        Applies to all the employees in this company, including those hired later. They can only read, never change
        anything, and never see figures from another company.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Sales"
          checked={current !== null}
          disabled={salesMutation.isPending || (current === null && target === null)}
          onChange={(event) => salesMutation.mutate(event.target.checked ? (target?.id ?? null) : null)}
        />
        <span>
          <span className="font-medium">Sales</span>
          <span className="block text-xs text-muted-foreground">
            {current
              ? `Number of units sold and returned per month and product type, from ${current.target}.`
              : target
                ? `Number of units sold and returned per month and product type, from ${target.target}. Run the trial calculation first.`
                : "Connect and test a shop first."}
          </span>
        </span>
      </label>
      {current === null && usable.length > 1 && (
        <select
          aria-label="Which shop should the sales figures come from?"
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
        <input type="checkbox" aria-label="Inventory" checked={false} disabled readOnly />
        <span>
          <span className="font-medium">Inventory</span>
          <span className="block text-xs">Coming later.</span>
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
      <p className="text-sm font-medium">Recent lookups</p>
      {readsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : reads.length === 0 ? (
        <p className="text-xs text-muted-foreground">No lookups yet.</p>
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
 * "Connect": pick a kind, fill its fields, save. Every secret field is
 * type=password (or a password-styled textarea for a private key), never
 * pre-filled, and emptied the moment a save succeeds. A kind that is not
 * readable yet is saved all the same and shown as "coming soon".
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
  // SFTP
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [remotePath, setRemotePath] = useState("");
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
      case "sftp_file": {
        if (!host.trim() || !username.trim() || !remotePath.trim() || !Number.isInteger(portValue)) return null;
        if (sftpCredentialKind === "password" && !password) return null;
        if (sftpCredentialKind === "private_key" && !privateKey.trim()) return null;
        return {
          kind,
          name: displayName,
          host: host.trim(),
          port: portValue,
          username: username.trim(),
          remotePath: remotePath.trim(),
          credential:
            sftpCredentialKind === "password"
              ? { kind: "password", password }
              : { kind: "private_key", privateKey: privateKey.trim(), ...(passphrase ? { passphrase } : {}) },
        };
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
          ? "The shop is connected. Press Test to check it."
          : `${DATA_CONNECTION_KIND_LABELS[data.kind]} is saved. ${KIND_COMING_SOON_TEXT}`,
        tone: "success",
      });
      onSaved();
    },
    onError: (err) => onError(errorMessage(err, "Could not connect the data source")),
  });

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="data-new-connection">
      <p className="text-sm font-medium">Connect {DATA_CONNECTION_KIND_LABELS[kind]}</p>
      <Field id="data-source-kind" label="What kind of data source?">
        <select
          id="data-source-kind"
          className={SELECT_CLASS}
          value={kind}
          onChange={(event) => {
            clearSecrets();
            setKind(event.target.value as DataConnectionKind);
          }}
        >
          {DATA_CONNECTION_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_CONNECTION_KIND_LABELS[entry]}
              {kindSupported(entry) ? "" : " (coming soon)"}
            </option>
          ))}
        </select>
      </Field>
      {!kindSupported(kind) && (
        <p className="text-xs text-muted-foreground" data-testid="data-kind-coming-soon">
          {DATA_CONNECTION_KIND_LABELS[kind]} can be saved now, but Paperclip cannot read from it yet. The key is stored
          locked to this connection and will be used once support is ready.
        </p>
      )}

      {kind === "shopify" && (
        <>
          <Field
            id="data-shop-domain"
            label="The shop's Shopify address"
            help="The address ending in .myshopify.com. You find it in Shopify under Settings → Domains."
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
          <Field id="data-store-url" label="The store's address" help="The store's public https address.">
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
            Create the key in WooCommerce under Settings → Advanced → REST API, with “Read” access, not “Read/Write”.
          </p>
        </>
      )}

      {kind === "fiken" && (
        <>
          <Field
            id="data-fiken-slug"
            label="The company's Fiken slug"
            help="You find it in the address when you are inside the company in Fiken, for example fiken-demo-firma-as."
          >
            <Input
              id="data-fiken-slug"
              value={companySlug}
              onChange={(event) => setCompanySlug(event.target.value)}
              placeholder="fiken-demo-firma-as"
              autoComplete="off"
            />
          </Field>
          <Field id="data-new-api-token" label="API key from Fiken">
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

      {kind === "sftp_file" && (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[12rem] flex-1">
              <Field id="data-sftp-host" label="Server">
                <Input
                  id="data-sftp-host"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="filer.butikken.no"
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
              <Field id="data-sftp-path" label="Folder with files" help="Full path on the server. Paperclip will only read there, never write.">
                <Input
                  id="data-sftp-path"
                  value={remotePath}
                  onChange={(event) => setRemotePath(event.target.value)}
                  placeholder="/rapporter"
                  autoComplete="off"
                />
              </Field>
            </div>
          </div>
          <Field id="data-new-sftp-credential-kind" label="How does Paperclip log in?">
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
          {sftpCredentialKind === "password" ? (
            <Field id="data-new-sftp-password" label="Password">
              <Input
                id="data-new-sftp-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          ) : (
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
          )}
        </>
      )}

      <Field id="data-connection-name" label="Name (optional)" help={`Shown in the list. Empty means “${DATA_CONNECTION_KIND_LABELS[kind]}”.`}>
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
        The key is stored as a locked password that only this connection can use, and is never shown again. You can
        replace it at any time.
      </p>
      <Button onClick={() => request && createMutation.mutate(request)} disabled={!request || createMutation.isPending}>
        {createMutation.isPending ? "Connecting…" : kindSupported(kind) ? "Connect" : "Save"}
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
      <CardTitle>Data sources</CardTitle>
      <CardDescription>
        Here you connect the company to its own sales figures, so the employees can answer questions like “how many
        sofas did we sell in August versus July?”. Paperclip keeps the key and does every lookup itself: the employees
        never see the key, can only read and never change anything, and only get figures from this company. Every
        lookup is logged below.
      </CardDescription>
    </CardHeader>
  );

  if (connectionsQuery.error) {
    const err = connectionsQuery.error;
    const message =
      err instanceof ApiError && err.status === 403
        ? "Only the company's owner or an administrator for the whole Paperclip instance can view and change data sources."
        : errorMessage(err, "Could not fetch the data sources.");
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
          <p className="text-sm text-muted-foreground">Loading…</p>
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
                Add data source
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
