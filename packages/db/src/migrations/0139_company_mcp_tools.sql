-- DUR-143: company_mcp_tools ("tool library") table + per-agent assignment.
-- Filip's ask: adding an MCP tool (e.g. Fal.ai) should work exactly like the
-- existing Skills flow -- add it once in Settings, then tick a checkbox on an
-- agent to give it that tool. No raw JSON in the primary flow.
--
-- A tool's `connection` jsonb holds transport/command/args/url plus a
-- `credentials` array of {field,key,secretId,version} -- every credential is
-- always a secret_ref (see packages/shared/src/validators/company-mcp-tool.ts),
-- never a plaintext value, so nothing sensitive is ever stored on this table
-- or copied onto an agent record.
--
-- Assigning a tool to an agent (server/src/services/company-mcp-tools.ts)
-- merges a derived mcpServerConfig entry into that agent's existing
-- adapterConfig.mcpServers array -- the exact same shape the advanced raw-JSON
-- path already writes -- so no new runtime/resolution code is required; the
-- existing DUR-132 secret_ref resolution in resolveAdapterConfigForRuntime
-- picks it up unchanged. agents.assigned_mcp_tool_ids tracks which library
-- tools are currently checked, so unticking one can cleanly remove just its
-- entry.

CREATE TABLE "company_mcp_tools" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name"         text NOT NULL,
  "key"          text NOT NULL,
  "description"  text NOT NULL,
  "connection"   jsonb NOT NULL,
  "catalog_key"  text,
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
  ADD COLUMN "assigned_mcp_tool_ids" jsonb DEFAULT '[]';
