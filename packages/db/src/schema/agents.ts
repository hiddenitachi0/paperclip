import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  check,
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
    // DUR-4000 (migration 0175): which PERSON is doing this job, if any. A
    // persona can be attached to many agents; the agent keeps its own name.
    // Plain uuid, no `.references()` — personas.ts imports this file, so a
    // typed reference would be an import cycle. The FK (personas(id) ON
    // DELETE SET NULL) and the (company_id, persona_id) index are declared
    // by hand in 0175_persona_identity.sql. Board-settable only (same guard
    // style as the quick-agent fields in server/src/routes/agents.ts).
    personaId: uuid("persona_id"),
    // DUR-4000: the agent's own limits box, shape
    //   { dailyImageGenerations?: number|null, dailyPosts?: number|null,
    //     dailyRuns?: number|null, notes?: string|null }
    // (agentLimitsSchema in packages/shared). dailyImageGenerations is
    // enforced in code (server/src/services/agent-daily-limits.ts, counted
    // in agent_daily_counters). notes is rendered into the prompt as
    // "Standing rules from your operator" (heartbeat.ts for full agents,
    // lane-a.ts for quick agents). dailyPosts and dailyRuns are STORED ONLY:
    // nothing reads them yet, not even the prompt. Board-settable only,
    // never agent-writable.
    limits: jsonb("limits").$type<Record<string, unknown>>().notNull().default({}),
    // Lane A (DUR-217): direct-model-call text endpoint, no agent runtime. Off
    // by default and board-settable only — see assertCanManageLaneAFlag in
    // server/src/routes/agents.ts, which mirrors the instructions-path guard.
    laneAEnabled: boolean("lane_a_enabled").notNull().default(false),
    // Quick agents (migration 0162): the operator-written instruction set a
    // Lane A agent follows (persona + rules). Board-settable only, same guard
    // as laneAEnabled. Null means "no special instructions".
    laneAInstructions: text("lane_a_instructions"),
    // DUR-3977 (migration 0165). All three are null for every quick agent
    // that existed before, meaning "use the platform default" — the defaults
    // themselves live in packages/shared/src/lane-a-models.ts so the UI, the
    // validators and the runtime read the same numbers.
    //   lane_a_model                     — which model this quick agent runs on
    //   lane_a_max_output_tokens         — how long an answer it may produce
    //   lane_a_transform_daily_call_cap  — how many stateless transform calls
    //                                      it may serve per UTC day. Separate
    //                                      from the 200-turn chat cap on
    //                                      purpose (acceptance item 4).
    laneAModel: text("lane_a_model"),
    laneAMaxOutputTokens: integer("lane_a_max_output_tokens"),
    laneATransformDailyCallCap: integer("lane_a_transform_daily_call_cap"),
    // DUR-3997 (migration 0172). Which provider answers this quick agent's
    // calls (anthropic | openai | google | openrouter | local) and, for
    // OpenRouter / a local model, the OpenAI-compatible endpoint. Null on
    // both = Claude via Paperclip's own instance key, i.e. exactly what every
    // quick agent did before. The provider KEY is not a column: it is a
    // secret binding at adapterConfig.laneA.apiKey (LANE_A_API_KEY_CONFIG_PATH
    // in packages/shared), resolved binding-gated and audited at call time.
    laneAProvider: text("lane_a_provider"),
    laneABaseUrl: text("lane_a_base_url"),
    // Migration 0179: quick-agent "creativity" (sampling temperature, 0-1.5).
    // Null = send no temperature, i.e. the model host's own default, which is
    // what every quick agent did before this column existed.
    laneATemperature: real("lane_a_temperature"),
    // DUR-4367: quick-agent "Thinking" ("on" | "off" | null). Null = "model
    // default", i.e. what every quick agent did before this column existed.
    // "off" asks the model to skip its reasoning pass (see
    // laneAThinkingForCall in packages/shared) — the fix for a local
    // reasoning model answering ~3x slower through Paperclip than the same
    // message sent to it directly.
    laneAThinking: text("lane_a_thinking"),
    // Migration 0189: quick-agent "model hosts" for OpenRouter — which hosts
    // (OpenRouter provider slugs such as "deepinfra") a call may only use,
    // should try first, or must never use. Validated by the API
    // (laneAProviderRoutingSchema in packages/shared). Only read when the
    // quick agent's provider is OpenRouter. Null = no preference, i.e. what
    // every quick agent did before this column existed.
    laneAProviderRouting: jsonb("lane_a_provider_routing").$type<{
      only?: string[];
      order?: string[];
      ignore?: string[];
      allowFallbacks?: boolean;
    }>(),
    // DUR-4013 step 3 (migration 0183). Whether, and how far, this agent may
    // drive the browser worker: "off" (default, no browser tool offered at
    // all) | "browse_and_forms" (navigate/read/click/type/fill forms, no
    // final booking/purchase step) | "book_and_buy" (adds the gated
    // request_booking/request_purchase/confirm_final_step tools — not wired
    // to anything yet; those land in step 4/6). Board-settable only, same
    // guard shape as personaId/limits (assertNoAgentBrowserAccessFieldMutation
    // in server/src/routes/agents.ts) — an agent that could switch this on
    // for itself would have no gate at all.
    browserAccess: text("browser_access").notNull().default("off"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // DUR-4017: the operator's daily briefing settings for this agent
    // (enabled, delivery time, timezone, place override, sources/topics,
    // price symbols, headline cap). Shape is morningReportSettingsSchema in
    // packages/shared. Null means the feature has never been configured — the
    // UI treats that the same as `enabled: false`. Board-settable only, same
    // guard as the rest of QUICK_AGENT_FIELDS: an agent cannot switch its own
    // daily report on or change what it is told to fetch.
    morningReportSettings: jsonb("morning_report_settings").$type<Record<string, unknown>>(),
    // The scheduler tick's single-flight lease on this agent's morning report
    // (mirrors watchers.check_lease_until in packages/db/src/schema/watchers.ts):
    // set while a report is being composed so two overlapping ticks never fire
    // the same day's report twice. Cleared once the report is written, or left
    // to expire if composing crashes.
    morningReportLeaseUntil: timestamp("morning_report_lease_until", { withTimezone: true }),
    // The agent-local calendar date (YYYY-MM-DD, in morningReportSettings.timezone)
    // a report was last generated for. The tick compares this to "today" in the
    // agent's own timezone before firing, so a DST transition, or a tick that
    // runs more than once inside the target minute, never sends two reports the
    // same local day.
    morningReportLastSentDate: text("morning_report_last_sent_date"),
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
    // DUR-4004: ids of company_api_tools rows ("API with a key") this agent is
    // checked-on for. Same posture as mcpToolIds: live selection re-read on
    // every dispatch, never settable through the generic create/update patch
    // (assertNoToolLibraryAssignmentFields), only the dedicated assignment
    // route writes it. Empty means none.
    apiToolIds: jsonb("api_tool_ids").$type<string[]>().notNull().default([]),
    // DUR-4070 (migration 0189): the one dial that gates plugin tools,
    // business data, company files, web search, browser access and memory
    // together — "limited" (none of the six, regardless of any other
    // per-tool switch/grant already stored on this row) | "standard" |
    // "full" (both read the existing per-tool switches unchanged; only
    // "limited" adds a restriction). Defaults to "full" for every agent,
    // existing and new, so this column ships with zero behavior change until
    // an operator explicitly turns an agent down. Board-settable only, same
    // guard posture as the rest of QUICK_AGENT_FIELDS
    // (assertNoAgentLaneAFlagMutation in server/src/routes/agents.ts).
    laneATrustLevel: text("lane_a_trust_level").notNull().default("full"),
    // DUR-4070 (migration 0189): company-member userIds (company_memberships
    // principalId) this quick agent may answer, in addition to the company's
    // owner, who can always reach it. Empty (the default for every existing
    // and new agent) means "the owner only" -- so this column also ships with
    // zero behavior change for a single-operator company. Live selection,
    // read fresh on every Lane A call (services/lane-a.ts), never a snapshot.
    // Board-settable only, same guard posture as the rest of
    // QUICK_AGENT_FIELDS.
    laneAAssignedUserIds: jsonb("lane_a_assigned_user_ids").$type<string[]>().notNull().default([]),
    // DUR-4347 (migration TBD): the backup-model pool for this quick agent's
    // fallback chains — up to 5 entries, each a stable `id` (nanoid, stable
    // across edits so chain/keyword-route references survive a reorder) plus
    // its own provider/model/baseUrl/temperature, resolved through the same
    // credential path as the main model (resolveLaneASettings in
    // server/src/services/lane-a.ts). Board-settable only, same guard posture
    // as the rest of QUICK_AGENT_FIELDS — an agent that could add its own
    // backup models could route itself to a provider/key the operator never
    // picked.
    laneABackupModels: jsonb("lane_a_backup_models")
      .$type<
        {
          id: string;
          provider: string;
          model: string;
          baseUrl?: string | null;
          temperature?: number | null;
        }[]
      >()
      .notNull()
      .default([]),
    // Ordered pool ids tried, in order, after the starting model, when it does
    // not answer (connection failure, timeout, 5xx, 429, model not loaded) --
    // see resolveLaneARouting in server/src/services/lane-a.ts. Empty = no
    // fallback, i.e. today's behaviour.
    laneANoAnswerChainIds: jsonb("lane_a_no_answer_chain_ids").$type<string[]>().notNull().default([]),
    // Ordered pool ids tried, in order, after a refusal (provider-flagged or
    // text-pattern/classifier-detected) on the starting model or anywhere else
    // in this chain. Never falls back to the no-answer chain. Empty = a
    // refusal returns one plain error, i.e. today's behaviour.
    laneARefusalChainIds: jsonb("lane_a_refusal_chain_ids").$type<string[]>().notNull().default([]),
    // Ordered keyword-routing rules: the first whole-word, case-insensitive
    // phrase match in the person's message picks the starting pool entry for
    // that turn (recorded on the first attempt as `keyword:<ruleId>`), before
    // the no-answer/refusal chains above are even built. Empty = always start
    // at the main model, i.e. today's behaviour.
    laneAKeywordRoutes: jsonb("lane_a_keyword_routes")
      .$type<{ id: string; phrases: string[]; backupId: string }[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
    laneATrustLevelCheck: check(
      "agents_lane_a_trust_level_check",
      sql`${table.laneATrustLevel} IN ('limited', 'standard', 'full')`,
    ),
  }),
);
