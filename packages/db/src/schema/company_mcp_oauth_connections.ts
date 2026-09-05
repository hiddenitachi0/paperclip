import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMcpTools } from "./company_mcp_tools.js";
import { companySecrets } from "./company_secrets.js";

// DUR-3909: "Connect & sign in" — an in-progress (or finished) OAuth
// authorization-code+PKCE handshake for one tool-library entry, run once by
// an operator in their browser (an agent can never reach these routes: same
// board-only posture as company_mcp_tools). Rows are short-lived — the
// sealed client secret / PKCE verifier are nulled out the moment the
// handshake finishes (success or failure), and `expiresAt` bounds how long
// an abandoned handshake is left redeemable at all. The durable artifact of
// a completed handshake is the ordinary company_secrets row it produces
// (resultSecretId) — this table is scratch state for getting there, never a
// long-term credential store.
export const companyMcpOAuthConnections = pgTable(
  "company_mcp_oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id").notNull().references(() => companyMcpTools.id, { onDelete: "cascade" }),
    serverUrl: text("server_url").notNull(),
    status: text("status").$type<"pending" | "completed" | "failed">().notNull().default("pending"),
    state: text("state").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource"),
    // RFC 9728 / RFC 8414 discovery results — non-secret, kept so the
    // callback leg doesn't have to re-discover the authorization server.
    discoveryState: jsonb("discovery_state").$type<Record<string, unknown>>(),
    // RFC 7591 dynamic client registration result. May include a client
    // secret, so it's sealed the same way cloud-upstreams.ts seals its
    // pending PKCE material (see sealCloudUpstreamCredential precedent).
    clientInformationSealed: text("client_information_sealed"),
    codeVerifierSealed: text("code_verifier_sealed"),
    resultSecretId: uuid("result_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    errorMessage: text("error_message"),
    startedByUserId: text("started_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("company_mcp_oauth_connections_company_id_idx").on(t.companyId),
    index("company_mcp_oauth_connections_tool_id_idx").on(t.toolId),
    uniqueIndex("company_mcp_oauth_connections_state_uq").on(t.state),
    index("company_mcp_oauth_connections_expires_idx").on(t.expiresAt),
  ],
);
