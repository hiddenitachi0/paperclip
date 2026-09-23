import type {
  AgentAdapterType,
  ModelProfileKey,
  PauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";
import type {
  TrustAuthorizationPolicy,
  TrustPreset,
} from "../trust-policy.js";
import type { AgentOrgChainHealth } from "../agent-eligibility.js";
import type { AgentApiKeyScope } from "../validators/agent.js";

export interface AgentPermissions extends Record<string, unknown> {
  canCreateAgents: boolean;
  canCreateSkills?: boolean;
  trustPreset?: TrustPreset;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  // "ceo_role" was a distinct source for the old `role === "ceo"` bypass in
  // buildAgentAccessState (server/src/routes/agents.ts). A "ceo" agent still
  // gets canAssignTasks by default, but now via the same `agent_creator`
  // path any agent with an explicit canCreateAgents grant takes.
  taskAssignSource: "simple_default" | "explicit_grant" | "agent_creator" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

/**
 * DUR-4000: the person attached to a job, as the agent API carries it. Just
 * enough to render "Sales agent 1 (Maja)" and the picture; the full persona
 * lives at /personas/:id.
 */
export interface AgentPersonaSummary {
  id: string;
  displayName: string;
  pronouns: string | null;
  avatarAssetId: string | null;
}

/**
 * DUR-4000: agents.limits. `dailyImageGenerations` is enforced in code;
 * `dailyPosts`, `dailyRuns` and `notes` are stored and shown as guidance
 * until code enforces them (see agentLimitsSchema in validators/agent.ts).
 */
export interface AgentLimits {
  dailyImageGenerations?: number | null;
  dailyPosts?: number | null;
  dailyRuns?: number | null;
  notes?: string | null;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  /** DUR-61 addendum: operator-authored short tone-of-voice text, board-only, never agent-writable. */
  tone?: string | null;
  /** DUR-61 addendum: operator-authored long backstory/persona text, board-only, never agent-writable. Ignored at prompt time while a persona is attached. */
  personality?: string | null;
  avatarAssetId: string | null;
  /** DUR-4000: which person does this job (personas.id), or null for a blank job. Board-only. */
  personaId?: string | null;
  /** DUR-4000: the attached person, joined in by the server for list/detail; null when none, absent on lighter shapes. */
  persona?: AgentPersonaSummary | null;
  /** DUR-4000: the job's own limits box. Board-only. */
  limits?: AgentLimits;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  defaultEnvironmentId?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  errorReason?: string | null;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  orgChainHealth?: AgentOrgChainHealth;
  /** Quick agent (Lane A) switch: answers directly in chat instead of running as a full agent. Board-only. */
  laneAEnabled?: boolean;
  /** Quick agent instruction set (persona + rules). Board-only, null = none. */
  laneAInstructions?: string | null;
  /** DUR-3977 quick-agent settings. Null on all three = platform default. */
  laneAModel?: string | null;
  laneAMaxOutputTokens?: number | null;
  laneATransformDailyCallCap?: number | null;
  /** DUR-3997: anthropic | openai | google | openrouter | local. Null = Claude via Paperclip's own key. */
  laneAProvider?: string | null;
  /** DUR-3997: OpenAI-compatible endpoint for OpenRouter / local. Null = the provider's default. */
  laneABaseUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Beside AgentIconPicker's getAgentIcon (ui/src/lib/agent-icons.ts), which
// falls back to `icon`/symbol when there is no uploaded picture: the content
// path for an agent's uploaded avatar, or null when it should fall back to
// its icon/symbol.
export function agentAvatarUrl(agent: Pick<Agent, "avatarAssetId">): string | null {
  return agent.avatarAssetId ? `/api/assets/${agent.avatarAssetId}/content` : null;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export type ClearAgentErrorResponse = Agent;

export interface AgentKeyCreated {
  id: string;
  name: string;
  scope: AgentApiKeyScope;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
