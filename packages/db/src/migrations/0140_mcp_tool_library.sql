-- DUR-143: the MCP "tool library" — add a server once in Settings (name,
-- human description, connection config), then tick a checkbox per agent to
-- grant/revoke it. `agents.mcp_tool_ids` is a live selection (re-read at
-- dispatch time), not a one-time snapshot like company_agent_roles.

CREATE TABLE "company_mcp_tools" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name"         text NOT NULL,
  "key"          text NOT NULL,
  "description"  text NOT NULL,
  "connection"   jsonb NOT NULL DEFAULT '{}',
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("company_id", "key")
);
--> statement-breakpoint
CREATE INDEX "company_mcp_tools_company_id_idx" ON "company_mcp_tools"("company_id");
--> statement-breakpoint
CREATE INDEX "company_mcp_tools_company_key_idx" ON "company_mcp_tools"("company_id", "key");
--> statement-breakpoint

ALTER TABLE "agents"
  ADD COLUMN "mcp_tool_ids" jsonb NOT NULL DEFAULT '[]';
