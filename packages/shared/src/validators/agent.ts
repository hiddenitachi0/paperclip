import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envBindingSchema, envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
  canCreateSkills: z.boolean().optional().default(true),
  // Named capabilities that replace the old `role === "ceo"` blanket
  // authorization bypass. They default to `false` here and are given their
  // role-derived default value (true for the "ceo" role) only by
  // `defaultPermissionsForRole`/`normalizeAgentPermissions` in
  // server/src/services/agent-permissions.ts, exactly like `canCreateAgents`
  // above. An explicit value stored on the agent always wins over the
  // role-derived default.
  canManageOtherAgentsPermissions: z.boolean().optional().default(false),
  canManageCompanySettings: z.boolean().optional().default(false),
  canManageAllWorkspaceRuntimes: z.boolean().optional().default(false),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

// A single MCP (Model Context Protocol) server definition. Cross-adapter
// shape: stdio servers (`command`, spawned locally) and remote servers
// (`url`, http/sse) are both representable here, but individual adapters may
// only support a subset — e.g. codex_local's config.toml only has a stdio
// `[mcp_servers.*]` table, so url-based entries are accepted by this schema
// but skipped (with a note) at codex_local run dispatch.
// DUR-132: env/headers values may be a literal string OR a
// `{type:"secret_ref", secretId, version}` reference (same envBindingSchema
// used by adapterConfig.env), so a per-agent MCP server credential can be
// stored as a bound secret instead of readable plaintext. Resolution to a
// literal value happens server-side at run dispatch (see
// resolveAdapterConfigForRuntime in server/src/services/secrets.ts); an
// unresolved secret_ref must never reach the adapter's config parser.
export const mcpServerConfigSchema = z.object({
  name: z.string().trim().min(1),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), envBindingSchema).optional(),
  url: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), envBindingSchema).optional(),
}).strict().superRefine((value, ctx) => {
  const hasCommand = typeof value.command === "string" && value.command.length > 0;
  const hasUrl = typeof value.url === "string" && value.url.length > 0;
  if (hasCommand === hasUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "MCP server must set exactly one of `command` (stdio) or `url` (http/sse)",
      path: ["command"],
    });
  }
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpServersConfigSchema = z.array(mcpServerConfigSchema).max(50);

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue !== undefined) {
    const parsed = envConfigSchema.safeParse(envValue);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapterConfig.env must be a map of valid env bindings",
        path: ["env"],
      });
    }
  }
  const mcpServersValue = value.mcpServers;
  if (mcpServersValue !== undefined) {
    const parsed = mcpServersConfigSchema.safeParse(mcpServersValue);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapterConfig.mcpServers must be a list of valid MCP server definitions",
        path: ["mcpServers"],
      });
    }
  }
  // DUR-210: operator-declared boundary for when this agent's Claude subscription
  // quota ran out and spend moved to paid overage/credits. The CLI itself never
  // reports this, so runs at/after this timestamp are stamped with
  // subscriptionQuotaExhaustedBillingType instead of subscription_included.
  const exhaustedAtValue = value.subscriptionQuotaExhaustedAt;
  if (exhaustedAtValue !== undefined && exhaustedAtValue !== null) {
    const parsed = z.string().datetime({ offset: true }).safeParse(exhaustedAtValue);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapterConfig.subscriptionQuotaExhaustedAt must be an ISO 8601 datetime string",
        path: ["subscriptionQuotaExhaustedAt"],
      });
    }
  }
  const exhaustedBillingTypeValue = value.subscriptionQuotaExhaustedBillingType;
  if (exhaustedBillingTypeValue !== undefined && exhaustedBillingTypeValue !== null) {
    const parsed = z.enum(["subscription_overage", "credits"]).safeParse(exhaustedBillingTypeValue);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapterConfig.subscriptionQuotaExhaustedBillingType must be \"subscription_overage\" or \"credits\"",
        path: ["subscriptionQuotaExhaustedBillingType"],
      });
    }
  }
  // DUR-213: per-run spend cap, counted in total tokens (input + output +
  // cache) across every model call in the run. 0/unset means uncapped.
  const maxTokensPerRunValue = value.maxTokensPerRun;
  if (maxTokensPerRunValue !== undefined) {
    const parsedCap = z.number().int().nonnegative().safeParse(maxTokensPerRunValue);
    if (!parsedCap.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adapterConfig.maxTokensPerRun must be a non-negative integer",
        path: ["maxTokensPerRun"],
      });
    }
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
  // DUR-68: if this agent stops handling a customer-inbox task, tickTimers'
  // customer-inbox-handoff sweep reassigns it to reportsTo after this many
  // minutes. No target field — the target is always reportsTo.
  handOffUnhandledAfterMinutes: z.number().int().positive().optional().nullable(),
}).catchall(z.unknown());

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  // DUR-61 addendum: TONE and PERSONALITY are two fields with different
  // purposes, not one field with a length slider. Tone is short and applies
  // to any agent; personality is long and only persona agents need it.
  tone: z
    .string()
    .trim()
    .max(600, "Tone is limited to 600 characters — a few sentences on how this agent speaks, not who it is.")
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .optional()
    .nullable(),
  personality: z
    .string()
    .trim()
    .max(20000, "Personality is limited to 20,000 characters — it describes who this agent is, not what it should do.")
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .optional()
    .nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().uuid().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    // Agents may not set their own (or any other agent's) picture through
    // the general PATCH route — only the dedicated avatar upload/delete
    // routes (POST/DELETE .../agents/:agentId/avatar) may write this
    // column. This does not, by itself, fix DUR-55.
    avatarAssetId: z.never().optional(),
    // DUR-114: role assignment/override fields are role-endpoint-only
    // (POST /agents/:id/role). A plain z.never() here would make Zod
    // throw and short-circuit to a generic 400 in validate() — bypassing
    // the route-level hasOwn() check below (agents.ts) that returns the
    // specific 422 "use /agents/:id/role" error. Declaring these as
    // permissive-but-known keys instead means the (non-strict) object
    // schema no longer silently strips them as "unrecognized", so they
    // survive schema.parse() into req.body and the hasOwn() guard can
    // see and reject them with 422 as intended.
    roleId: z.unknown().optional(),
    roleAppliedMcpServerNames: z.unknown().optional(),
    roleAppliedPermissionKeys: z.unknown().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    // Lane A (DUR-217) opt-in — board-settable only, enforced in
    // server/src/routes/agents.ts (assertCanManageLaneAFlag), not here.
    laneAEnabled: z.boolean().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().uuid().optional().nullable(),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
  parentIssueId: z.string().uuid().optional().nullable(),
  parentIssueIds: z.array(z.string().uuid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().uuid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().uuid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean(),
  canManageOtherAgentsPermissions: z.boolean().optional(),
  canManageCompanySettings: z.boolean().optional(),
  canManageAllWorkspaceRuntimes: z.boolean().optional(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
