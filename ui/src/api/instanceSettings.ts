import type {
  DoneGateStatus,
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  InstanceSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
  QuietModeState,
} from "@paperclipai/shared";
import { api } from "./client";

export type QuietModeStatus = QuietModeState & { activeRunCount: number };

export interface MaxTurnsPerRunAgentOverride {
  agentId: string;
  agentName: string;
  companyId: string;
  adapterType: string;
  maxTurnsPerRun: number;
}

export const instanceSettingsApi = {
  // DUR-3943 item 4: agents whose own "max turns per run" wins over the instance setting.
  listMaxTurnsAgentOverrides: () =>
    api.get<{ agentCount: number; agents: MaxTurnsPerRunAgentOverride[] }>(
      "/instance/settings/general/max-turns-per-run/agent-overrides",
    ),
  clearMaxTurnsAgentOverrides: () =>
    api.post<{ clearedAgentCount: number }>(
      "/instance/settings/general/max-turns-per-run/clear-agent-overrides",
      undefined,
    ),
  // DUR-3968: the quality check's saved mode plus whether the reviewer can be
  // reached at all, so "on but unable to run" never looks like "on".
  getDoneGateStatus: () =>
    api.get<DoneGateStatus>("/instance/settings/general/done-gate/status"),
  get: () =>
    api.get<InstanceSettings>("/instance/settings"),
  update: (patch: PatchInstanceSettings) =>
    api.patch<InstanceSettings>("/instance/settings", patch),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  getQuietMode: () =>
    api.get<QuietModeStatus>("/instance/settings/quiet-mode"),
  activateQuietMode: () =>
    api.post<QuietModeStatus>("/instance/settings/quiet-mode/activate", undefined),
  deactivateQuietMode: () =>
    api.post<QuietModeStatus>("/instance/settings/quiet-mode/deactivate", undefined),
  previewIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<IssueGraphLivenessAutoRecoveryPreview>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
      input,
    ),
  runIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<{
      findings: number;
      autoRecoveryEnabled: boolean;
      lookbackHours: number;
      cutoff: string;
      escalationsCreated: number;
      existingEscalations: number;
      skipped: number;
      skippedAutoRecoveryDisabled: number;
      skippedOutsideLookback: number;
      dependencyWakeBackstopChecked: number;
      dependencyWakesHealed: number;
      dependencyWakeExistingSkipped: number;
      dependencyWakeLivePathSkipped: number;
      dependencyWakeInteractionSkipped: number;
      dependencyWakePauseHoldSkipped: number;
      dependencyWakeNotReadySkipped: number;
      dependencyWakeCandidateLimitSkipped: number;
      dependencyWakeDeferredOrFailed: number;
      dependencyWakeEnqueueFailed: number;
      dependencyWakeIssueIds: string[];
      escalationIssueIds: string[];
    }>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
      input,
    ),
};
