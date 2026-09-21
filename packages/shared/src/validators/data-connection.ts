import { z } from "zod";

/**
 * DUR-3972 slice S1: connecting a company to an outside business-data source.
 *
 * Shopify is the only kind so far. Read is the only access level there is --
 * there is deliberately no way to express "write" in any input below, and the
 * database refuses it too (data_connections_access_check).
 */

export const DATA_CONNECTION_KINDS = ["shopify"] as const;
export type DataConnectionKind = (typeof DATA_CONNECTION_KINDS)[number];

export const DATA_CONNECTION_ACCESS_LEVELS = ["read"] as const;
export type DataConnectionAccessLevel = (typeof DATA_CONNECTION_ACCESS_LEVELS)[number];

export const DATA_CONNECTION_CREDENTIAL_KINDS = ["admin_access_token", "client_credentials"] as const;
export type DataConnectionCredentialKind = (typeof DATA_CONNECTION_CREDENTIAL_KINDS)[number];

export const DATA_CONNECTION_STATUSES = ["draft", "active", "error", "disabled"] as const;
export type DataConnectionStatus = (typeof DATA_CONNECTION_STATUSES)[number];

/** Datasets a company can point at a connection. "Lager" (stock) comes later. */
export const DATA_DATASETS = ["sales"] as const;
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

const noWhitespace = (value: string) => !/\s/.test(value);

export const dataConnectionCredentialSchema = z.discriminatedUnion("kind", [
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
export type DataConnectionCredentialInput = z.infer<typeof dataConnectionCredentialSchema>;

const dailyLookupCapSchema = z.number().int().min(1).max(100_000);

export const createDataConnectionSchema = z.object({
  kind: z.enum(DATA_CONNECTION_KINDS),
  name: z.string().trim().min(1, "Gi koblingen et navn.").max(80).default("Shopify"),
  shopDomain: shopDomainSchema,
  credential: dataConnectionCredentialSchema,
  dailyLookupCap: dailyLookupCapSchema.optional(),
}).strict();
export type CreateDataConnectionInput = z.infer<typeof createDataConnectionSchema>;

/**
 * `status` can only be switched between on ("active") and off ("disabled")
 * here. Turning it on is refused by the server unless the last Test passed
 * with a read-only key -- see dataConnectionService.update.
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
