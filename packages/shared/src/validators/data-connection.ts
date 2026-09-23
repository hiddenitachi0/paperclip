import { z } from "zod";

/**
 * DUR-3972 slice S1 / DUR-3997 slice 3 + file servers: connecting a company
 * to an outside business-data source.
 *
 * Six kinds are accepted and stored: Shopify, WooCommerce, Fiken, and files on
 * a server over FTP, FTPS or SFTP. Shopify and the three file-server kinds can
 * be read through today; WooCommerce and Fiken are "saved, not yet connected"
 * until their adapters ship.
 *
 * Access: every kind is read-only except the file-server kinds, where a
 * connection may be `read_write` (the company's own server, where agents
 * later push reports) or `read` (a partner's server). Nothing else can express
 * write, and the database refuses any value but these two
 * (data_connections_access_check).
 *
 * The create input is a discriminated union on `kind`. The Shopify shape is
 * exactly what slice S1 shipped, so the live Shopify setup keeps working
 * unchanged.
 */

export const DATA_CONNECTION_KINDS = ["shopify", "woocommerce", "fiken", "ftp_file", "ftps_file", "sftp_file"] as const;
export type DataConnectionKind = (typeof DATA_CONNECTION_KINDS)[number];

/**
 * The three "files on a server" kinds. One kind per protocol, not one kind
 * with a protocol field: the database ties the credential kind to the kind
 * (a private key is SFTP-only), the registry, the outbound rules and the
 * settings dropdown are all keyed by kind, and `sftp_file` was already an
 * accepted kind value before FTP and FTPS were added -- a saved SFTP
 * connection keeps loading without a rename.
 */
export const FILE_SERVER_KINDS = ["ftp_file", "ftps_file", "sftp_file"] as const;
export type FileServerKind = (typeof FILE_SERVER_KINDS)[number];

export function isFileServerKind(kind: string): kind is FileServerKind {
  return (FILE_SERVER_KINDS as readonly string[]).includes(kind);
}

/** The protocol behind each file-server kind, for messages and the transport. */
export const FILE_SERVER_PROTOCOLS: Record<FileServerKind, "ftp" | "ftps" | "sftp"> = {
  ftp_file: "ftp",
  ftps_file: "ftps",
  sftp_file: "sftp",
};

export const FILE_SERVER_DEFAULT_PORTS: Record<FileServerKind, number> = {
  ftp_file: 21,
  ftps_file: 21,
  sftp_file: 22,
};

/** Plain names for the settings screen. */
export const DATA_CONNECTION_KIND_LABELS: Record<DataConnectionKind, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  fiken: "Fiken",
  ftp_file: "FTP server",
  ftps_file: "FTPS server (encrypted)",
  sftp_file: "SFTP server (encrypted)",
};

/**
 * Kinds Paperclip can actually read through today. The other kinds are
 * accepted by validation and stored (with their credential locked to the
 * connection), and answer "coming soon" everywhere a read would happen. The
 * server-side registry is the source of truth for behaviour; this list is
 * what the settings screen shows before anything is saved, and a test keeps
 * the two in step.
 */
export const SUPPORTED_DATA_CONNECTION_KINDS: readonly DataConnectionKind[] = ["shopify", "ftp_file", "ftps_file", "sftp_file"];

/**
 * `read_write` exists for file-server connections only (the company's own
 * server). Every other kind is stored with `read`, and the server refuses a
 * write through a `read` connection before any command is sent.
 */
export const DATA_CONNECTION_ACCESS_LEVELS = ["read", "read_write"] as const;
export type DataConnectionAccessLevel = (typeof DATA_CONNECTION_ACCESS_LEVELS)[number];

/**
 * Every credential shape any kind can hold. A credential kind belongs to
 * exactly one source kind -- or, for the three file-server kinds, to that one
 * family (`password` for all three, `private_key` for SFTP only) -- see
 * DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND. The database refuses a pair that
 * does not belong together (data_connections_credential_kind_check).
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
  ftp_file: ["password"],
  ftps_file: ["password"],
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
      "Bruk butikkens myshopify-adresse, for eksempel nordstrand.myshopify.com. Du finner den i Shopify under Innstillinger → Domener.",
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
  "Bruk butikkens offentlige https-adresse, for eksempel https://butikken.no. Ikke http, ikke en IP-adresse, og ikke en adresse som bare virker på et internt nett.";

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
    message: "Bruk selskapets Fiken-slug, for eksempel fiken-demo-firma-as. Du finner den i adressen når du er inne i selskapet i Fiken.",
  });

export const FILE_SERVER_HOST_MESSAGE =
  "Use the server's public name, for example files.example.com. Not an IP address, and not a name that only works on an internal network.";

const fileServerHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => isPublicLookingHostName(value), { message: FILE_SERVER_HOST_MESSAGE });

const noWhitespace = (value: string) => !/\s/.test(value);

/** The two shapes a Shopify key comes in. Unchanged from slice S1. */
export const shopifyCredentialSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("admin_access_token"),
    accessToken: z
      .string()
      .trim()
      .min(20, "Tilgangsnøkkelen er for kort. Den starter som regel med shpat_ og er en lang bokstavrekke.")
      .max(512)
      .refine(noWhitespace, { message: "Tilgangsnøkkelen skal være én sammenhengende rekke uten mellomrom." }),
  }).strict(),
  z.object({
    kind: z.literal("client_credentials"),
    clientId: z
      .string()
      .trim()
      .min(8, "Lim inn klient-ID-en fra appen i Shopify Dev Dashboard.")
      .max(256)
      .refine(noWhitespace, { message: "Klient-ID-en skal være én sammenhengende rekke uten mellomrom." }),
    clientSecret: z
      .string()
      .trim()
      .min(16, "Klienthemmeligheten er for kort. Lim inn hele verdien fra Shopify Dev Dashboard.")
      .max(512)
      .refine(noWhitespace, { message: "Klienthemmeligheten skal være én sammenhengende rekke uten mellomrom." }),
  }).strict(),
]);
export type ShopifyCredentialInput = z.infer<typeof shopifyCredentialSchema>;

/** WooCommerce REST API keys: a consumer key (ck_…) and consumer secret (cs_…), read-only. */
export const wooCommerceCredentialSchema = z.object({
  kind: z.literal("consumer_key_secret"),
  consumerKey: z
    .string()
    .trim()
    .min(16, "Consumer key er for kort. Den starter som regel med ck_ og er en lang bokstavrekke.")
    .max(512)
    .refine(noWhitespace, { message: "Consumer key skal være én sammenhengende rekke uten mellomrom." }),
  consumerSecret: z
    .string()
    .trim()
    .min(16, "Consumer secret er for kort. Den starter som regel med cs_ og er en lang bokstavrekke.")
    .max(512)
    .refine(noWhitespace, { message: "Consumer secret skal være én sammenhengende rekke uten mellomrom." }),
}).strict();
export type WooCommerceCredentialInput = z.infer<typeof wooCommerceCredentialSchema>;

/** A Fiken personal API token. */
export const fikenCredentialSchema = z.object({
  kind: z.literal("api_token"),
  apiToken: z
    .string()
    .trim()
    .min(16, "API-nøkkelen er for kort. Lim inn hele verdien fra Fiken.")
    .max(512)
    .refine(noWhitespace, { message: "API-nøkkelen skal være én sammenhengende rekke uten mellomrom." }),
}).strict();
export type FikenCredentialInput = z.infer<typeof fikenCredentialSchema>;

/** FTP, FTPS and SFTP: a password. */
export const fileServerPasswordCredentialSchema = z.object({
  kind: z.literal("password"),
  password: z.string().min(1, "Enter the password.").max(1024),
}).strict();

/** SFTP only: a private key (PEM/OpenSSH) with an optional passphrase. */
export const sftpPrivateKeyCredentialSchema = z.object({
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
}).strict();

/** SFTP: a password, or a private key with an optional passphrase. */
export const sftpCredentialSchema = z.discriminatedUnion("kind", [
  fileServerPasswordCredentialSchema,
  sftpPrivateKeyCredentialSchema,
]);
export type SftpCredentialInput = z.infer<typeof sftpCredentialSchema>;
export type FileServerCredentialInput = SftpCredentialInput;

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
  z.string().trim().min(1, "Gi koblingen et navn.").max(80).default(fallback);

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

/**
 * The base folder on the server. Always an absolute path; `..` is refused
 * here and again on every request. A trailing slash is dropped (except for
 * the root itself) so paths join predictably.
 */
export const FILE_SERVER_BASE_PATH_MESSAGE =
  "The base folder must be a full path starting with /, for example /reports.";

export function normalizeRemotePathInput(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (value.length > 1 && value.endsWith("/")) return value.replace(/\/+$/, "") || "/";
  return value;
}

const fileServerBasePathSchema = z
  .string()
  .trim()
  .min(1, "Enter the folder the files are in, for example /reports.")
  .max(512)
  .transform(normalizeRemotePathInput)
  .refine((value) => value.startsWith("/"), { message: FILE_SERVER_BASE_PATH_MESSAGE })
  .refine((value) => !value.split("/").includes(".."), { message: "The base folder cannot contain «..»." })
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "The base folder cannot contain control characters." });

const fileServerUsernameSchema = z
  .string()
  .trim()
  .min(1, "Enter the user name on the server.")
  .max(128)
  .refine(noWhitespace, { message: "The user name cannot contain spaces." })
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "The user name cannot contain control characters." });

const fileServerAccessSchema = z.enum(DATA_CONNECTION_ACCESS_LEVELS).default("read");

export const FILE_SERVER_UNENCRYPTED_MESSAGE =
  "Plain FTP sends the password and every file unencrypted. Tick the box to confirm you understand, or choose FTPS or SFTP.";

/** The one field that differs per protocol: plain FTP must be acknowledged as unencrypted. */
const acknowledgedUnencryptedSchema = z.literal(true, {
  errorMap: () => ({ message: FILE_SERVER_UNENCRYPTED_MESSAGE }),
});

function fileServerFields<K extends FileServerKind>(kind: K) {
  return {
    kind: z.literal(kind),
    name: connectionNameSchema(DATA_CONNECTION_KIND_LABELS[kind]),
    host: fileServerHostSchema,
    port: z.number().int().min(1).max(65_535).default(FILE_SERVER_DEFAULT_PORTS[kind]),
    username: fileServerUsernameSchema,
    /** Absolute base folder on the server. Every path an agent asks for is confined under it. */
    remotePath: fileServerBasePathSchema,
    /** `read` for a partner's server; `read_write` for the company's own. */
    access: fileServerAccessSchema,
    dailyLookupCap: dailyLookupCapSchema.optional(),
  };
}

export const createFtpFileConnectionSchema = z.object({
  ...fileServerFields("ftp_file"),
  credential: fileServerPasswordCredentialSchema,
  acknowledgedUnencrypted: acknowledgedUnencryptedSchema,
}).strict();

export const createFtpsFileConnectionSchema = z.object({
  ...fileServerFields("ftps_file"),
  credential: fileServerPasswordCredentialSchema,
}).strict();

export const createSftpFileConnectionSchema = z.object({
  ...fileServerFields("sftp_file"),
  credential: sftpCredentialSchema,
}).strict();

export const createDataConnectionSchema = z.discriminatedUnion("kind", [
  createShopifyConnectionSchema,
  createWooCommerceConnectionSchema,
  createFikenConnectionSchema,
  createFtpFileConnectionSchema,
  createFtpsFileConnectionSchema,
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
function fileServerConfigFields<K extends FileServerKind>(kind: K) {
  return {
    host: fileServerHostSchema,
    port: z.number().int().min(1).max(65_535).default(FILE_SERVER_DEFAULT_PORTS[kind]),
    username: z.string().trim().min(1).max(128),
    remotePath: z.string().trim().min(1).max(512).transform(normalizeRemotePathInput),
  };
}
export const ftpFileConnectionConfigSchema = z.object({
  ...fileServerConfigFields("ftp_file"),
  acknowledgedUnencrypted: z.literal(true).default(true),
}).strip();
export const ftpsFileConnectionConfigSchema = z.object(fileServerConfigFields("ftps_file")).strip();
export const sftpFileConnectionConfigSchema = z.object(fileServerConfigFields("sftp_file")).strip();

export const FILE_SERVER_CONFIG_SCHEMAS: Record<FileServerKind, z.ZodTypeAny> = {
  ftp_file: ftpFileConnectionConfigSchema,
  ftps_file: ftpsFileConnectionConfigSchema,
  sftp_file: sftpFileConnectionConfigSchema,
};

/** The non-secret settings every file-server kind shares. */
export type FileServerConnectionConfig = z.infer<typeof sftpFileConnectionConfigSchema>;

export type DataConnectionConfig =
  | ({ kind: "shopify" } & z.infer<typeof shopifyConnectionConfigSchema>)
  | ({ kind: "woocommerce" } & z.infer<typeof wooCommerceConnectionConfigSchema>)
  | ({ kind: "fiken" } & z.infer<typeof fikenConnectionConfigSchema>)
  | ({ kind: "ftp_file" } & z.infer<typeof ftpFileConnectionConfigSchema>)
  | ({ kind: "ftps_file" } & z.infer<typeof ftpsFileConnectionConfigSchema>)
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
 * DUR-3972 slice S2: "Prøveberegning" in Datakilder. The operator picks one or
 * two calendar months (never free dates) and Paperclip counts units sold in
 * them through the connection, exactly as an agent answer would, so the
 * numbers can be compared with Shopify Analytics before "Salg" is ticked.
 */
export const DATA_TRIAL_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const dataTrialCalculationSchema = z.object({
  periods: z
    .array(z.string().regex(DATA_TRIAL_MONTH_PATTERN, "Velg en måned, for eksempel 2026-07."))
    .min(1, "Velg minst én måned.")
    .max(2, "Velg høyst to måneder."),
  groupBy: z.enum(["none", "product_type"]).default("product_type"),
}).strict();
export type DataTrialCalculationInput = z.input<typeof dataTrialCalculationSchema>;
