import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";
import type { AgentLimits, AgentPermissions } from "@paperclipai/shared";
import { hasAnyAgentLimit } from "./agent-limits";

export function buildNewAgentHirePayload(input: {
  name: string;
  effectiveRole: string;
  title?: string;
  tone?: string;
  personality?: string;
  /**
   * DUR-4000: the person doing this job (personas.id). Only sent when picked;
   * while a persona is attached the personality text is not sent at all, so
   * nothing is said twice at prompt time.
   */
  personaId?: string | null;
  /** DUR-4000: the job's own limits box. Only sent when at least one limit is set. */
  limits?: AgentLimits | null;
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
    personaId,
    limits,
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
    ...(!personaId && personality?.trim() ? { personality: personality.trim() } : {}),
    ...(personaId ? { personaId } : {}),
    ...(hasAnyAgentLimit(limits) ? { limits: limits! } : {}),
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
