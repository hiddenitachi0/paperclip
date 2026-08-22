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

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  /** DUR-61: operator-authored tone-of-voice text, board-only, never agent-writable. */
  personality?: string | null;
  avatarAssetId: string | null;
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
