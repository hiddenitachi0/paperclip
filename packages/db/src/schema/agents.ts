import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";
import { companyAgentRoles } from "./company_agent_roles.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    // DUR-61 addendum: split into two fields. `tone` is short — how this
    // agent speaks, applies to any agent. `personality` is long — who this
    // agent IS (backstory, likes/dislikes, appearance), only persona agents
    // need it. They compose: tone shapes wording, personality defines the
    // agent underneath it.
    tone: text("tone"),
    personality: text("personality"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    errorReason: text("error_reason"),
    // DUR-128: when this agent last transitioned into "error" (cleared
    // whenever it leaves error, via resume/clear-error/pause/terminate).
    // Distinct from updatedAt, which other unrelated writes also bump.
    // errorAlertedAt records when the stall sweep last raised an operator
    // alert for the current error episode, so it fires once, not every tick.
    errorAt: timestamp("error_at", { withTimezone: true }),
    errorAlertedAt: timestamp("error_alerted_at", { withTimezone: true }),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    // Plain uuid column, no `.references()` — a typed FK reference here would
    // create a schema import cycle since assets.ts already imports agents.ts.
    // The FK constraint (assets(id) ON DELETE SET NULL) is declared by hand
    // in the migration SQL instead (see 0132_agent_avatar.sql).
    avatarAssetId: uuid("avatar_asset_id"),
    // Lane A (DUR-217): direct-model-call text endpoint, no agent runtime. Off
    // by default and board-settable only — see assertCanManageLaneAFlag in
    // server/src/routes/agents.ts, which mirrors the instructions-path guard.
    laneAEnabled: boolean("lane_a_enabled").notNull().default(false),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // DUR-109: last time a human (direct bundle/file edit) or an approved
    // boss-proposed instructions_change actually reviewed/applied this
    // agent's instructions. Defaults to now() on the migration backfill and
    // on every new agent, so "days since last reviewed" starts counting from
    // a known point rather than reading as an indefinite null.
    instructionsReviewedAt: timestamp("instructions_reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    // DUR-114: nullable FK to company_agent_roles. Distinct from agents.role (the
    // legacy 12-value enum text column) — do not conflate them.
    roleId: uuid("role_id").references(() => companyAgentRoles.id, { onDelete: "set null" }),
    // Snapshot of what was applied when the role was assigned, so UI can diff
    // "from role" vs "changed on this agent". Updated at assignment time only.
    roleAppliedMcpServerNames: jsonb("role_applied_mcp_server_names")
      .$type<string[]>()
      .default([]),
    roleAppliedPermissionKeys: jsonb("role_applied_permission_keys")
      .$type<string[]>()
      .default([]),
    // DUR-149: explicit add/remove deltas layered on top of the assigned
    // job — shape is { skills?: {add?, remove?}, connectors?: {add?, remove?},
    // rights?: {add?: {permissionKey,scope}[], remove?: string[]} }. Never
    // settable through agentService.create/update (see
    // assertNoRoleAssignmentFields) — only the dedicated role-overrides
    // endpoint may write it, same board-only gate as role assignment itself.
    roleOverrides: jsonb("role_overrides").$type<Record<string, unknown>>().notNull().default({}),
    // Resolved-effective-set snapshot written by resolveAgentRoleProvisioning
    // (job UNION operator-add, MINUS operator-remove). Deliberately separate
    // from adapterConfig, which an agent can self-update (subject to the
    // DUR-55/57 mcpServers sub-key guard) — provenance must live somewhere
    // that guard doesn't need to cover because no self-update path reaches it.
    roleProvisionedSkillKeys: jsonb("role_provisioned_skill_keys").$type<string[]>().notNull().default([]),
    roleProvisionedConnectorKeys: jsonb("role_provisioned_connector_keys").$type<string[]>().notNull().default([]),
    roleProvisionedPermissionKeys: jsonb("role_provisioned_permission_keys").$type<string[]>().notNull().default([]),
    roleResolvedAt: timestamp("role_resolved_at", { withTimezone: true }),
    // DUR-143: ids of company_mcp_tools rows this agent is checked-on for.
    // Live selection, re-read and merged into adapterConfig.mcpServers on
    // every dispatch (see resolveAgentMcpToolLibraryServers in
    // services/mcp-tool-library.ts) — unlike roleAppliedMcpServerNames above,
    // this is NOT a one-time snapshot. Never settable through the generic
    // agentService.create/update patch (see assertNoToolLibraryAssignmentFields
    // in services/agents.ts); only the dedicated assignment route may write it.
    mcpToolIds: jsonb("mcp_tool_ids").$type<string[]>().notNull().default([]),
    // DUR-189: namespaced plugin tool names (e.g. "paperclip.media-studio:generate-image")
    // this agent may call via POST /plugins/tools/execute. Empty list means
    // unrestricted — matches every agent's behavior before this column existed,
    // so adding it is not a backward-compat break. A non-empty list narrows the
    // agent to exactly those tools (see assertPluginToolGranted in
    // routes/plugins.ts). Same write posture as mcpToolIds: blocked from the
    // generic create/update patch (assertNoPluginToolAssignmentFields in
    // services/agents.ts), only the dedicated assignment route may write it.
    pluginToolGrants: jsonb("plugin_tool_grants").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
  }),
);
