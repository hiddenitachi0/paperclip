-- DUR-149 (DUR-146 Stage 1 backend): role registry columns + per-agent
-- provisioning provenance. Additive only — company_agent_roles already has a
-- real UNIQUE(company_id, key) constraint from 0136 (the Drizzle schema file
-- just never declared it; fixed alongside this migration), so no uniqueness
-- backfill is needed here.
--
-- `is_builtin` is provenance-only (seeded roles stay editable/deletable —
-- nothing in the service layer special-cases it).
-- `skill_keys` / `connector_keys` are opaque string keys (a role's declared
-- skill-catalog and MCP-tool-library references); this migration does not
-- wire them into the live company_skills / company_mcp_tools materialization
-- paths — see the PR description for why that's scoped out.
ALTER TABLE "company_agent_roles"
  ADD COLUMN "is_builtin"    boolean NOT NULL DEFAULT false,
  ADD COLUMN "skill_keys"    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "connector_keys" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- Per-agent override deltas (add/remove on top of whatever the assigned job
-- grants) and the resolved-provenance snapshot resolveAgentRoleProvisioning
-- writes. Deliberately separate columns from adapter_config — an agent can
-- self-update its own adapterConfig (subject to the existing DUR-55/57
-- mcpServers sub-key guard), so provenance bookkeeping must live somewhere
-- an agent-authenticated PATCH can never reach (see
-- assertNoRoleAssignmentFields / assertNoToolLibraryAssignmentFields in
-- services/agents.ts, extended in this change to also cover these fields).
ALTER TABLE "agents"
  ADD COLUMN "role_overrides"                    jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN "role_provisioned_skill_keys"       jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN "role_provisioned_connector_keys"   jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN "role_provisioned_permission_keys"  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN "role_resolved_at"                  timestamptz;
