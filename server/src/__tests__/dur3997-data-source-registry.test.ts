import { describe, expect, it } from "vitest";
import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KINDS,
  SUPPORTED_DATA_CONNECTION_KINDS,
  type DataConnectionConfig,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { dataConnectionSecretName } from "../services/data-connections.js";
import type { DataSourceConnectionInfo } from "../services/data-sources/connection-kind.js";
import {
  credentialHint,
  credentialSecretValues,
  decodeCredential,
  encodeCredential,
} from "../services/data-sources/credential-codec.js";
import { getDataSourceKind, listDataSourceKinds, type OpenReadContextInput } from "../services/data-sources/registry.js";
import { SHOPIFY_OUTBOUND_POLICY } from "../services/safe-outbound-fetch.js";

/**
 * DUR-3997 slice 3: the source-kind registry.
 *
 *  - every kind the shared validators accept has an entry, and only Shopify
 *    is readable;
 *  - an unknown kind is refused, never guessed;
 *  - the Shopify entry is the one selected for a Shopify row, and its sales
 *    adapter and transport behave as before (token in the header, guarded
 *    endpoint, nothing else);
 *  - a kind without a transport answers every read path with one plain
 *    sentence instead of crashing;
 *  - the credential codec round-trips every credential kind and still reads
 *    the two Shopify encodings slice S1 wrote;
 *  - the per-connection secret name is unique across two connections of one
 *    kind with the same name.
 */

const KEY = "shp" + "at_0123456789abcdef0123456789abcdef";
const CK = "ck_" + "0123456789abcdef0123456789abcdef";
const CS = "cs_" + "fedcba9876543210fedcba9876543210";
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"a".repeat(80)}\n-----END OPENSSH PRIVATE KEY-----`;

function connection(kind: DataSourceConnectionInfo["kind"], config: DataConnectionConfig, extra: Partial<DataSourceConnectionInfo> = {}): DataSourceConnectionInfo {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    companyId: "a0000000-0000-4000-8000-000000000001",
    kind,
    name: "Test",
    shopDomain: kind === "shopify" ? "nordstrand-test.myshopify.com" : null,
    apiVersion: kind === "shopify" ? "2026-07" : null,
    config,
    ianaTimezone: null,
    currencyCode: null,
    earliestVisibleOrderAt: null,
    ...extra,
  };
}

function registryInput(info: DataSourceConnectionInfo, overrides: Partial<OpenReadContextInput> = {}): OpenReadContextInput {
  const secrets: string[] = [];
  return {
    connection: info,
    loadCredential: async () => ({ kind: "admin_access_token", accessToken: KEY }),
    budget: { maxRequests: 10, deadlineMs: 5_000 },
    knownSecrets: () => [...secrets],
    registerSecret: (value) => secrets.push(value),
    deps: {},
    ...overrides,
  };
}

async function expectHttpError(promise: Promise<unknown> | (() => unknown), code: string) {
  const error = await Promise.resolve()
    .then(() => (typeof promise === "function" ? promise() : promise))
    .then(() => null, (err: unknown) => err);
  expect(error, `expected a refusal with code ${code}`).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(422);
  expect(((error as HttpError).details as { code?: string }).code).toBe(code);
}

describe("DUR-3997 data-source registry", () => {
  it("registers every shared kind, with the shared credential kinds, and only Shopify readable", () => {
    const kinds = listDataSourceKinds();
    expect(kinds.map((entry) => entry.kind)).toEqual([...DATA_CONNECTION_KINDS]);
    for (const entry of kinds) {
      expect(entry.credentialKinds).toEqual(DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND[entry.kind]);
      expect(entry.supported).toBe(SUPPORTED_DATA_CONNECTION_KINDS.includes(entry.kind));
      expect(entry.datasets.length).toBeGreaterThan(0);
    }
    expect(getDataSourceKind("shopify").adapters.sales).toBeTypeOf("function");
    expect(getDataSourceKind("shopify").adapters.productTypes).toBeTypeOf("function");
    for (const kind of ["woocommerce", "fiken", "sftp_file"]) {
      expect(getDataSourceKind(kind).adapters).toEqual({});
    }
  });

  it("refuses an unknown kind instead of guessing", async () => {
    await expectHttpError(() => getDataSourceKind("magento"), "data_source_kind_unknown");
    await expectHttpError(() => getDataSourceKind(""), "data_source_kind_unknown");
  });

  it("selects the Shopify entry for a Shopify row: same endpoint, token in the header, guarded fetch, sales adapter", async () => {
    const shopify = getDataSourceKind("shopify");
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(JSON.stringify({ data: { shop: { name: "Demo" } }, extensions: { cost: { actualQueryCost: 1 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const info = connection("shopify", { kind: "shopify" });
    const input = registryInput(info, { deps: { fetchImpl, now: () => 1_000 } });

    const read = shopify.openReadContext(input);
    expect(read.kind).toBe("shopify");
    if (read.kind !== "shopify") throw new Error("unreachable");
    expect(read.connection).toBe(info);
    expect(read.shopifyTransport.shopDomain).toBe("nordstrand-test.myshopify.com");

    const body = await read.shopifyTransport.request("query { shop { name } }", {});
    expect((body.data as { shop: { name: string } }).shop.name).toBe("Demo");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://nordstrand-test.myshopify.com/admin/api/2026-07/graphql.json");
    expect(calls[0]!.headers["x-shopify-access-token"]).toBe(KEY);

    // The paced client counts; the sales adapter is built on the raw transport.
    await read.shopify.query("query { shop { name } }");
    expect(read.stats()).toEqual({ requests: 1, costPoints: 1 });
    const adapter = shopify.adapters.sales!(read, { limits: { maxDurationMs: 1_000 } });
    expect(adapter.sales).toBeTypeOf("function");
    expect(adapter.catalog).toBeTypeOf("function");

    expect(shopify.outboundPolicy({ kind: "shopify" })).toBe(SHOPIFY_OUTBOUND_POLICY);
    expect(shopify.describeTarget({ shopDomain: "nordstrand-test.myshopify.com", config: { kind: "shopify" } })).toBe("nordstrand-test.myshopify.com");
    expect(shopify.storedShape({ kind: "shopify", name: "x", shopDomain: "nordstrand-test.myshopify.com", credential: { kind: "admin_access_token", accessToken: KEY } }))
      .toEqual({ shopDomain: "nordstrand-test.myshopify.com", apiVersion: "2026-07", config: {} });
    expect(shopify.canActivate({ shopName: null, shopDomain: null, ianaTimezone: null, currencyCode: null, grantedScopes: ["read_orders", "read_all_orders", "read_products"], earliestVisibleOrderAt: null, productTypeCoverage: null, checkedAt: null }).ok).toBe(true);
    expect(shopify.canActivate(null).ok).toBe(false);
  });

  it("the Shopify sales adapter refuses a context of another kind", () => {
    const shopify = getDataSourceKind("shopify");
    const pending = { kind: "woocommerce" as const, connection: connection("woocommerce", { kind: "woocommerce", storeUrl: "https://butikken.no" }), now: () => new Date(), stats: () => ({ requests: 0, costPoints: 0 }) };
    expect(() => shopify.adapters.sales!(pending)).toThrow(HttpError);
  });

  it("a kind without a transport answers 'kommer snart' on every read path and never crashes", async () => {
    const cases: Array<[string, DataConnectionConfig]> = [
      ["woocommerce", { kind: "woocommerce", storeUrl: "https://butikken.no" }],
      ["fiken", { kind: "fiken", companySlug: "fiken-demo-firma-as" }],
      ["sftp_file", { kind: "sftp_file", host: "filer.butikken.no", port: 22, username: "u", remotePath: "/rapporter" }],
    ];
    for (const [kind, config] of cases) {
      const entry = getDataSourceKind(kind);
      const input = registryInput(connection(entry.kind, config));
      await expectHttpError(() => entry.openReadContext(input), "data_source_kind_unsupported");
      const check = await entry.check(input);
      expect(check).toMatchObject({ ok: false, canActivate: false, observed: null, notes: [], stats: { requests: 0, costPoints: 0 } });
      expect(check.problems).toHaveLength(1);
      expect(check.problems[0]).toContain("kan ikke leses ennå");
      expect(check.problems[0]).toContain(entry.label);
      expect(entry.canActivate(null)).toMatchObject({ ok: false });
    }
  });

  it("stores only each kind's own non-secret settings in config, and describes where it points", () => {
    const woo = getDataSourceKind("woocommerce");
    expect(
      woo.storedShape({ kind: "woocommerce", name: "Butikken", storeUrl: "https://butikken.no", credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS }, dailyLookupCap: 5 }),
    ).toEqual({ shopDomain: null, apiVersion: null, config: { storeUrl: "https://butikken.no" } });
    expect(woo.describeTarget({ shopDomain: null, config: { kind: "woocommerce", storeUrl: "https://butikken.no" } })).toBe("butikken.no");
    expect(woo.outboundPolicy({ kind: "woocommerce", storeUrl: "https://butikken.no" })?.hostPattern.test("butikken.no")).toBe(true);
    expect(woo.outboundPolicy({ kind: "woocommerce", storeUrl: "https://butikken.no" })?.hostPattern.test("evil.no")).toBe(false);
    expect(woo.datasets).toEqual(["sales"]);

    const fiken = getDataSourceKind("fiken");
    expect(fiken.storedShape({ kind: "fiken", name: "Regnskap", companySlug: "fiken-demo-firma-as", credential: { kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" } }))
      .toEqual({ shopDomain: null, apiVersion: null, config: { companySlug: "fiken-demo-firma-as" } });
    expect(fiken.describeTarget({ shopDomain: null, config: { kind: "fiken", companySlug: "fiken-demo-firma-as" } })).toBe("fiken-demo-firma-as");
    expect(fiken.outboundPolicy({ kind: "fiken", companySlug: "x" })?.hostPattern.test("api.fiken.no")).toBe(true);
    expect(fiken.datasets).toEqual(["finance"]);

    const sftp = getDataSourceKind("sftp_file");
    const shape = sftp.storedShape({ kind: "sftp_file", name: "Filer", host: "filer.butikken.no", port: 2222, username: "paperclip", remotePath: "/rapporter", credential: { kind: "password", password: "hunter2" } });
    expect(shape).toEqual({ shopDomain: null, apiVersion: null, config: { host: "filer.butikken.no", port: 2222, username: "paperclip", remotePath: "/rapporter" } });
    expect(JSON.stringify(shape)).not.toContain("hunter2");
    expect(sftp.describeTarget({ shopDomain: null, config: { kind: "sftp_file", host: "filer.butikken.no", port: 2222, username: "paperclip", remotePath: "/rapporter" } })).toBe("filer.butikken.no:2222/rapporter");
    expect(sftp.describeTarget({ shopDomain: null, config: { kind: "sftp_file", host: "filer.butikken.no", port: 22, username: "paperclip", remotePath: "/rapporter" } })).toBe("filer.butikken.no/rapporter");
    expect(sftp.outboundPolicy({ kind: "sftp_file", host: "h.no", port: 22, username: "u", remotePath: "/" })).toBeNull();
    expect(sftp.datasets).toEqual(["custom"]);
  });
});

describe("DUR-3997 credential codec", () => {
  it("round-trips every credential kind, and still reads the two Shopify encodings slice S1 wrote", () => {
    const all = [
      { kind: "admin_access_token" as const, accessToken: KEY },
      { kind: "client_credentials" as const, clientId: "client-id-0001", clientSecret: "shp" + "ss_secret0123456789" },
      { kind: "consumer_key_secret" as const, consumerKey: CK, consumerSecret: CS },
      { kind: "api_token" as const, apiToken: "0123456789abcdef0123456789abcdef" },
      { kind: "password" as const, password: "hunter2" },
      { kind: "private_key" as const, privateKey: PEM, passphrase: "pp" },
      { kind: "private_key" as const, privateKey: PEM },
    ];
    for (const credential of all) {
      expect(decodeCredential(credential.kind, encodeCredential(credential))).toEqual(credential);
    }
    // S1 encodings, byte for byte.
    expect(encodeCredential({ kind: "admin_access_token", accessToken: KEY })).toBe(KEY);
    expect(JSON.parse(encodeCredential({ kind: "client_credentials", clientId: "a-b-c-d-e", clientSecret: "shp" + "ss_secret0123456789" }))).toEqual({
      clientId: "a-b-c-d-e",
      clientSecret: "shp" + "ss_secret0123456789",
    });
  });

  it("hints with the last four characters of a long token only, never of a password or a short value, and lists what to scrub", () => {
    expect(credentialHint({ kind: "admin_access_token", accessToken: KEY })).toBe(`••••${KEY.slice(-4)}`);
    expect(credentialHint({ kind: "client_credentials", clientId: "client-id-0001", clientSecret: "shp" + "ss_secret0123456789" })).toBe("••••6789");
    expect(credentialHint({ kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS })).toBe(`••••${CS.slice(-4)}`);
    expect(credentialHint({ kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" })).toBe("••••cdef");
    // A password may be short, so its tail would give away half of it.
    expect(credentialHint({ kind: "password", password: "hunter2" })).toBe("••••");
    expect(credentialHint({ kind: "password", password: "a-much-longer-password-than-usual" })).toBe("••••");
    expect(credentialHint({ kind: "private_key", privateKey: PEM })).toBe("••••");
    expect(credentialHint({ kind: "api_token", apiToken: "short-token" })).toBe("••••");
    expect(credentialSecretValues({ kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS })).toEqual([CS, CK]);
    expect(credentialSecretValues({ kind: "private_key", privateKey: PEM, passphrase: "pp" })).toEqual([PEM, "pp"]);
  });

  it("refuses an unreadable stored value with a plain sentence that never echoes it", async () => {
    for (const [kind, raw] of [
      ["client_credentials", "not json"],
      ["client_credentials", JSON.stringify({ clientId: "only-id" })],
      ["consumer_key_secret", JSON.stringify({ consumerKey: CK })],
      ["private_key", JSON.stringify({})],
      ["admin_access_token", ""],
      ["nonsense", "whatever-value"],
    ] as const) {
      const error = await Promise.resolve()
        .then(() => decodeCredential(kind, raw))
        .then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(HttpError);
      expect(((error as HttpError).details as { code?: string }).code).toBe("credential_unreadable");
      expect((error as HttpError).message).not.toContain("whatever-value");
      expect((error as HttpError).message).not.toContain("only-id");
    }
  });
});

describe("DUR-3997 per-connection secret name", () => {
  it("is unique across two connections of one kind with the same name, and readable in the Secrets screen", () => {
    const shopify = getDataSourceKind("shopify");
    const a = dataConnectionSecretName(shopify, "Nettbutikken", "3f2a9c1d-0000-4000-8000-000000000001");
    const b = dataConnectionSecretName(shopify, "Nettbutikken", "7b81e0aa-0000-4000-8000-000000000002");
    expect(a).toBe("Shopify-nøkkel: Nettbutikken (3f2a9c1d)");
    expect(b).toBe("Shopify-nøkkel: Nettbutikken (7b81e0aa)");
    expect(a).not.toBe(b);
    // The derived secret key (lower-cased, non [a-z0-9_.-] runs collapsed) differs too.
    const key = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
    expect(key(a)).not.toBe(key(b));
    // A long connection name is clipped so the id part always survives the 120-char key limit.
    const long = dataConnectionSecretName(getDataSourceKind("woocommerce"), "x".repeat(200), "7b81e0aa-0000-4000-8000-000000000002");
    expect(key(long)).toContain("7b81e0aa");
    expect(dataConnectionSecretName(getDataSourceKind("fiken"), "   ", "7b81e0aa-0000-4000-8000-000000000002")).toBe("Fiken-nøkkel: Fiken (7b81e0aa)");
  });
});
