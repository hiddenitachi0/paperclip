-- DUR-114: company_agent_roles ("jobs") table and agent FK columns.
-- A role is a named, plain-language job belonging to a company carrying:
--   1. default instructions (free text)
--   2. default MCP server configs (jsonb array)
--   3. default permission grants (jsonb array of {permissionKey, scope})
-- Assigning a role to an agent applies those defaults once at assignment time.
-- agents.role (the legacy text enum column) is LEFT UNTOUCHED.

CREATE TABLE "company_agent_roles" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"           uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name"                 text NOT NULL,
  "key"                  text NOT NULL,
  "description"          text,
  "default_instructions" text,
  "default_mcp_servers"  jsonb NOT NULL DEFAULT '[]',
  "default_grants"       jsonb NOT NULL DEFAULT '[]',
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("company_id", "key")
);
--> statement-breakpoint
CREATE INDEX "company_agent_roles_company_id_idx" ON "company_agent_roles"("company_id");
--> statement-breakpoint
CREATE INDEX "company_agent_roles_company_key_idx" ON "company_agent_roles"("company_id", "key");
--> statement-breakpoint

-- New columns on agents: nullable FK to their assigned role and a snapshot of
-- what was applied (MCP server names + permission keys) so UI can render
-- "added/removed" overrides without continuous reconciliation.
ALTER TABLE "agents"
  ADD COLUMN "role_id"                      uuid REFERENCES "company_agent_roles"("id") ON DELETE SET NULL,
  ADD COLUMN "role_applied_mcp_server_names" jsonb DEFAULT '[]',
  ADD COLUMN "role_applied_permission_keys"  jsonb DEFAULT '[]';
