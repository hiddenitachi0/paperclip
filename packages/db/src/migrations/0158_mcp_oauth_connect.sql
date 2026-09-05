-- DUR-3909: "Connect & sign in" — a short-lived, board-only OAuth
-- authorization-code+PKCE handshake for one company_mcp_tools entry. Rows
-- here are scratch state for reaching a normal company_secrets row
-- (result_secret_id); the sealed client secret / PKCE verifier are cleared
-- the moment the handshake finishes.

CREATE TABLE "company_mcp_oauth_connections" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"                uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "tool_id"                   uuid NOT NULL REFERENCES "company_mcp_tools"("id") ON DELETE CASCADE,
  "server_url"                text NOT NULL,
  "status"                    text NOT NULL DEFAULT 'pending',
  "state"                     text NOT NULL,
  "redirect_uri"              text NOT NULL,
  "resource"                  text,
  "discovery_state"           jsonb,
  "client_information_sealed" text,
  "code_verifier_sealed"      text,
  "result_secret_id"          uuid REFERENCES "company_secrets"("id") ON DELETE SET NULL,
  "error_message"             text,
  "started_by_user_id"        text,
  "expires_at"                timestamptz NOT NULL,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "company_mcp_oauth_connections_company_id_idx" ON "company_mcp_oauth_connections"("company_id");
--> statement-breakpoint
CREATE INDEX "company_mcp_oauth_connections_tool_id_idx" ON "company_mcp_oauth_connections"("tool_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_mcp_oauth_connections_state_uq" ON "company_mcp_oauth_connections"("state");
--> statement-breakpoint
CREATE INDEX "company_mcp_oauth_connections_expires_idx" ON "company_mcp_oauth_connections"("expires_at");
