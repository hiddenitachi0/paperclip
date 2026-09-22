import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * DUR-3972 slice S1 / DUR-3997 slice 3: a company's connection to an outside
 * business-data source, made by a board user in company settings.
 *
 * Kinds: 'shopify' (readable today), 'woocommerce', 'fiken' and 'sftp_file'
 * (accepted and stored; their adapters come later). Shopify keeps its own
 * columns from S1 (shop_domain, api_version); every other kind stores its
 * non-secret settings in `config` and leaves those two columns null. The
 * check constraints below tie the shape to the kind, so a Shopify row without
 * a *.myshopify.com address, or a Fiken row with a Shopify credential kind,
 * cannot be stored by any code path.
 *
 * The credential is NOT stored here. It is an ordinary company secret
 * (encrypted, rotatable, every read in secret_access_events) and this row only
 * points at it through `credential_secret_id`. That makes "no read route can
 * return the key" a property of the schema, the same way telegram_bots does it.
 *
 * `access` can only ever hold 'read'. The check constraint is there so that a
 * write grant cannot be stored by any code path, not only by the routes.
 */
export type DataConnectionObserved = {
  shopName?: string | null;
  shopDomain?: string | null;
  ianaTimezone?: string | null;
  currencyCode?: string | null;
  grantedScopes?: string[];
  earliestVisibleOrderAt?: string | null;
  productTypeCoverage?: {
    complete: boolean;
    productsScanned: number;
    productsWithoutType: number;
    types: Array<{ productType: string; products: number }>;
  } | null;
  checkedAt?: string | null;
};

export const DATA_CONNECTION_KIND_VALUES = ["shopify", "woocommerce", "fiken", "sftp_file"] as const;
export const DATA_CONNECTION_CREDENTIAL_KIND_VALUES = [
  "admin_access_token",
  "client_credentials",
  "consumer_key_secret",
  "api_token",
  "password",
  "private_key",
] as const;
export const DATA_DATASET_VALUES = ["sales", "finance", "custom"] as const;

export const dataConnections = pgTable(
  "data_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** Shopify only (NOT NULL for kind='shopify' by check constraint); null otherwise. */
    shopDomain: text("shop_domain"),
    /** Shopify only; null otherwise. */
    apiVersion: text("api_version"),
    credentialKind: text("credential_kind").notNull(),
    credentialSecretId: uuid("credential_secret_id").notNull().references(() => companySecrets.id),
    credentialHint: text("credential_hint").notNull().default(""),
    access: text("access").notNull().default("read"),
    status: text("status").notNull().default("draft"),
    dailyLookupCap: integer("daily_lookup_cap").notNull().default(300),
    /** Per-kind non-secret settings (store URL, company slug, host/path). Never a credential. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    observed: jsonb("observed").$type<DataConnectionObserved>(),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckError: text("last_check_error"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("data_connections_company_idx").on(table.companyId),
    credentialSecretUq: uniqueIndex("data_connections_credential_secret_uq").on(table.credentialSecretId),
    // Target of the composite foreign key on data_dataset_sources, so a grant
    // can only ever point at a connection of its own company.
    idCompanyUq: unique("data_connections_id_company_uq").on(table.id, table.companyId),
    kindCheck: check(
      "data_connections_kind_check",
      sql`${table.kind} IN ('shopify', 'woocommerce', 'fiken', 'sftp_file')`,
    ),
    // A Shopify row must carry a *.myshopify.com address and an API version
    // (the S1 rule, unchanged for Shopify); other kinds keep their settings in
    // `config` and leave both columns null.
    shopDomainCheck: check(
      "data_connections_shop_domain_check",
      sql`${table.kind} <> 'shopify' OR (${table.shopDomain} IS NOT NULL AND ${table.apiVersion} IS NOT NULL AND ${table.shopDomain} ~ '^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$')`,
    ),
    // The credential kind must belong to the source kind.
    credentialKindCheck: check(
      "data_connections_credential_kind_check",
      sql`(${table.kind} = 'shopify' AND ${table.credentialKind} IN ('admin_access_token', 'client_credentials')) OR (${table.kind} = 'woocommerce' AND ${table.credentialKind} = 'consumer_key_secret') OR (${table.kind} = 'fiken' AND ${table.credentialKind} = 'api_token') OR (${table.kind} = 'sftp_file' AND ${table.credentialKind} IN ('password', 'private_key'))`,
    ),
    accessCheck: check("data_connections_access_check", sql`${table.access} = 'read'`),
    statusCheck: check(
      "data_connections_status_check",
      sql`${table.status} IN ('draft', 'active', 'error', 'disabled')`,
    ),
    dailyCapCheck: check(
      "data_connections_daily_lookup_cap_check",
      sql`${table.dailyLookupCap} BETWEEN 1 AND 100000`,
    ),
  }),
);

/**
 * Which connection answers which dataset for a company. The primary key
 * (company_id, dataset) is what makes "never more than one source for the same
 * dataset" a database rule, and the composite foreign key
 * (connection_id, company_id) -> data_connections(id, company_id) is what
 * makes "a company can never point at another company's connection" one.
 *
 * DUR-3997 slice 3 widened `dataset` to ('sales', 'finance', 'custom') but
 * deliberately left the primary key alone: whether one dataset may have two
 * sources (say, two shops feeding "sales") is a later decision, and relaxing
 * the key before it is made would silently allow it.
 */
export const dataDatasetSources = pgTable(
  "data_dataset_sources",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    dataset: text("dataset").notNull(),
    connectionId: uuid("connection_id").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.dataset], name: "data_dataset_sources_pk" }),
    connectionIdx: index("data_dataset_sources_connection_idx").on(table.connectionId),
    connectionCompanyFk: foreignKey({
      name: "data_dataset_sources_connection_company_fk",
      columns: [table.connectionId, table.companyId],
      foreignColumns: [dataConnections.id, dataConnections.companyId],
    }).onDelete("cascade"),
    datasetCheck: check(
      "data_dataset_sources_dataset_check",
      sql`${table.dataset} IN ('sales', 'finance', 'custom')`,
    ),
  }),
);
