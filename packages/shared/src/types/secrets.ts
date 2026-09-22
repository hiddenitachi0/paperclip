import type {
  SecretAccessOutcome,
  SecretBindingTargetType,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigHealthStatus,
  SecretProviderConfigStatus,
  SecretStatus,
  SecretVersionStatus,
} from "../constants.js";
import type { SecretKind } from "../secret-kinds.js";

export type {
  SecretAccessOutcome,
  SecretBindingTargetType,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigHealthStatus,
  SecretProviderConfigStatus,
  SecretStatus,
  SecretVersionStatus,
};

export type SecretVersionSelector = number | "latest";

export interface EnvPlainBinding {
  type: "plain";
  value: string;
}

export interface EnvSecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: SecretVersionSelector;
}

// Backward-compatible: legacy plaintext string values are still accepted.
export type EnvBinding = string | EnvPlainBinding | EnvSecretRefBinding;

export type AgentEnvConfig = Record<string, EnvBinding>;

export interface CompanySecret {
  id: string;
  companyId: string;
  key: string;
  name: string;
  provider: SecretProvider;
  status: SecretStatus;
  managedMode: SecretManagedMode;
  externalRef: string | null;
  providerConfigId: string | null;
  providerMetadata: Record<string, unknown> | null;
  latestVersion: number;
  description: string | null;
  /**
   * DUR-3997: what the value is (an OpenAI key, a Fiken token…). Null for
   * secrets saved before kinds existed, or when the operator chose nothing.
   * See packages/shared/src/secret-kinds.ts.
   */
  kind: SecretKind | null;
  /** DUR-3997: outcome of the last Test, for kinds Paperclip can test. */
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastResolvedAt: Date | null;
  lastRotatedAt: Date | null;
  deletedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  referenceCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What POST /companies/:companyId/secrets/:id/test answers. `message` is one
 * plain sentence and never contains the value. `secret` is the row after the
 * outcome was recorded on it.
 */
export interface CompanySecretTestResult {
  ok: boolean;
  message: string;
  secret: CompanySecret;
}

export interface SecretProviderDescriptor {
  id: SecretProvider;
  label: string;
  requiresExternalRef: boolean;
  supportsManagedValues?: boolean;
  supportsExternalReferences?: boolean;
  configured?: boolean;
}

export interface LocalEncryptedProviderConfig {
  backupReminderAcknowledged?: boolean;
}

export interface AwsSecretsManagerProviderConfig {
  region: string;
  namespace?: string | null;
  secretNamePrefix?: string | null;
  kmsKeyId?: string | null;
  ownerTag?: string | null;
  environmentTag?: string | null;
}

export interface GcpSecretManagerProviderConfig {
  projectId?: string | null;
  location?: string | null;
  namespace?: string | null;
  secretNamePrefix?: string | null;
}

export interface VaultProviderConfig {
  address?: string | null;
  namespace?: string | null;
  mountPath?: string | null;
  secretPathPrefix?: string | null;
}

export type SecretProviderConfigPayload =
  | LocalEncryptedProviderConfig
  | AwsSecretsManagerProviderConfig
  | GcpSecretManagerProviderConfig
  | VaultProviderConfig;

export interface SecretProviderConfigHealthDetails {
  code: string;
  message: string;
  missingFields?: string[];
  guidance?: string[];
}

export interface CompanySecretProviderConfig {
  id: string;
  companyId: string;
  provider: SecretProvider;
  displayName: string;
  status: SecretProviderConfigStatus;
  isDefault: boolean;
  config: SecretProviderConfigPayload;
  healthStatus: SecretProviderConfigHealthStatus | null;
  healthCheckedAt: Date | null;
  healthMessage: string | null;
  healthDetails: SecretProviderConfigHealthDetails | null;
  disabledAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretProviderConfigHealthResponse {
  configId: string;
  provider: SecretProvider;
  status: SecretProviderConfigHealthStatus;
  message: string;
  details: SecretProviderConfigHealthDetails;
  checkedAt: Date;
}

export interface SecretProviderConfigDiscoverySignal {
  namespace: string | null;
  secretNamePrefix: string | null;
  environmentTag: string | null;
  ownerTag: string | null;
  kmsKeyId: string | null;
  hasKmsKey: boolean;
  sampleCount: number;
  paperclipManagedSampleCount: number;
  skippedForeignPaperclipSampleCount: number;
}

export interface SecretProviderConfigDiscoverySample {
  name: string;
  hasKmsKey: boolean;
  tagKeys: string[];
}

export interface SecretProviderConfigDiscoveryCandidate {
  provider: SecretProvider;
  displayName: string;
  config: SecretProviderConfigPayload;
  sampleCount: number;
  samples: SecretProviderConfigDiscoverySample[];
  signals: SecretProviderConfigDiscoverySignal;
  warnings: string[];
}

export interface SecretProviderConfigDiscoveryPreviewResult {
  provider: SecretProvider;
  nextToken: string | null;
  sampledSecretCount: number;
  skippedForeignPaperclipSampleCount: number;
  candidates: SecretProviderConfigDiscoveryCandidate[];
  warnings: string[];
}

export interface CompanySecretVersion {
  id: string;
  secretId: string;
  version: number;
  providerVersionRef: string | null;
  status: SecretVersionStatus;
  fingerprintSha256: string;
  rotationJobId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CompanySecretBinding {
  id: string;
  companyId: string;
  secretId: string;
  targetType: SecretBindingTargetType;
  targetId: string;
  configPath: string;
  versionSelector: SecretVersionSelector;
  required: boolean;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySecretBindingTarget {
  type: SecretBindingTargetType;
  id: string;
  label: string;
  href: string | null;
  status: string | null;
}

export interface CompanySecretUsageBinding extends CompanySecretBinding {
  target: CompanySecretBindingTarget;
}

export interface SecretAccessEvent {
  id: string;
  companyId: string;
  secretId: string;
  version: number | null;
  provider: SecretProvider;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string | null;
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  pluginId: string | null;
  outcome: SecretAccessOutcome;
  errorCode: string | null;
  createdAt: Date;
}

export type RemoteSecretImportCandidateStatus = "ready" | "duplicate" | "conflict";

export interface RemoteSecretImportConflict {
  type: "exact_reference" | "name" | "key" | "provider_guardrail";
  message: string;
  existingSecretId?: string;
}

export interface RemoteSecretImportCandidate {
  externalRef: string;
  remoteName: string;
  name: string;
  key: string;
  providerVersionRef: string | null;
  providerMetadata: Record<string, unknown> | null;
  status: RemoteSecretImportCandidateStatus;
  importable: boolean;
  conflicts: RemoteSecretImportConflict[];
}

export interface RemoteSecretImportPreviewResult {
  providerConfigId: string;
  provider: SecretProvider;
  nextToken: string | null;
  candidates: RemoteSecretImportCandidate[];
}

export type RemoteSecretImportRowStatus = "imported" | "skipped" | "error";

export interface RemoteSecretImportRowResult {
  externalRef: string;
  name: string;
  key: string;
  status: RemoteSecretImportRowStatus;
  reason: string | null;
  secretId: string | null;
  conflicts: RemoteSecretImportConflict[];
}

export interface RemoteSecretImportResult {
  providerConfigId: string;
  provider: SecretProvider;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  results: RemoteSecretImportRowResult[];
}
