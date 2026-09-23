import { describe, expect, it } from "vitest";
import {
  DATA_CONNECTION_CREDENTIAL_KINDS,
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KINDS,
  SUPPORTED_DATA_CONNECTION_KINDS,
  createDataConnectionSchema,
  dataConnectionCredentialSchema,
  isPublicLookingHostName,
  normalizeStoreUrlInput,
  updateDataConnectionSchema,
} from "./data-connection.js";

/**
 * DUR-3997 slice 3: the create input is a discriminated union on kind. The
 * Shopify shape is exactly what slice S1 shipped; the other three kinds are
 * accepted by validation so they can be stored, and every secret field is
 * validated on its own.
 */

const KEY = "shp" + "at_0123456789abcdef0123456789abcdef";
const CK = "ck_" + "0123456789abcdef0123456789abcdef";
const CS = "cs_" + "fedcba9876543210fedcba9876543210";
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"a".repeat(80)}\n-----END OPENSSH PRIVATE KEY-----`;

describe("createDataConnectionSchema", () => {
  it("keeps the Shopify shape exactly: normalised shop address, defaults, strict", () => {
    const parsed = createDataConnectionSchema.parse({
      kind: "shopify",
      shopDomain: "https://Nordstrand.myshopify.com/admin",
      credential: { kind: "admin_access_token", accessToken: KEY },
    });
    expect(parsed).toEqual({
      kind: "shopify",
      name: "Shopify",
      shopDomain: "nordstrand.myshopify.com",
      credential: { kind: "admin_access_token", accessToken: KEY },
    });
    const handleOnly = createDataConnectionSchema.parse({
      kind: "shopify",
      shopDomain: "nordstrand",
      credential: { kind: "client_credentials", clientId: "client-id-0001", clientSecret: "shp" + "ss_secret0123456789" },
    });
    expect(handleOnly.kind === "shopify" && handleOnly.shopDomain).toBe("nordstrand.myshopify.com");
    expect(() =>
      createDataConnectionSchema.parse({
        kind: "shopify",
        shopDomain: "nordstrand.no",
        credential: { kind: "admin_access_token", accessToken: KEY },
      }),
    ).toThrow(/myshopify/);
    // A WooCommerce credential on a Shopify connection is refused by the union itself.
    expect(
      createDataConnectionSchema.safeParse({
        kind: "shopify",
        shopDomain: "nordstrand",
        credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS },
      }).success,
    ).toBe(false);
    // Unknown fields (a store URL on a Shopify connection) are refused, not ignored.
    expect(
      createDataConnectionSchema.safeParse({
        kind: "shopify",
        shopDomain: "nordstrand",
        storeUrl: "https://x.no",
        credential: { kind: "admin_access_token", accessToken: KEY },
      }).success,
    ).toBe(false);
  });

  it("accepts a WooCommerce store on a public https address, and nothing less", () => {
    const parsed = createDataConnectionSchema.parse({
      kind: "woocommerce",
      storeUrl: "butikken.no/wp-admin/",
      credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS },
    });
    expect(parsed).toEqual({
      kind: "woocommerce",
      name: "WooCommerce",
      storeUrl: "https://butikken.no",
      credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS },
    });
    for (const bad of [
      "http://butikken.no",
      "https://butikken.no:8443",
      "https://user:pw@butikken.no",
      "https://10.0.0.5",
      "https://[::1]/",
      "https://localhost",
      "https://butikk.local",
      "https://intranett",
      "https://butikken.internal",
      "",
    ]) {
      const result = createDataConnectionSchema.safeParse({
        kind: "woocommerce",
        storeUrl: bad,
        credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS },
      });
      expect(result.success, `should refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("accepts a Fiken company slug and API token", () => {
    const parsed = createDataConnectionSchema.parse({
      kind: "fiken",
      companySlug: " Fiken-Demo-Firma-AS ",
      credential: { kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" },
    });
    expect(parsed).toMatchObject({ kind: "fiken", name: "Fiken", companySlug: "fiken-demo-firma-as" });
    expect(
      createDataConnectionSchema.safeParse({
        kind: "fiken",
        companySlug: "not a slug",
        credential: { kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" },
      }).success,
    ).toBe(false);
  });

  it("accepts SFTP with a password or a private key, port 22 by default, a full base folder, and read access by default", () => {
    const withPassword = createDataConnectionSchema.parse({
      kind: "sftp_file",
      host: "Files.example.com",
      username: "paperclip",
      remotePath: "/reports/",
      credential: { kind: "password", password: "hunter2" },
    });
    expect(withPassword).toEqual({
      kind: "sftp_file",
      name: "SFTP server (encrypted)",
      host: "files.example.com",
      port: 22,
      username: "paperclip",
      // A trailing slash is dropped so paths join predictably.
      remotePath: "/reports",
      access: "read",
      credential: { kind: "password", password: "hunter2" },
    });
    const withKey = createDataConnectionSchema.parse({
      kind: "sftp_file",
      host: "files.example.com",
      port: 2222,
      username: "paperclip",
      remotePath: "/reports/2026",
      access: "read_write",
      credential: { kind: "private_key", privateKey: PEM, passphrase: "pp" },
    });
    expect(withKey).toMatchObject({ port: 2222, access: "read_write", credential: { kind: "private_key", privateKey: PEM, passphrase: "pp" } });
    for (const bad of [
      { host: "10.0.0.5" },
      { host: "fileserver" },
      { remotePath: "reports" },
      { remotePath: "/reports/../etc" },
      { credential: { kind: "private_key", privateKey: "not a key at all" } },
      { credential: { kind: "password", password: "" } },
      { credential: { kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" } },
      { port: 70000 },
      { access: "write_only" },
    ]) {
      const result = createDataConnectionSchema.safeParse({
        kind: "sftp_file",
        host: "files.example.com",
        username: "paperclip",
        remotePath: "/reports",
        credential: { kind: "password", password: "hunter2" },
        ...bad,
      });
      expect(result.success, `should refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("accepts FTPS with a password and port 21 by default, and refuses a private key on FTP or FTPS", () => {
    const ftps = createDataConnectionSchema.parse({
      kind: "ftps_file",
      host: "files.example.com",
      username: "paperclip",
      remotePath: "/reports",
      credential: { kind: "password", password: "hunter2" },
    });
    expect(ftps).toEqual({
      kind: "ftps_file",
      name: "FTPS server (encrypted)",
      host: "files.example.com",
      port: 21,
      username: "paperclip",
      remotePath: "/reports",
      access: "read",
      credential: { kind: "password", password: "hunter2" },
    });
    // A private key belongs to SFTP only: the union has no FTP/FTPS member that takes one.
    for (const kind of ["ftp_file", "ftps_file"] as const) {
      expect(
        createDataConnectionSchema.safeParse({
          kind,
          host: "files.example.com",
          username: "paperclip",
          remotePath: "/reports",
          credential: { kind: "private_key", privateKey: PEM },
          ...(kind === "ftp_file" ? { acknowledgedUnencrypted: true } : {}),
        }).success,
      ).toBe(false);
    }
  });

  it("makes plain FTP require the unencrypted acknowledgement, port 21 by default", () => {
    // Without the tick, FTP is refused.
    expect(
      createDataConnectionSchema.safeParse({
        kind: "ftp_file",
        host: "files.example.com",
        username: "paperclip",
        remotePath: "/reports",
        credential: { kind: "password", password: "hunter2" },
      }).success,
    ).toBe(false);
    // A false tick is refused too.
    expect(
      createDataConnectionSchema.safeParse({
        kind: "ftp_file",
        host: "files.example.com",
        username: "paperclip",
        remotePath: "/reports",
        credential: { kind: "password", password: "hunter2" },
        acknowledgedUnencrypted: false,
      }).success,
    ).toBe(false);
    const ftp = createDataConnectionSchema.parse({
      kind: "ftp_file",
      host: "files.example.com",
      username: "paperclip",
      remotePath: "/reports",
      access: "read_write",
      credential: { kind: "password", password: "hunter2" },
      acknowledgedUnencrypted: true,
    });
    expect(ftp).toEqual({
      kind: "ftp_file",
      name: "FTP server",
      host: "files.example.com",
      port: 21,
      username: "paperclip",
      remotePath: "/reports",
      access: "read_write",
      credential: { kind: "password", password: "hunter2" },
      acknowledgedUnencrypted: true,
    });
  });

  it("refuses an unknown kind and a kind without its fields", () => {
    expect(createDataConnectionSchema.safeParse({ kind: "magento", credential: { kind: "api_token", apiToken: "x".repeat(20) } }).success).toBe(false);
    expect(createDataConnectionSchema.safeParse({ kind: "woocommerce", credential: { kind: "consumer_key_secret", consumerKey: CK, consumerSecret: CS } }).success).toBe(false);
    expect(createDataConnectionSchema.safeParse({}).success).toBe(false);
  });
});

describe("credential kinds", () => {
  it("every credential kind belongs to one source kind (except password, shared by the three file kinds), and the union covers them all", () => {
    const kindsByCredential = new Map<string, string[]>();
    for (const kind of DATA_CONNECTION_KINDS) {
      for (const credentialKind of DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND[kind]) {
        kindsByCredential.set(credentialKind, [...(kindsByCredential.get(credentialKind) ?? []), kind]);
      }
    }
    // `password` is the one credential kind more than one source uses: the
    // three file-server kinds. Every other belongs to exactly one source.
    for (const [credentialKind, kinds] of kindsByCredential) {
      if (credentialKind === "password") {
        expect(kinds.sort()).toEqual(["ftp_file", "ftps_file", "sftp_file"]);
      } else {
        expect(kinds, `${credentialKind} used by ${kinds.join(", ")}`).toHaveLength(1);
      }
    }
    expect([...kindsByCredential.keys()].sort()).toEqual([...DATA_CONNECTION_CREDENTIAL_KINDS].sort());
    expect(dataConnectionCredentialSchema.options.map((option) => option.shape.kind.value).sort()).toEqual(
      [...DATA_CONNECTION_CREDENTIAL_KINDS].sort(),
    );
  });

  it("a replacement key may be of any credential kind here; the server matches it to the connection's kind", () => {
    expect(updateDataConnectionSchema.parse({ credential: { kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" } })).toEqual({
      credential: { kind: "api_token", apiToken: "0123456789abcdef0123456789abcdef" },
    });
    expect(updateDataConnectionSchema.safeParse({ credential: { kind: "password" } }).success).toBe(false);
  });

  it("Shopify and the three file-server kinds are readable today; WooCommerce and Fiken are not", () => {
    expect([...SUPPORTED_DATA_CONNECTION_KINDS].sort()).toEqual(["ftp_file", "ftps_file", "sftp_file", "shopify"]);
    expect(SUPPORTED_DATA_CONNECTION_KINDS).not.toContain("woocommerce");
    expect(SUPPORTED_DATA_CONNECTION_KINDS).not.toContain("fiken");
  });
});

describe("normalizeStoreUrlInput / isPublicLookingHostName", () => {
  it("reduces a store address to its https origin", () => {
    expect(normalizeStoreUrlInput("  Butikken.NO/wp-json/wc/v3?x=1 ")).toEqual({ ok: true, origin: "https://butikken.no", host: "butikken.no" });
    expect(normalizeStoreUrlInput("https://shop.butikken.no:443/")).toEqual({ ok: true, origin: "https://shop.butikken.no", host: "shop.butikken.no" });
    expect(normalizeStoreUrlInput("http://butikken.no").ok).toBe(false);
    expect(normalizeStoreUrlInput("ftp://butikken.no").ok).toBe(false);
  });

  it("knows a public-looking name from one that only means something inside a network", () => {
    expect(isPublicLookingHostName("butikken.no")).toBe(true);
    expect(isPublicLookingHostName("a.b.c.example")).toBe(false); // .example is reserved
    expect(isPublicLookingHostName("shop.example.com")).toBe(true);
    for (const bad of ["localhost", "127.0.0.1", "::1", "intranett", "nas.local", "printer.lan", "x.internal", "-bad.no", "bad-.no", ""]) {
      expect(isPublicLookingHostName(bad), bad).toBe(false);
    }
  });
});
