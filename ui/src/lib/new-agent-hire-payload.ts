import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";
import type { AgentPermissions } from "@paperclipai/shared";

export function buildNewAgentHirePayload(input: {
  name: string;
  effectiveRole: string;
  title?: string;
  tone?: string;
  personality?: string;
  reportsTo?: string | null;
  selectedSkillKeys?: string[];
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
  permissions?: Partial<AgentPermissions>;
  /**
   * DUR-3971: "answers straight away in chat" (true) vs "goes away and works
   * on tasks" (false/omitted). Only sent when the operator picks the quick
   * lane, so a hire made without touching the choice produces exactly the
   * payload it produced before this field existed.
   */
  answersStraightAwayInChat?: boolean;
  /**
   * DUR-3976: the monthly spending limit chosen on the form, in cents. It is
   * required so that no caller can quietly send "no limit": 0 is only sent
   * when the operator ticked "No monthly limit" (see
   * resolveSpendingLimitChoice in ./hire-spending-limit).
   */
  budgetMonthlyCents: number;
}) {
  const {
    name,
    effectiveRole,
    title,
    tone,
    personality,
    reportsTo,
    selectedSkillKeys = [],
    configValues,
    adapterConfig,
    permissions,
    answersStraightAwayInChat = false,
    budgetMonthlyCents,
  } = input;

  return {
    name: name.trim(),
    role: effectiveRole,
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(tone?.trim() ? { tone: tone.trim() } : {}),
    ...(personality?.trim() ? { personality: personality.trim() } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
    adapterType: configValues.adapterType,
    defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
    adapterConfig,
    runtimeConfig: buildNewAgentRuntimeConfig({
      heartbeatEnabled: configValues.heartbeatEnabled,
      intervalSec: configValues.intervalSec,
      cheapModel: configValues.cheapModel,
      cheapModelEnabled: configValues.cheapModelEnabled,
    }),
    budgetMonthlyCents: Math.max(0, Math.round(budgetMonthlyCents)),
    ...(permissions ? { permissions } : {}),
    ...(answersStraightAwayInChat ? { laneAEnabled: true } : {}),
  };
}
