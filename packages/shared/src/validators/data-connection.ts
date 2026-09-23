import { z } from "zod";

/**
 * DUR-3972 slice S1 / DUR-3997 slice 3: connecting a company to an outside
 * business-data source.
 *
 * Four kinds are accepted and stored: Shopify (the only one Paperclip can
 * read through today), WooCommerce, Fiken and files on an SFTP server. The
 * last three are "saved, not yet connected" until their adapters ship. Read is
 * the only access level there is -- there is deliberately no way to express
 * "write" in any input below, and the database refuses it too
 * (data_connections_access_check).
 *
 * The create input is a discriminated union on `kind`. The Shopify shape is
 * exactly what slice S1 shipped, so the live Shopify setup keeps working
 * unchanged.
 */

export const DATA_CONNECTION_KINDS = ["shopify", "woocommerce", "fiken", "sftp_file"] as const;
export type DataConnectionKind = (typeof DATA_CONNECTION_KINDS)[number];

/** Plain names for the settings screen. */
export const DATA_CONNECTION_KIND_LABELS: Record<DataConnectionKind, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  fiken: "Fiken",
  sftp_file: "Files (SFTP)",
};

/**
 * Kinds Paperclip can actually read through today. The other kinds are
 * accepted by validation and stored (with their credential locked to the
 * connection), and answer "coming soon" everywhere a read would happen. The
 * server-side registry is the source of truth for behaviour; this list is
 * what the settings screen shows before anything is saved, and a test keeps
 * the two in step.
 */
export const SUPPORTED_DATA_CONNECTION_KINDS: readonly DataConnectionKind[] = ["shopify"];

export const DATA_CONNECTION_ACCESS_LEVELS = ["read"] as const;
export type DataConnectionAccessLevel = (typeof DATA_CONNECTION_ACCESS_LEVELS)[number];

/**
 * Every credential shape any kind can hold. A credential kind belongs to
 * exactly one source kind (see DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND), and
 * the database refuses a pair that does not belong together
 * (data_connections_credential_kind_check).
 */
export const DATA_CONNECTION_CREDENTIAL_KINDS = [
  "admin_access_token",
  "client_credentials",
  "consumer_key_secret",
  "api_token",
  "password",
  "private_key",
] as const;
export type DataConnectionCredentialKind = (typeof DATA_CONNECTION_CREDENTIAL_KINDS)[number];

export const DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND: Record<DataConnectionKind, readonly DataConnectionCredentialKind[]> = {
  shopify: ["admin_access_token", "client_credentials"],
  woocommerce: ["consumer_key_secret"],
  fiken: ["api_token"],
  sftp_file: ["password", "private_key"],
};

export const DATA_CONNECTION_STATUSES = ["draft", "active", "error", "disabled"] as const;
export type DataConnectionStatus = (typeof DATA_CONNECTION_STATUSES)[number];

/**
 * Datasets a company can point at a connection. Only "sales" is answered
 * today; "finance" (Fiken) and "custom" (files) are accepted by the database
 * so those kinds can be granted when their adapters ship.
 */
export const DATA_DATASETS = ["sales", "finance", "custom"] as const;
export type DataDataset = (typeof DATA_DATASETS)[number];

export const DATA_READ_CHANNELS = ["quick_chat", "telegram", "settings_test"] as const;
export type DataReadChannel = (typeof DATA_READ_CHANNELS)[number];

export const DATA_READ_OUTCOMES = [
  "ok",
  "no_data",
  "ambiguous",
  "refused",
  "rate_limited",
  "upstream_error",
] as const;
export type DataReadOutcome = (typeof DATA_READ_OUTCOMES)[number];

export const DEFAULT_DATA_CONNECTION_DAILY_LOOKUP_CAP = 300;

/** The Shopify Admin API version every connection is pinned to. */
export const SHOPIFY_API_VERSION = "2026-07";

/** Same pattern as the data_connections_shop_domain_check constraint. */
export const SHOPIFY_SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The one host a Fiken connection may ever reach. */
export const FIKEN_API_HOST = "api.fiken.no";

/**
 * Turn what an operator pastes into the bare shop address: people paste the
 * admin URL, the address with https:// in front, or just the shop handle.
 * Anything that is not a *.myshopify.com name after that is left as-is, so the
 * pattern check below refuses it with a plain sentence.
 */
export function normalizeShopDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/\.$/, "");
  if (value && !value.includes(".") && /^[a-z0-9][a-z0-9-]*$/.test(value)) {
    value = `${value}.myshopify.com`;
  }
  return value;
}

const shopDomainSchema = z
  .string()
  .max(255)
  .transform(normalizeShopDomainInput)
  .refine((value) => SHOPIFY_SHOP_DOMAIN_PATTERN.test(value), {
    message:
      "Use the shop's myshopify address, for example nordstrand.myshopify.com. You find it in Shopify under Settings → Domains.",
  });

/**
 * A public https address for a WooCommerce store, reduced to its origin. The
 * server's outbound guard re-checks all of this and, at request time, that
 * the host resolves to a public address only.
 *
 * Refused here already: plain http, a port other than 443, a user name or
 * password in the address, an IP address instead of a name, and names that
 * only mean something inside a network (localhost, one-word names, .local,
 * .internal, .lan, .home, .arpa).
 */
export const WOOCOMMERCE_STORE_URL_MESSAGE =
  "Use the store's public https address, for example https://butikken.no. Not http, not an IP address, and not an address that only works on an internal network.";

const NON_PUBLIC_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".arpa", ".test", ".example", ".invalid"];

export function normalizeStoreUrlInput(raw: string): { ok: true; origin: string; host: string } | { ok: false; message: string } {
  let value = raw.trim();
  if (value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: WOOCOMMERCE_STORE_URL_MESSAGE };
  }
  if (parsed.protocol !== "https:") return { ok: false, message: WOOCOMMERCE_STORE_URL_MESSAGE };
  if (parsed.username || parsed.password) return { ok: false, message: WOOCOMMERCE_STORE_URL_MESSAGE };
  if (parsed.port && parsed.port !== "443") return { ok: false, message: WOOCOMMERCE_STORE_URL_MESSAGE };
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicLookingHostName(host)) return { ok: false, message: WOOCOMMERCE_STORE_URL_MESSAGE };
  return { ok: true, origin: `https://${host}`, host };
}

/** A DNS name with at least two labels that is not an IP literal and not a name reserved for private use. */
export function isPublicLookingHostName(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || /^[0-9.]+$/.test(host) || host.includes(":")) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return false;
  if (host === "localhost") return false;
  if (NON_PUBLIC_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return true;
}

const storeUrlSchema = z
  .string()
  .max(255)
  .transform((raw, ctx) => {
    const result = normalizeStoreUrlInput(raw);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
      return z.NEVER;
    }
    return result.origin;
  });

/** Fiken company slugs look like "fiken-demo-firma-as": lower-case letters, digits and dashes. */
export const FIKEN_COMPANY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,120}$/;

const fikenCompanySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => FIKEN_COMPANY_SLUG_PATTERN.test(value), {
    message: "Use the company's Fiken slug, for example fiken-demo-firma-as. You find it in the address when you are inside the company in Fiken.",
  });

const sftpHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => isPublicLookingHostName(value), {
    message: "Use the server's public name, for example filer.butikken.no. Not an IP address, and not a name that only works on an internal network.",
  });

const noWhitespace = (value: string) => !/\s/.test(value);

/** The two shapes a Shopify key comes in. Unchanged from slice S1. */
export const shopifyCredentialSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("admin_access_token"),
    accessToken: z
      .string()
      .trim()
      .min(20, "The access token is too short. It usually starts with shpat_ and is a long string of characters.")
      .max(512)
      .refine(noWhitespace, { message: "The access token must be one continuous string without spaces." }),
  }).strict(),
  z.object({
    kind: z.literal("client_credentials"),
    clientId: z
      .string()
      .trim()
      .min(8, "Paste the client ID from the app in Shopify Dev Dashboard.")
      .max(256)
      .refine(noWhitespace, { message: "The client ID must be one continuous string without spaces." }),
    clientSecret: z
      .string()
      .trim()
      .min(16, "The client secret is too short. Paste the whole value from Shopify Dev Dashboard.")
      .max(512)
      .refine(noWhitespace, { message: "The client secret must be one continuous string without spaces." }),
  }).strict(),
]);
export type ShopifyCredentialInput = z.infer<typeof shopifyCredentialSchema>;

/** WooCommerce REST API keys: a consumer key (ck_…) and consumer secret (cs_…), read-only. */
export const wooCommerceCredentialSchema = z.object({
  kind: z.literal("consumer_key_secret"),
  consumerKey: z
    .string()
    .trim()
    .min(16, "The consumer key is too short. It usually starts with ck_ and is a long string of characters.")
    .max(512)
    .refine(noWhitespace, { message: "The consumer key must be one continuous string without spaces." }),
  consumerSecret: z
    .string()
    .trim()
    .min(16, "The consumer secret is too short. It usually starts with cs_ and is a long string of characters.")
    .max(512)
    .refine(noWhitespace, { message: "The consumer secret must be one continuous string without spaces." }),
}).strict();
export type WooCommerceCredentialInput = z.infer<typeof wooCommerceCredentialSchema>;

/** A Fiken personal API token. */
export const fikenCredentialSchema = z.object({
  kind: z.literal("api_token"),
  apiToken: z
    .string()
    .trim()
    .min(16, "The API key is too short. Paste the whole value from Fiken.")
    .max(512)
    .refine(noWhitespace, { message: "The API key must be one continuous string without spaces." }),
}).strict();
export type FikenCredentialInput = z.infer<typeof fikenCredentialSchema>;

/** SFTP: a password, or a private key (PEM/OpenSSH) with an optional passphrase. */
export const sftpCredentialSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("password"),
    password: z.string().min(1, "Enter the password.").max(1024),
  }).strict(),
  z.object({
    kind: z.literal("private_key"),
    privateKey: z
      .string()
      .trim()
      .min(64, "Paste the whole private key, from -----BEGIN to -----END.")
      .max(16_384)
      .refine((value) => /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value), {
        message: "The private key must start with -----BEGIN … PRIVATE KEY-----.",
      }),
    passphrase: z.string().max(1024).optional(),
  }).strict(),
]);
export type SftpCredentialInput = z.infer<typeof sftpCredentialSchema>;

/**
 * Every credential shape, in one union. Which of them a connection may hold
 * follows from its kind (DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND); the server
 * refuses a mismatch when a key is replaced.
 */
export const dataConnectionCredentialSchema = z.discriminatedUnion("kind", [
  ...shopifyCredentialSchema.options,
  wooCommerceCredentialSchema,
  fikenCredentialSchema,
  ...sftpCredentialSchema.options,
]);
export type DataConnectionCredentialInput = z.infer<typeof dataConnectionCredentialSchema>;

const dailyLookupCapSchema = z.number().int().min(1).max(100_000);
const connectionNameSchema = (fallback: string) =>
  z.string().trim().min(1, "Give the connection a name.").max(80).default(fallback);

/** Exactly slice S1's shape: nothing here may change while the live Shopify setup is in progress. */
export const createShopifyConnectionSchema = z.object({
  kind: z.literal("shopify"),
  name: connectionNameSchema("Shopify"),
  shopDomain: shopDomainSchema,
  credential: shopifyCredentialSchema,
  dailyLookupCap: dailyLookupCapSchema.optional(),
}).strict();

export const createWooCommerceConnectionSchema = z.object({
  kind: z.literal("woocommerce"),
  name: connectionNameSchema("WooCommerce"),
  /** Reduced to the https origin, e.g. "https://butikken.no". */
  storeUrl: storeUrlSchema,
  credential: wooCommerceCredentialSchema,
  dailyLookupCap: dailyLookupCapSchema.optional(),
}).strict();

export const createFikenConnectionSchema = z.object({
  kind: z.literal("fiken"),
  name: connectionNameSchema("Fiken"),
  companySlug: fikenCompanySlugSchema,
  credential: fikenCredentialSchema,
  dailyLookupCap: dailyLookupCapSchema.optional(),
}).strict();

export const createSftpFileConnectionSchema = z.object({
  kind: z.literal("sftp_file"),
  name: connectionNameSchema("Files (SFTP)"),
  host: sftpHostSchema,
  port: z.number().int().min(1).max(65_535).default(22),
  username: z
    .string()
    .trim()
    .min(1, "Enter the user name on the server.")
    .max(128)
    .refine(noWhitespace, { message: "The user name cannot contain spaces." }),
  /** Absolute path on the server to read files from. Never written to. */
  remotePath: z
    .string()
    .trim()
    .min(1, "Enter the folder the files are in, for example /rapporter.")
    .max(512)
    .refine((value) => value.startsWith("/"), { message: "The folder must be a full path starting with /, for example /rapporter." })
    .refine((value) => !value.split("/").includes(".."), { message: 'The folder cannot contain "..".' }),
  credential: sftpCredentialSchema,
  dailyLookupCap: dailyLookupCapSchema.optional(),
}).strict();

export const createDataConnectionSchema = z.discriminatedUnion("kind", [
  createShopifyConnectionSchema,
  createWooCommerceConnectionSchema,
  createFikenConnectionSchema,
  createSftpFileConnectionSchema,
]);
export type CreateDataConnectionInput = z.infer<typeof createDataConnectionSchema>;

/**
 * The per-kind, non-secret settings stored in data_connections.config. Shopify
 * keeps its own columns (shop_domain, api_version) from slice S1 and stores
 * nothing here.
 */
export const shopifyConnectionConfigSchema = z.object({}).strip();
export const wooCommerceConnectionConfigSchema = z.object({ storeUrl: storeUrlSchema }).strip();
export const fikenConnectionConfigSchema = z.object({ companySlug: fikenCompanySlugSchema }).strip();
export const sftpFileConnectionConfigSchema = z.object({
  host: sftpHostSchema,
  port: z.number().int().min(1).max(65_535).default(22),
  username: z.string().trim().min(1).max(128),
  remotePath: z.string().trim().min(1).max(512),
}).strip();

export type DataConnectionConfig =
  | ({ kind: "shopify" } & z.infer<typeof shopifyConnectionConfigSchema>)
  | ({ kind: "woocommerce" } & z.infer<typeof wooCommerceConnectionConfigSchema>)
  | ({ kind: "fiken" } & z.infer<typeof fikenConnectionConfigSchema>)
  | ({ kind: "sftp_file" } & z.infer<typeof sftpFileConnectionConfigSchema>);

/**
 * `status` can only be switched between on ("active") and off ("disabled")
 * here. Turning it on is refused by the server unless the last Test passed
 * with a read-only key -- see dataConnectionService.update. A replacement
 * credential must be of a kind the connection's source accepts.
 */
export const updateDataConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  dailyLookupCap: dailyLookupCapSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  credential: dataConnectionCredentialSchema.optional(),
}).strict();
export type UpdateDataConnectionInput = z.infer<typeof updateDataConnectionSchema>;

/** `connectionId: null` removes the dataset's source. */
export const setDatasetSourceSchema = z.object({
  connectionId: z.string().uuid().nullable(),
}).strict();
export type SetDatasetSourceInput = z.infer<typeof setDatasetSourceSchema>;

/**
 * DUR-3972 slice S2: "Trial calculation" in Data sources. The operator picks
 * one or two calendar months (never free dates) and Paperclip counts units
 * sold in them through the connection, exactly as an agent answer would, so
 * the numbers can be compared with Shopify Analytics before "Sales" is ticked.
 */
export const DATA_TRIAL_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const dataTrialCalculationSchema = z.object({
  periods: z
    .array(z.string().regex(DATA_TRIAL_MONTH_PATTERN, "Choose a month, for example 2026-07."))
    .min(1, "Choose at least one month.")
    .max(2, "Choose at most two months."),
  groupBy: z.enum(["none", "product_type"]).default("product_type"),
}).strict();
export type DataTrialCalculationInput = z.input<typeof dataTrialCalculationSchema>;
