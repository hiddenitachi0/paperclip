import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretBindings, dataConnections, dataDatasetSources, dataReadEvents } from "@paperclipai/db";
import {
  DEFAULT_DATA_CONNECTION_DAILY_LOOKUP_CAP,
  type CreateDataConnectionInput,
  type DataConnectionCheckResult,
  type DataConnectionConfig,
  type DataConnectionCredentialInput,
  type DataConnectionObservedSummary,
  type DataConnectionStatus,
  type DataConnectionSummary,
  type DataDataset,
  type DataDatasetSourceSummary,
  type DataReadChannel,
  type DataReadEventSummary,
  type DataReadOutcome,
  type UpdateDataConnectionInput,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import { instanceSettingsService } from "./instance-settings.js";
import type { OutboundFetch } from "./safe-outbound-fetch.js";
import {
  DEFAULT_LOOKUP_BUDGET,
  type DataSourceCallBudget,
  type DataSourceConnectionInfo,
  type DataSourceCredential,
  type DataSourceReadContext,
} from "./data-sources/connection-kind.js";
import { credentialHint, credentialSecretValues, decodeCredential, encodeCredential } from "./data-sources/credential-codec.js";
import { getDataSourceKind, type DataSourceKindDefinition, type OpenReadContextInput } from "./data-sources/registry.js";
import { scrubSecrets } from "./data-sources/shopify-client.js";
import { tryRecordDataReadEvent } from "./data-read-audit.js";

/**
 * DUR-3972 slice S1 / DUR-3997 slice 3: business-data connections, modelled
 * on telegram-bots.ts.
 *
 * The one rule this file exists to enforce: the source's key is a credential.
 * It lives in the company secret store, is bound to the connection (and, by
 * the dedicated-credential rule in secrets.ts, to nothing else), and is read
 * back in exactly one place -- `resolveCredential` -- which is only ever
 * called by code in this process that makes the outbound call itself. No
 * function here returns the key to a caller outside this file's own call
 * chain, and `toSummary` -- the shape every route answers with -- has no field
 * it could travel in.
 *
 * Nothing in this file is about one kind of source. Everything that depends
 * on the kind (the transport, the Test, which datasets it can answer, which
 * credential kinds it takes) is asked of the registry entry for `row.kind`.
 *
 * Every query filters on the company the caller is acting for; a connection id
 * from another company is simply "not found".
 */

// One credential per connection, always at this configPath. A constant rather
// than a caller-supplied string, same reasoning as TELEGRAM_BOT_TOKEN_CONFIG_PATH.
export const DATA_CONNECTION_CREDENTIAL_CONFIG_PATH = "credential";

type DataConnectionRow = typeof dataConnections.$inferSelect;

export type DataConnectionActor = { userId: string | null };

export type DataConnectionAccessContext = {
  actorType: "system" | "user" | "agent";
  actorId: string;
};

/** The last four characters, and nothing else. Kept exported for the tests that used it. */
export function dataConnectionCredentialHint(credential: DataConnectionCredentialInput): string {
  return credentialHint(credential);
}

/**
 * The secret's name in the Secrets screen: the kind, the connection's own
 * name and the first eight characters of the connection id. Two connections
 * of one kind with the same name in one company therefore never collide on
 * UNIQUE(company_id, name) or UNIQUE(company_id, key), and an operator can
 * still tell which is which.
 */
export function dataConnectionSecretName(definition: DataSourceKindDefinition, connectionName: string, connectionId: string): string {
  const name = connectionName.trim().slice(0, 60) || definition.label;
  return `${definition.label}-nøkkel: ${name} (${connectionId.replace(/-/g, "").slice(0, 8)})`;
}

function normalizeObserved(raw: DataConnectionRow["observed"]): DataConnectionObservedSummary | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    shopName: raw.shopName ?? null,
    shopDomain: raw.shopDomain ?? null,
    ianaTimezone: raw.ianaTimezone ?? null,
    currencyCode: raw.currencyCode ?? null,
    grantedScopes: Array.isArray(raw.grantedScopes) ? raw.grantedScopes : [],
    earliestVisibleOrderAt: raw.earliestVisibleOrderAt ?? null,
    productTypeCoverage: raw.productTypeCoverage ?? null,
    checkedAt: raw.checkedAt ?? null,
  };
}

/** The row's `config` as the kind's typed shape; an unreadable config is treated as empty, never thrown at a reader. */
function typedConfig(definition: DataSourceKindDefinition, raw: DataConnectionRow["config"]): DataConnectionConfig {
  const parsed = definition.configSchema.safeParse(raw ?? {});
  const config = parsed.success ? (parsed.data as Record<string, unknown>) : {};
  return { kind: definition.kind, ...config } as DataConnectionConfig;
}

function connectionInfo(row: DataConnectionRow, definition: DataSourceKindDefinition): DataSourceConnectionInfo {
  const observed = normalizeObserved(row.observed);
  return {
    id: row.id,
    companyId: row.companyId,
    kind: definition.kind,
    name: row.name,
    shopDomain: row.shopDomain,
    apiVersion: row.apiVersion,
    config: typedConfig(definition, row.config),
    ianaTimezone: observed?.ianaTimezone ?? null,
    currencyCode: observed?.currencyCode ?? null,
    earliestVisibleOrderAt: observed?.earliestVisibleOrderAt ?? null,
  };
}

function toSummary(row: DataConnectionRow, datasets: DataDataset[]): DataConnectionSummary {
  const definition = getDataSourceKind(row.kind);
  const config = typedConfig(definition, row.config);
  return {
    id: row.id,
    companyId: row.companyId,
    kind: definition.kind,
    kindLabel: definition.label,
    supported: definition.supported,
    name: row.name,
    target: definition.describeTarget({ shopDomain: row.shopDomain, config }),
    shopDomain: row.shopDomain,
    apiVersion: row.apiVersion,
    config,
    credentialKind: row.credentialKind as DataConnectionSummary["credentialKind"],
    credentialHint: row.credentialHint,
    access: "read",
    status: row.status as DataConnectionStatus,
    dailyLookupCap: row.dailyLookupCap,
    observed: normalizeObserved(row.observed),
    datasets,
    datasetsOffered: [...definition.datasets],
    lastCheckAt: row.lastCheckAt ? row.lastCheckAt.toISOString() : null,
    lastCheckOk: row.lastCheckOk,
    lastCheckError: row.lastCheckError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DataConnectionServiceDeps {
  /** Replaces the guarded fetch; tests only. */
  fetchImpl?: OutboundFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Product pages the Shopify Test reads at most (250 products each). */
  maxProductPages?: number;
}

export function dataConnectionService(db: Db, deps: DataConnectionServiceDeps = {}) {
  const secrets = secretService(db);
  const instanceSettings = instanceSettingsService(db);
  const now = deps.now ?? Date.now;

  /**
   * The instance switch "Business data sources". Off means no connection can
   * be USED, not only that the settings screen is hidden: every read path in
   * this file checks it itself, so a caller (S4, quick agents, Telegram)
   * cannot read through a connection while an operator has it switched off.
   */
  async function businessDataEnabled(): Promise<boolean> {
    const experimental = await instanceSettings.getExperimental();
    return experimental.enableBusinessData === true;
  }

  async function datasetsByConnection(companyId: string): Promise<Map<string, DataDataset[]>> {
    const rows = await db
      .select()
      .from(dataDatasetSources)
      .where(eq(dataDatasetSources.companyId, companyId));
    const map = new Map<string, DataDataset[]>();
    for (const row of rows) {
      const list = map.get(row.connectionId) ?? [];
      list.push(row.dataset as DataDataset);
      map.set(row.connectionId, list);
    }
    return map;
  }

  async function getRow(companyId: string, connectionId: string): Promise<DataConnectionRow> {
    const [row] = await db
      .select()
      .from(dataConnections)
      .where(and(eq(dataConnections.id, connectionId), eq(dataConnections.companyId, companyId)));
    if (!row) throw notFound("Fant ikke denne datakoblingen.");
    return row;
  }

  async function list(companyId: string): Promise<DataConnectionSummary[]> {
    const [rows, datasets] = await Promise.all([
      db.select().from(dataConnections).where(eq(dataConnections.companyId, companyId)),
      datasetsByConnection(companyId),
    ]);
    return rows
      .map((row) => toSummary(row, datasets.get(row.id) ?? []))
      .sort((a, b) => a.name.localeCompare(b.name, "nb") || a.createdAt.localeCompare(b.createdAt));
  }

  async function get(companyId: string, connectionId: string): Promise<DataConnectionSummary> {
    const row = await getRow(companyId, connectionId);
    const datasets = await datasetsByConnection(companyId);
    return toSummary(row, datasets.get(row.id) ?? []);
  }

  /**
   * A secret name the operator will recognise in the Secrets screen, unique
   * per connection (see dataConnectionSecretName). Created with agentId null
   * on purpose: an operator-made secret can never qualify for DUR-3980's "an
   * agent may re-attach a secret it minted itself" exemption.
   */
  async function createCredentialSecret(
    companyId: string,
    definition: DataSourceKindDefinition,
    connection: { id: string; name: string },
    credential: DataConnectionCredentialInput,
    actor: DataConnectionActor,
  ) {
    const base = dataConnectionSecretName(definition, connection.name, connection.id);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const name = attempt === 0 ? base : `${base} (${attempt + 1})`;
      const existing = await secrets.getByName(companyId, name);
      if (existing) continue;
      return secrets.create(
        companyId,
        {
          name,
          provider: "local_encrypted",
          value: encodeCredential(credential),
          description: `Lesenøkkel for ${definition.label}. Brukes bare av datakoblingen, og kan ikke kobles til en agent eller noe annet.`,
        },
        { userId: actor.userId, agentId: null },
      );
    }
    throw conflict("Kunne ikke gi det lagrede passordet for denne koblingen et navn.");
  }

  async function create(
    companyId: string,
    input: CreateDataConnectionInput,
    actor: DataConnectionActor,
  ): Promise<DataConnectionSummary> {
    const definition = getDataSourceKind(input.kind);
    if (!definition.credentialKinds.includes(input.credential.kind)) {
      throw unprocessable(`En ${definition.label}-kobling kan ikke bruke denne typen nøkkel.`, {
        code: "credential_kind_mismatch",
      });
    }
    const stored = definition.storedShape(input);
    // The id is chosen here so the secret can carry it in its name before the
    // row exists; the row is inserted with this exact id.
    const connectionId = randomUUID();
    const secret = await createCredentialSecret(companyId, definition, { id: connectionId, name: input.name }, input.credential, actor);
    let row: DataConnectionRow;
    try {
      [row] = await db
        .insert(dataConnections)
        .values({
          id: connectionId,
          companyId,
          kind: input.kind,
          name: input.name,
          shopDomain: stored.shopDomain,
          apiVersion: stored.apiVersion,
          config: stored.config,
          credentialKind: input.credential.kind,
          credentialSecretId: secret.id,
          credentialHint: credentialHint(input.credential),
          access: "read",
          status: "draft",
          dailyLookupCap: input.dailyLookupCap ?? DEFAULT_DATA_CONNECTION_DAILY_LOOKUP_CAP,
          createdByUserId: actor.userId,
        })
        .returning();
    } catch (error) {
      // Never leave an orphan credential behind.
      await secrets.remove(secret.id).catch(() => undefined);
      throw error;
    }
    try {
      await secrets.syncSecretRefsForTarget(
        companyId,
        { targetType: "data_connection", targetId: row!.id },
        [{ secretId: secret.id, configPath: DATA_CONNECTION_CREDENTIAL_CONFIG_PATH, label: `Datakilde: ${input.name}` }],
        { replaceAll: true },
      );
    } catch (error) {
      await db.delete(dataConnections).where(eq(dataConnections.id, row!.id)).catch(() => undefined);
      await secrets.remove(secret.id).catch(() => undefined);
      throw error;
    }
    return toSummary(row!, []);
  }

  async function update(
    companyId: string,
    connectionId: string,
    patch: UpdateDataConnectionInput,
    actor: DataConnectionActor,
  ): Promise<DataConnectionSummary> {
    const row = await getRow(companyId, connectionId);
    const definition = getDataSourceKind(row.kind);
    const set: Partial<typeof dataConnections.$inferInsert> = { updatedAt: new Date(now()) };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.dailyLookupCap !== undefined) set.dailyLookupCap = patch.dailyLookupCap;

    // A replacement key must be of a kind this source takes. Decided before
    // anything is written.
    if (patch.credential && !definition.credentialKinds.includes(patch.credential.kind)) {
      throw unprocessable(`En ${definition.label}-kobling kan ikke bruke denne typen nøkkel.`, {
        code: "credential_kind_mismatch",
      });
    }

    // Every refusal is decided BEFORE anything is written. A new key has never
    // been tested, so "new key and switch on" in one step is always refused --
    // and refused before the key is stored, so a refusal changes nothing.
    if (patch.status === "active") {
      const lastCheckOk = patch.credential ? null : row.lastCheckOk;
      const verdict = definition.canActivate(normalizeObserved(patch.credential ? null : row.observed));
      if (lastCheckOk !== true || !verdict.ok) {
        throw unprocessable(
          patch.credential
            ? "En ny nøkkel må testes før koblingen kan slås på. Lagre nøkkelen, trykk Test, og slå den på etterpå."
            : "Koblingen kan ikke slås på før Test har gått gjennom med en nøkkel som bare kan lese. Trykk Test først.",
          { code: "data_connection_not_verified", problems: verdict.problems },
        );
      }
      set.status = "active";
    }
    if (patch.status === "disabled") set.status = "disabled";

    if (!patch.credential) {
      const [updated] = await db
        .update(dataConnections)
        .set(set)
        .where(and(eq(dataConnections.id, row.id), eq(dataConnections.companyId, companyId)))
        .returning();
      const datasets = await datasetsByConnection(companyId);
      return toSummary(updated ?? row, datasets.get(row.id) ?? []);
    }

    // A new key. The row is switched to "not tested" FIRST and the key stored
    // second, so there is no moment -- and no failure halfway -- where an
    // active connection serves a key that was never tested. The last Test said
    // something about a key that no longer exists; it is forgotten.
    set.credentialKind = patch.credential.kind;
    set.credentialHint = credentialHint(patch.credential);
    set.lastCheckAt = null;
    set.lastCheckOk = null;
    set.lastCheckError = null;
    set.observed = null;
    set.status = patch.status === "disabled" || row.status === "disabled" ? "disabled" : "draft";
    const [updated] = await db
      .update(dataConnections)
      .set(set)
      .where(and(eq(dataConnections.id, row.id), eq(dataConnections.companyId, companyId)))
      .returning();
    definition.forgetCachedTokens?.(row.id);
    try {
      await secrets.rotate(
        row.credentialSecretId,
        { value: encodeCredential(patch.credential) },
        { userId: actor.userId, agentId: null },
      );
    } catch (error) {
      // The old key is still the stored one: put back what describes it, but
      // stay "not tested" -- never back to active without a Test.
      await db
        .update(dataConnections)
        .set({ credentialKind: row.credentialKind, credentialHint: row.credentialHint, updatedAt: new Date(now()) })
        .where(and(eq(dataConnections.id, row.id), eq(dataConnections.companyId, companyId)))
        .catch(() => undefined);
      throw error;
    }
    const datasets = await datasetsByConnection(companyId);
    return toSummary(updated ?? row, datasets.get(row.id) ?? []);
  }

  async function remove(companyId: string, connectionId: string): Promise<{ removedSecretId: string }> {
    const row = await getRow(companyId, connectionId);
    const definition = getDataSourceKind(row.kind);
    // Order matters, as for Telegram bots: the connection row (and with it any
    // dataset grant, by cascade) goes first so nothing can resolve the key
    // through a binding while it is being deleted, then the binding, then the
    // secret itself. Audit rows stay; their connection_id becomes null.
    await db
      .delete(dataConnections)
      .where(and(eq(dataConnections.id, row.id), eq(dataConnections.companyId, companyId)));
    definition.forgetCachedTokens?.(row.id);
    await secrets
      .syncSecretRefsForTarget(companyId, { targetType: "data_connection", targetId: row.id }, [], { replaceAll: true })
      .catch(() => undefined);
    await secrets.remove(row.credentialSecretId);
    return { removedSecretId: row.credentialSecretId };
  }

  /**
   * The ONLY path from a connection back to its key.
   *
   * Goes through the real company_secret_bindings row, so the read is
   * authorised like every other credential read in Paperclip and lands in
   * secret_access_events. Never returned to a route; only handed to the
   * kind's own transport in this process.
   */
  async function resolveCredential(
    companyId: string,
    connectionId: string,
    context: DataConnectionAccessContext,
  ): Promise<DataSourceCredential> {
    const row = await getRow(companyId, connectionId);
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "data_connection"),
          eq(companySecretBindings.targetId, row.id),
          eq(companySecretBindings.configPath, DATA_CONNECTION_CREDENTIAL_CONFIG_PATH),
        ),
      );
    if (!binding || binding.secretId !== row.credentialSecretId) {
      throw unprocessable("Ingen nøkkel er koblet til denne datakoblingen.", { code: "binding_missing" });
    }
    const raw = await secrets.resolveSecretValue(companyId, binding.secretId, "latest", {
      consumerType: "data_connection",
      consumerId: row.id,
      configPath: DATA_CONNECTION_CREDENTIAL_CONFIG_PATH,
      actorType: context.actorType,
      actorId: context.actorId,
    });
    return decodeCredential(row.credentialKind, raw);
  }

  /**
   * What the registry entry needs to open a transport for this row: the
   * connection without its key, a lazy credential loader, and the scrub list
   * this service owns (the loader and any minted token feed it).
   */
  function registryInput(
    row: DataConnectionRow,
    definition: DataSourceKindDefinition,
    context: DataConnectionAccessContext,
    budget: DataSourceCallBudget,
  ): { input: OpenReadContextInput; knownSecrets: () => string[] } {
    let credential: Promise<DataSourceCredential> | null = null;
    const secretValues: string[] = [];
    const registerSecret = (value: string) => {
      if (value && !secretValues.includes(value)) secretValues.push(value);
    };
    const loadCredential = () => {
      credential ??= resolveCredential(row.companyId, row.id, context).then((value) => {
        for (const entry of credentialSecretValues(value)) registerSecret(entry);
        return value;
      });
      return credential;
    };
    const knownSecrets = () => [...secretValues];
    return {
      input: {
        connection: connectionInfo(row, definition),
        loadCredential,
        budget,
        knownSecrets,
        registerSecret,
        deps: { fetchImpl: deps.fetchImpl, now, sleep: deps.sleep, maxProductPages: deps.maxProductPages },
      },
      knownSecrets,
    };
  }

  /**
   * For the query service: everything an adapter needs for one lookup through
   * this company's connection, without the key. Refuses a connection that is
   * not active, refuses everything while the instance switch "Business data
   * sources" is off, and refuses a kind that has no transport yet (422, code
   * data_source_kind_unsupported).
   */
  async function openReadContext(
    companyId: string,
    connectionId: string,
    context: DataConnectionAccessContext,
    budget: DataSourceCallBudget = DEFAULT_LOOKUP_BUDGET,
  ): Promise<{ read: DataSourceReadContext; knownSecrets: () => string[] }> {
    if (!(await businessDataEnabled())) {
      throw unprocessable(
        "Datakilder er slått av for denne Paperclip-installasjonen, så ingen data kan leses nå.",
        { code: "business_data_disabled" },
      );
    }
    const row = await getRow(companyId, connectionId);
    if (row.status !== "active") {
      throw unprocessable("Datakoblingen er ikke slått på.", { code: "data_connection_not_active" });
    }
    const definition = getDataSourceKind(row.kind);
    const { input, knownSecrets } = registryInput(row, definition, context, budget);
    return { read: definition.openReadContext(input), knownSecrets };
  }

  /**
   * "Test": ask the source who it is and what the key may do, remember the
   * answer, and switch the connection on only if the key can read everything
   * it needs and write nothing. A kind without a transport answers with a
   * plain "kommer snart" sentence and touches nothing.
   */
  async function test(
    companyId: string,
    connectionId: string,
    actor: { userId: string },
  ): Promise<DataConnectionCheckResult> {
    const row = await getRow(companyId, connectionId);
    const definition = getDataSourceKind(row.kind);
    const startedAt = now();
    if (!definition.supported) {
      const outcome = await definition.check(
        registryInput(row, definition, { actorType: "user", actorId: actor.userId }, DEFAULT_LOOKUP_BUDGET).input,
      );
      return {
        ok: outcome.ok,
        canActivate: false,
        problems: outcome.problems,
        notes: outcome.notes,
        observed: normalizeObserved(row.observed),
        status: row.status as DataConnectionStatus,
        checkedAt: new Date(now()).toISOString(),
      };
    }
    const { input, knownSecrets } = registryInput(row, definition, { actorType: "user", actorId: actor.userId }, DEFAULT_LOOKUP_BUDGET);
    let outcome: Awaited<ReturnType<DataSourceKindDefinition["check"]>>;
    try {
      outcome = await definition.check(input);
    } catch (error) {
      // resolveCredential and anything else unexpected. Logged without the
      // message body, which could in theory echo a value.
      logger.warn(
        { companyId, connectionId, err: error instanceof Error ? error.name : "unknown" },
        "data connection test failed unexpectedly",
      );
      const message =
        error instanceof HttpError && error.status === 422
          ? scrubSecrets(error.message, knownSecrets())
          : "Noe uventet gikk galt under testen. Prøv igjen om litt.";
      outcome = { ok: false, canActivate: false, problems: [message], notes: [], observed: null, stats: { requests: 0, costPoints: 0 } };
    }

    const problems = outcome.problems.map((text) => scrubSecrets(text, knownSecrets()));
    const notes = outcome.notes.map((text) => scrubSecrets(text, knownSecrets()));
    const checkedAt = new Date(now());
    const nextStatus: DataConnectionStatus =
      row.status === "disabled" ? "disabled" : outcome.canActivate ? "active" : "error";
    const [updated] = await db
      .update(dataConnections)
      .set({
        status: nextStatus,
        observed: outcome.observed ?? row.observed ?? null,
        lastCheckAt: checkedAt,
        lastCheckOk: outcome.canActivate,
        lastCheckError: problems.length > 0 ? problems.join("\n").slice(0, 2000) : null,
        updatedAt: checkedAt,
      })
      .where(and(eq(dataConnections.id, row.id), eq(dataConnections.companyId, companyId)))
      .returning();

    const outcomeCode: DataReadOutcome = outcome.canActivate ? "ok" : outcome.ok ? "refused" : "upstream_error";
    await tryRecordDataReadEvent(db, {
      companyId,
      connectionId: row.id,
      dataset: "connection_check",
      channel: "settings_test",
      userId: actor.userId,
      params: { action: "connection_check" },
      outcome: outcomeCode,
      refusalCode: outcome.canActivate ? null : outcome.ok ? "check_failed" : "upstream_unreachable",
      facts: outcome.observed
        ? {
            grantedScopes: outcome.observed.grantedScopes,
            earliestVisibleOrderAt: outcome.observed.earliestVisibleOrderAt,
            productsScanned: outcome.observed.productTypeCoverage?.productsScanned ?? null,
          }
        : null,
      upstreamRequests: outcome.stats.requests,
      costPoints: outcome.stats.costPoints,
      durationMs: now() - startedAt,
      scrubValues: knownSecrets(),
    });

    return {
      ok: outcome.ok,
      canActivate: outcome.canActivate,
      problems,
      notes,
      observed: normalizeObserved(updated?.observed ?? null),
      status: (updated?.status ?? nextStatus) as DataConnectionStatus,
      checkedAt: checkedAt.toISOString(),
    };
  }

  async function listDatasetSources(companyId: string): Promise<DataDatasetSourceSummary[]> {
    const rows = await db.select().from(dataDatasetSources).where(eq(dataDatasetSources.companyId, companyId));
    return rows.map((row) => ({
      dataset: row.dataset as DataDataset,
      connectionId: row.connectionId,
      grantedByUserId: row.grantedByUserId,
      grantedAt: row.grantedAt.toISOString(),
    }));
  }

  /**
   * Point one dataset of this company at one of its connections (or at
   * nothing). The database also refuses a second source for the same dataset
   * and a connection of another company; this adds the plain sentences, and
   * refuses a dataset the connection's kind cannot answer.
   */
  async function setDatasetSource(
    companyId: string,
    dataset: DataDataset,
    connectionId: string | null,
    actor: DataConnectionActor,
  ): Promise<DataDatasetSourceSummary | null> {
    if (connectionId === null) {
      await db
        .delete(dataDatasetSources)
        .where(and(eq(dataDatasetSources.companyId, companyId), eq(dataDatasetSources.dataset, dataset)));
      return null;
    }
    const row = await getRow(companyId, connectionId);
    const definition = getDataSourceKind(row.kind);
    if (!definition.datasets.includes(dataset)) {
      throw unprocessable(`En ${definition.label}-kobling kan ikke svare på dette datasettet.`, {
        code: "dataset_not_offered",
        datasetsOffered: [...definition.datasets],
      });
    }
    if (row.status !== "active") {
      throw unprocessable(
        "Koblingen må være testet og slått på før den kan brukes. Trykk Test først.",
        { code: "data_connection_not_active" },
      );
    }
    const grantedAt = new Date(now());
    const [saved] = await db
      .insert(dataDatasetSources)
      .values({ companyId, dataset, connectionId: row.id, grantedByUserId: actor.userId, grantedAt })
      .onConflictDoUpdate({
        target: [dataDatasetSources.companyId, dataDatasetSources.dataset],
        set: { connectionId: row.id, grantedByUserId: actor.userId, grantedAt },
      })
      .returning();
    return {
      dataset: saved!.dataset as DataDataset,
      connectionId: saved!.connectionId,
      grantedByUserId: saved!.grantedByUserId,
      grantedAt: saved!.grantedAt.toISOString(),
    };
  }

  /**
   * For the query service: the connection that answers `dataset` for this
   * company, if it is switched on. Null means "not connected" -- say so
   * plainly, never guess. Also null while the instance switch "Business data
   * sources" is off.
   */
  async function getActiveDatasetSource(companyId: string, dataset: DataDataset): Promise<DataConnectionRow | null> {
    if (!(await businessDataEnabled())) return null;
    const [grant] = await db
      .select()
      .from(dataDatasetSources)
      .where(and(eq(dataDatasetSources.companyId, companyId), eq(dataDatasetSources.dataset, dataset)));
    if (!grant) return null;
    const [row] = await db
      .select()
      .from(dataConnections)
      .where(and(eq(dataConnections.id, grant.connectionId), eq(dataConnections.companyId, companyId)));
    if (!row || row.status !== "active") return null;
    return row;
  }

  async function listReadEvents(companyId: string, limit = 20): Promise<DataReadEventSummary[]> {
    const rows = await db
      .select()
      .from(dataReadEvents)
      .where(eq(dataReadEvents.companyId, companyId))
      .orderBy(desc(dataReadEvents.createdAt))
      .limit(Math.max(1, Math.min(limit, 100)));
    const agentIds = [...new Set(rows.map((row) => row.agentId).filter((id): id is string => Boolean(id)))];
    const names = agentIds.length
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
      : [];
    const nameById = new Map(names.map((entry) => [entry.id, entry.name]));
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connectionId,
      dataset: row.dataset,
      channel: row.channel as DataReadChannel,
      agentId: row.agentId,
      agentName: row.agentId ? (nameById.get(row.agentId) ?? null) : null,
      userId: row.userId,
      params: row.params ?? {},
      outcome: row.outcome as DataReadOutcome,
      refusalCode: row.refusalCode,
      upstreamRequests: row.upstreamRequests,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  return {
    list,
    get,
    getRow,
    create,
    update,
    remove,
    resolveCredential,
    openReadContext,
    test,
    listDatasetSources,
    setDatasetSource,
    getActiveDatasetSource,
    listReadEvents,
  };
}

export type DataConnectionService = ReturnType<typeof dataConnectionService>;
