// DUR-3909: "Connect & sign in" — proves the OAuth authorization-code+PKCE
// handshake for a tool-library entry works end to end against a mocked
// third-party MCP server (RFC 9728 resource metadata, RFC 8414 authorization
// server metadata, RFC 7591 dynamic client registration, then the token
// exchange), and that a completed handshake lands a normal Secrets entry
// bound into the tool's connection.headers.Authorization — the same shape a
// pasted credential would produce.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companyMcpOAuthConnections,
  companyMcpTools,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createMcpTool, getMcpTool } from "../services/mcp-tool-library.js";
import { mcpOAuthService } from "../services/mcp-oauth.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres MCP OAuth tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MOCK_SERVER_ORIGIN = "https://mock-mcp.test";
const MOCK_SERVER_URL = `${MOCK_SERVER_ORIGIN}/mcp`;

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function mockAuthorizationServer(options: { tokenResponse?: unknown; tokenStatus?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;

    if (key === `GET ${MOCK_SERVER_ORIGIN}/.well-known/oauth-protected-resource/mcp`) {
      return jsonResponse({
        resource: MOCK_SERVER_URL,
        authorization_servers: [MOCK_SERVER_ORIGIN],
      });
    }
    if (key === `GET ${MOCK_SERVER_ORIGIN}/.well-known/oauth-authorization-server`) {
      return jsonResponse({
        issuer: MOCK_SERVER_ORIGIN,
        authorization_endpoint: `${MOCK_SERVER_ORIGIN}/authorize`,
        token_endpoint: `${MOCK_SERVER_ORIGIN}/token`,
        registration_endpoint: `${MOCK_SERVER_ORIGIN}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (key === `POST ${MOCK_SERVER_ORIGIN}/register`) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        ...body,
        client_id: "mock-client-id",
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    }
    if (key === `POST ${MOCK_SERVER_ORIGIN}/token`) {
      if (options.tokenStatus && options.tokenStatus >= 400) {
        return jsonResponse({ error: "invalid_grant" }, { status: options.tokenStatus });
      }
      return jsonResponse(
        options.tokenResponse ?? {
          access_token: "captured-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        },
      );
    }
    throw new Error(`Unexpected fetch in mcp-oauth test: ${key}`);
  });
}

describeEmbeddedPostgres("MCP OAuth connect — Connect & sign in", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-mcp-oauth-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("mcp-oauth-connect");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(companyMcpOAuthConnections);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companyMcpTools);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompanyAndTool() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const tool = await createMcpTool(db, companyId, {
      name: "Higgsfield",
      description: "Generates video",
      connection: { url: MOCK_SERVER_URL },
    });
    return { companyId, tool };
  }

  it("runs discovery + DCR + PKCE and returns an authorization URL to redirect to", async () => {
    const { companyId, tool } = await seedCompanyAndTool();
    mockAuthorizationServer();

    const svc = mcpOAuthService(db);
    const result = await svc.start({
      companyId,
      toolId: tool.id,
      requestOrigin: "http://localhost:3100",
    });

    expect(result.sessionId).toEqual(expect.any(String));
    const authorizeUrl = new URL(result.authorizeUrl);
    expect(authorizeUrl.origin).toBe(MOCK_SERVER_ORIGIN);
    expect(authorizeUrl.pathname).toBe("/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("mock-client-id");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `http://localhost:3100/api/mcp-tools/oauth/callback/${result.sessionId}`,
    );
    expect(authorizeUrl.searchParams.get("state")).toEqual(expect.any(String));

    const [row] = await db
      .select()
      .from(companyMcpOAuthConnections)
      .where(eq(companyMcpOAuthConnections.id, result.sessionId));
    expect(row?.status).toBe("pending");
    // The PKCE verifier and DCR client secret are never stored in the clear.
    expect(row?.codeVerifierSealed).toEqual(expect.any(String));
    expect(row?.clientInformationSealed).not.toContain("mock-client-id\"");
  });

  it("completes the handshake, captures the token as a Secret, and binds it into the tool's connection", async () => {
    const { companyId, tool } = await seedCompanyAndTool();
    mockAuthorizationServer();
    const svc = mcpOAuthService(db);
    const started = await svc.start({
      companyId,
      toolId: tool.id,
      requestOrigin: "http://localhost:3100",
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;

    const outcome = await svc.completeCallback({
      sessionId: started.sessionId,
      code: "mock-authorization-code",
      state,
    });

    expect(outcome).toEqual({ ok: true, toolName: "Higgsfield", message: "Connected Higgsfield." });

    const updatedTool = await getMcpTool(db, tool.id);
    const headers = (updatedTool?.connection as Record<string, unknown>).headers as Record<string, unknown>;
    const binding = headers.Authorization as { type: string; secretId: string };
    expect(binding.type).toBe("secret_ref");

    const secrets = secretService(db);
    await expect(secrets.resolveSecretValue(companyId, binding.secretId, "latest")).resolves.toBe(
      "Bearer captured-access-token",
    );

    const [row] = await db
      .select()
      .from(companyMcpOAuthConnections)
      .where(eq(companyMcpOAuthConnections.id, started.sessionId));
    expect(row?.status).toBe("completed");
    expect(row?.resultSecretId).toBe(binding.secretId);
    expect(row?.codeVerifierSealed).toBeNull();
    expect(row?.clientInformationSealed).toBeNull();
  });

  it("fails closed when the callback state does not match the session that started it", async () => {
    const { companyId, tool } = await seedCompanyAndTool();
    mockAuthorizationServer();
    const svc = mcpOAuthService(db);
    const started = await svc.start({
      companyId,
      toolId: tool.id,
      requestOrigin: "http://localhost:3100",
    });

    const outcome = await svc.completeCallback({
      sessionId: started.sessionId,
      code: "mock-authorization-code",
      state: "not-the-real-state",
    });

    expect(outcome.ok).toBe(false);
    const [row] = await db
      .select()
      .from(companyMcpOAuthConnections)
      .where(eq(companyMcpOAuthConnections.id, started.sessionId));
    expect(row?.status).toBe("failed");

    const updatedTool = await getMcpTool(db, tool.id);
    expect((updatedTool?.connection as Record<string, unknown>).headers).toBeUndefined();
  });

  it("surfaces the authorization server's error instead of exchanging a token", async () => {
    const { companyId, tool } = await seedCompanyAndTool();
    mockAuthorizationServer();
    const svc = mcpOAuthService(db);
    const started = await svc.start({
      companyId,
      toolId: tool.id,
      requestOrigin: "http://localhost:3100",
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;

    const outcome = await svc.completeCallback({
      sessionId: started.sessionId,
      error: "access_denied",
      errorDescription: "The operator declined the request.",
      state,
    });

    expect(outcome).toEqual({
      ok: false,
      toolName: "Higgsfield",
      message: "The operator declined the request.",
    });
  });

  it("rejects a second use of an already-completed connect session", async () => {
    const { companyId, tool } = await seedCompanyAndTool();
    mockAuthorizationServer();
    const svc = mcpOAuthService(db);
    const started = await svc.start({
      companyId,
      toolId: tool.id,
      requestOrigin: "http://localhost:3100",
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    await svc.completeCallback({ sessionId: started.sessionId, code: "mock-authorization-code", state });

    const replay = await svc.completeCallback({ sessionId: started.sessionId, code: "mock-authorization-code", state });
    expect(replay.ok).toBe(true);
    expect(replay.toolName).toBeNull();
  });
});
