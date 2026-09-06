// DUR-3909: "Connect & sign in" for MCP tool-library entries whose server
// authenticates via interactive OAuth (e.g. https://mcp.higgsfield.ai/mcp)
// instead of a pasted API key. An agent can never reach this flow — it is
// mounted with the same board-only posture as mcp-tool-library.ts — because
// the whole point is that a *human* completes the browser sign-in once, and
// the resulting token is then handed to agents the same way any other
// tool-library credential is: as a normal Secrets entry bound into the
// tool's connection.headers.Authorization.
//
// The OAuth mechanics (RFC 9728 protected-resource discovery, RFC 8414
// authorization-server discovery, RFC 7591 dynamic client registration,
// PKCE) are delegated entirely to the MCP SDK's `auth()` orchestrator
// (@modelcontextprotocol/sdk/client/auth.js) via a small OAuthClientProvider
// that persists its state on a company_mcp_oauth_connections row instead of
// disk, because our two orchestrator calls (start, then the browser-redirect
// callback) land in two different HTTP requests.
import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMcpOAuthConnections } from "@paperclipai/db";
import {
  auth as runOAuthOrchestrator,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpToolLibraryConnection } from "@paperclipai/shared/validators/mcp-tool-library";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { getMcpTool, updateMcpTool } from "./mcp-tool-library.js";
import { secretService } from "./secrets.js";

const SESSION_TTL_MS = 10 * 60 * 1000;
const OAUTH_MATERIAL_PREFIX = "mcp-oauth-connect:";

type OAuthConnectionRow = typeof companyMcpOAuthConnections.$inferSelect;

async function sealMaterial(value: string): Promise<string> {
  const prepared = await localEncryptedProvider.createSecret({ value });
  return `${OAUTH_MATERIAL_PREFIX}${JSON.stringify(prepared.material)}`;
}

async function unsealMaterial(value: string): Promise<string> {
  if (!value.startsWith(OAUTH_MATERIAL_PREFIX)) {
    throw badRequest("Invalid sealed OAuth connect material");
  }
  const material = JSON.parse(value.slice(OAUTH_MATERIAL_PREFIX.length)) as Record<string, unknown>;
  return localEncryptedProvider.resolveVersion({ material, externalRef: null });
}

function clientMetadataFor(toolName: string, redirectUri: string): OAuthClientMetadata {
  return {
    client_name: `Paperclip — ${toolName}`,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

// Bridges the SDK's per-call OAuthClientProvider contract onto a single
// company_mcp_oauth_connections row. `start()` and `resumeForCallback()`
// each construct a fresh instance around the same row (across the two
// separate HTTP requests the flow spans) and persist everything the SDK
// hands them back into that row's columns.
class RowBackedOAuthClientProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  private _tokens: OAuthTokens | null = null;
  private _clientInformation: OAuthClientInformationFull | null = null;
  private _codeVerifier: string | null = null;
  private _discoveryState: OAuthDiscoveryState | null = null;

  constructor(
    private readonly row: OAuthConnectionRow,
    private readonly toolName: string,
  ) {}

  get redirectUrl() {
    return this.row.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadataFor(this.toolName, this.row.redirectUri);
  }

  state() {
    return this.row.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInformation ?? undefined;
  }

  saveClientInformation(info: OAuthClientInformationFull) {
    this._clientInformation = info;
  }

  tokens() {
    return this._tokens ?? undefined;
  }

  saveTokens(tokens: OAuthTokens) {
    this._tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.authorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string) {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) throw badRequest("Missing PKCE code verifier for this OAuth connect session");
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this._discoveryState = state;
  }

  discoveryState() {
    return this._discoveryState ?? undefined;
  }

  async restoreFromRow() {
    if (this.row.clientInformationSealed) {
      this._clientInformation = JSON.parse(
        await unsealMaterial(this.row.clientInformationSealed),
      ) as OAuthClientInformationFull;
    }
    if (this.row.codeVerifierSealed) {
      this._codeVerifier = await unsealMaterial(this.row.codeVerifierSealed);
    }
    if (this.row.discoveryState) {
      this._discoveryState = this.row.discoveryState as unknown as OAuthDiscoveryState;
    }
  }

  capturedTokens() {
    return this._tokens;
  }

  async persistedPatch(): Promise<Partial<typeof companyMcpOAuthConnections.$inferInsert>> {
    return {
      clientInformationSealed: this._clientInformation
        ? await sealMaterial(JSON.stringify(this._clientInformation))
        : this.row.clientInformationSealed,
      codeVerifierSealed: this._codeVerifier ? await sealMaterial(this._codeVerifier) : this.row.codeVerifierSealed,
      discoveryState: this._discoveryState
        ? (this._discoveryState as unknown as Record<string, unknown>)
        : this.row.discoveryState,
    };
  }
}

function computeRedirectBaseUrl(requestOrigin: string): string {
  const configured = process.env.PAPERCLIP_PUBLIC_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request-derived origin below
    }
  }
  return requestOrigin;
}

export function mcpOAuthService(db: Db) {
  const secrets = secretService(db);

  async function requireTool(toolId: string, companyId: string) {
    const tool = await getMcpTool(db, toolId);
    if (!tool || tool.companyId !== companyId) throw notFound("Tool not found");
    return tool;
  }

  async function requireSession(sessionId: string) {
    const [row] = await db
      .select()
      .from(companyMcpOAuthConnections)
      .where(eq(companyMcpOAuthConnections.id, sessionId));
    if (!row) throw notFound("OAuth connect session not found");
    return row;
  }

  return {
    async start(input: {
      companyId: string;
      toolId: string;
      requestOrigin: string;
      userId?: string | null;
    }) {
      const tool = await requireTool(input.toolId, input.companyId);
      const connection = (tool.connection ?? {}) as Record<string, unknown>;
      const serverUrl = typeof connection.url === "string" ? connection.url.trim() : "";
      if (!serverUrl) {
        throw unprocessable("Connect & sign in needs a tool that connects to a URL, not a command");
      }

      const sessionId = crypto.randomUUID();
      const redirectUri = `${computeRedirectBaseUrl(input.requestOrigin)}/api/mcp-tools/oauth/callback/${sessionId}`;
      const state = crypto.randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      const draftRow: OAuthConnectionRow = {
        id: sessionId,
        companyId: input.companyId,
        toolId: tool.id,
        serverUrl,
        status: "pending",
        state,
        redirectUri,
        resource: null,
        discoveryState: null,
        clientInformationSealed: null,
        codeVerifierSealed: null,
        resultSecretId: null,
        errorMessage: null,
        startedByUserId: input.userId ?? null,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const provider = new RowBackedOAuthClientProvider(draftRow, tool.name);
      let result: "AUTHORIZED" | "REDIRECT";
      try {
        result = await runOAuthOrchestrator(provider, { serverUrl });
      } catch (error) {
        throw badRequest(
          `Could not start OAuth with this server: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (result !== "REDIRECT" || !provider.authorizationUrl) {
        throw badRequest("This server did not return an OAuth authorization step to redirect to");
      }

      const patch = await provider.persistedPatch();
      const [row] = await db
        .insert(companyMcpOAuthConnections)
        .values({ ...draftRow, ...patch })
        .returning();
      if (!row) throw badRequest("Failed to start OAuth connect session");

      return { sessionId: row.id, authorizeUrl: provider.authorizationUrl };
    },

    async status(sessionId: string, companyId: string) {
      const row = await requireSession(sessionId);
      if (row.companyId !== companyId) throw notFound("OAuth connect session not found");
      return {
        id: row.id,
        toolId: row.toolId,
        status: row.status,
        errorMessage: row.errorMessage,
        resultSecretId: row.resultSecretId,
      };
    },

    // Hit directly by the operator's browser after the third-party
    // authorization server redirects back — unauthenticated by design (the
    // browser leaving our origin and coming back can't carry board session
    // auth to a third party and back), gated instead by the unguessable
    // `state` token minted in start() and the row's short TTL.
    async completeCallback(input: {
      sessionId: string;
      code?: string;
      state?: string;
      error?: string;
      errorDescription?: string;
    }) {
      const row = await requireSession(input.sessionId);
      if (row.status !== "pending") {
        return { ok: row.status === "completed", toolName: null, message: "This connect link was already used." };
      }
      if (row.expiresAt.getTime() < Date.now()) {
        await markFailed(db, row, "This connect link expired. Start over from the tool's Edit dialog.");
        return { ok: false, toolName: null, message: "This connect link expired. Start over from the tool's Edit dialog." };
      }
      const tool = await getMcpTool(db, row.toolId);
      if (!tool) {
        await markFailed(db, row, "The tool this was connecting was deleted.");
        return { ok: false, toolName: null, message: "The tool this was connecting was deleted." };
      }
      if (input.error) {
        const message = input.errorDescription || input.error;
        await markFailed(db, row, message);
        return { ok: false, toolName: tool.name, message };
      }
      if (!input.code || !input.state || input.state !== row.state) {
        const message = "OAuth callback did not match the connect session that started it.";
        await markFailed(db, row, message);
        return { ok: false, toolName: tool.name, message };
      }

      const provider = new RowBackedOAuthClientProvider(row, tool.name);
      await provider.restoreFromRow();
      try {
        const result = await runOAuthOrchestrator(provider, {
          serverUrl: row.serverUrl,
          authorizationCode: input.code,
        });
        if (result !== "AUTHORIZED") {
          throw new Error("Authorization server did not return a token");
        }
      } catch (error) {
        const message = `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`;
        await markFailed(db, row, message);
        return { ok: false, toolName: tool.name, message };
      }

      const tokens = provider.capturedTokens();
      if (!tokens?.access_token) {
        const message = "Authorization server did not return an access token";
        await markFailed(db, row, message);
        return { ok: false, toolName: tool.name, message };
      }

      const headerValue = `${tokens.token_type ?? "Bearer"} ${tokens.access_token}`;
      const secret = await secrets.createManagedLocalSecret(
        row.companyId,
        {
          name: `${tool.name} OAuth token (${new Date().toISOString().slice(0, 10)})`,
          key: `mcp-oauth.${tool.key}.${row.id}`,
          value: headerValue,
          description: `Captured via "Connect & sign in" for ${tool.name} (${row.serverUrl}).`,
        },
        { userId: row.startedByUserId },
      );

      const existingConnection = (tool.connection ?? {}) as McpToolLibraryConnection;
      const nextConnection: McpToolLibraryConnection = {
        ...existingConnection,
        headers: {
          ...existingConnection.headers,
          Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      };
      await updateMcpTool(db, tool.id, { connection: nextConnection });

      await db
        .update(companyMcpOAuthConnections)
        .set({
          status: "completed",
          resultSecretId: secret.id,
          clientInformationSealed: null,
          codeVerifierSealed: null,
          updatedAt: new Date(),
        })
        .where(eq(companyMcpOAuthConnections.id, row.id));

      return { ok: true, toolName: tool.name, message: `Connected ${tool.name}.` };
    },
  };
}

async function markFailed(db: Db, row: OAuthConnectionRow, message: string) {
  await db
    .update(companyMcpOAuthConnections)
    .set({
      status: "failed",
      errorMessage: message,
      clientInformationSealed: null,
      codeVerifierSealed: null,
      updatedAt: new Date(),
    })
    .where(eq(companyMcpOAuthConnections.id, row.id));
}

// Best-effort GC for abandoned handshakes; called opportunistically from the
// route layer rather than run as a cron (this table only ever holds a
// handful of rows at once — one per in-flight "Connect & sign in" click).
export async function pruneExpiredMcpOAuthConnections(db: Db, now = new Date()) {
  await db
    .delete(companyMcpOAuthConnections)
    .where(and(eq(companyMcpOAuthConnections.status, "pending"), lt(companyMcpOAuthConnections.expiresAt, now)));
}
