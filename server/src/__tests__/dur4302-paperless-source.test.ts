import { describe, expect, it } from "vitest";
import type { DataConnectionConfig } from "@paperclipai/shared";
import type { DataSourceConnectionInfo } from "../services/data-sources/connection-kind.js";
import { paperlessNgxDataSource } from "../services/data-sources/paperless-source.js";
import type { OpenReadContextInput } from "../services/data-sources/registry.js";

/**
 * DUR-4302: the paperless-ngx registry entry.
 *
 *  - its outboundPolicy is built from that connection's OWN config.host/port
 *    only -- never a fork-wide allowlist -- so two companies' connections
 *    never share a reachable host, even if their credentials were (somehow)
 *    swapped;
 *  - openReadContext attaches `Authorization: Token <this company's own
 *    token>` to every request through the pinned transport, and never the
 *    raw fetch a caller might otherwise reach for;
 *  - "Test" reports ok only on a 2xx, and a plain, token-specific problem on
 *    401/403, without ever surfacing the token itself.
 */

const CONFIG_A: DataConnectionConfig = { kind: "paperless_ngx", host: "paperless-a.internal", port: 8001 };
const CONFIG_B: DataConnectionConfig = { kind: "paperless_ngx", host: "paperless-b.internal", port: 8002 };

function connection(config: DataConnectionConfig): DataSourceConnectionInfo {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    companyId: "a0000000-0000-4000-8000-000000000001",
    kind: "paperless_ngx",
    name: "Test",
    shopDomain: null,
    apiVersion: null,
    config,
    access: "read",
    hostKeyFingerprint: null,
    ianaTimezone: null,
    currencyCode: null,
    earliestVisibleOrderAt: null,
  };
}

function registryInput(config: DataConnectionConfig, overrides: Partial<OpenReadContextInput> = {}): OpenReadContextInput {
  const secrets: string[] = [];
  return {
    connection: connection(config),
    loadCredential: async () => ({ kind: "paperless_api_token", apiToken: "ptok_abcdef0123456789" }),
    budget: { maxRequests: 10, deadlineMs: 5_000 },
    knownSecrets: () => [...secrets],
    registerSecret: (value) => secrets.push(value),
    deps: {},
    ...overrides,
  };
}

describe("DUR-4302 paperless-ngx data source", () => {
  it("builds the outbound policy from that connection's own config only", () => {
    const policyA = paperlessNgxDataSource.outboundPolicy(CONFIG_A);
    const policyB = paperlessNgxDataSource.outboundPolicy(CONFIG_B);
    expect(policyA).toMatchObject({ sourceKind: "paperless_ngx", host: "paperless-a.internal", port: 8001 });
    expect(policyB).toMatchObject({ sourceKind: "paperless_ngx", host: "paperless-b.internal", port: 8002 });
    expect(policyA).not.toEqual(policyB);
  });

  it("attaches this connection's own token as an Authorization header, on every request", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      seen.push({ url: url.toString(), headers });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;

    const input = registryInput(CONFIG_A, { deps: { fetchImpl } });
    const outcome = await paperlessNgxDataSource.check(input);

    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe("Token ptok_abcdef0123456789");
  });

  it("reports a plain, token-specific problem on 401, never the token itself", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as typeof fetch;
    const input = registryInput(CONFIG_A, { deps: { fetchImpl } });
    const outcome = await paperlessNgxDataSource.check(input);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(" ")).toMatch(/not accepted/);
    expect(outcome.problems.join(" ")).not.toContain("ptok_abcdef0123456789");
  });

  it("never activates before a passed Test", () => {
    expect(paperlessNgxDataSource.canActivate(null)).toEqual({
      ok: false,
      problems: ["The connection has not passed Test yet. Press Test first."],
    });
  });
});
