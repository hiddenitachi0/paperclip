import type {
  IssueExecutionMonitorPolicy,
  IssueExecutionPolicy,
  IssueExecutionStageParticipant,
  IssueExecutionStagePrincipal,
  ModelProfileKey,
} from "@paperclipai/shared";
import { parseAssigneeValue } from "./assignees";

type StageType = "review" | "approval";

function newId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function principalKey(principal: IssueExecutionStagePrincipal | IssueExecutionStageParticipant) {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

export function principalFromSelectionValue(value: string): IssueExecutionStagePrincipal | null {
  const selection = parseAssigneeValue(value);
  if (selection.assigneeAgentId) {
    return { type: "agent", agentId: selection.assigneeAgentId, userId: null };
  }
  if (selection.assigneeUserId) {
    return { type: "user", userId: selection.assigneeUserId, agentId: null };
  }
  return null;
}

export function selectionValueFromPrincipal(principal: IssueExecutionStagePrincipal | IssueExecutionStageParticipant): string {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

export function stageParticipantValues(policy: IssueExecutionPolicy | null | undefined, stageType: StageType): string[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return stage?.participants.map((participant) => selectionValueFromPrincipal(participant)) ?? [];
}

function mergeParticipants(
  existing: IssueExecutionStageParticipant[] | undefined,
  values: string[],
): IssueExecutionStageParticipant[] {
  const existingByKey = new Map((existing ?? []).map((participant) => [principalKey(participant), participant]));
  const participants: IssueExecutionStageParticipant[] = [];
  for (const value of values) {
    const principal = principalFromSelectionValue(value);
    if (!principal) continue;
    const key = principalKey(principal);
    const previous = existingByKey.get(key);
    participants.push({
      id: previous?.id ?? newId(),
      type: principal.type,
      agentId: principal.type === "agent" ? principal.agentId ?? null : null,
      userId: principal.type === "user" ? principal.userId ?? null : null,
    });
  }
  return participants;
}

/** Params for constructing a "keep going until done" goal-condition monitor (DUR-32/DUR-48). */
export type GoalConditionMonitorInput = {
  condition: string;
  evaluatorModelProfile?: ModelProfileKey | null;
  spendCapCents?: number | null;
  maxAttempts?: number | null;
};

export function buildGoalConditionMonitor(input: GoalConditionMonitorInput): IssueExecutionMonitorPolicy | null {
  const condition = input.condition.trim();
  if (!condition) return null;
  return {
    // Ignored for dispatch (goal_condition monitors are driven by the run-finish hook, not
    // the periodic nextCheckAt sweep — see heartbeat.ts) but required by the policy schema.
    nextCheckAt: new Date().toISOString(),
    notes: null,
    scheduledBy: "board",
    kind: "goal_condition",
    condition,
    evaluatorModelProfile: input.evaluatorModelProfile ?? null,
    spendCapCents: input.spendCapCents ?? null,
    maxAttempts: input.maxAttempts ?? null,
    serviceName: null,
    externalRef: null,
  };
}

export function buildExecutionPolicy(input: {
  existingPolicy?: IssueExecutionPolicy | null;
  reviewerValues: string[];
  approverValues: string[];
  /** Explicit monitor override — omit to keep existingPolicy's monitor untouched; pass null to clear it. */
  monitor?: IssueExecutionMonitorPolicy | null;
}): IssueExecutionPolicy | null {
  const mode = input.existingPolicy?.mode ?? "normal";
  const stages: IssueExecutionPolicy["stages"] = [];
  const monitor = "monitor" in input ? (input.monitor ?? null) : (input.existingPolicy?.monitor ?? null);

  const existingReviewStage = input.existingPolicy?.stages.find((stage) => stage.type === "review");
  const reviewParticipants = mergeParticipants(existingReviewStage?.participants, input.reviewerValues);
  if (reviewParticipants.length > 0) {
    stages.push({
      id: existingReviewStage?.id ?? newId(),
      type: "review" as const,
      approvalsNeeded: 1 as const,
      participants: reviewParticipants,
    });
  }

  const existingApprovalStage = input.existingPolicy?.stages.find((stage) => stage.type === "approval");
  const approvalParticipants = mergeParticipants(existingApprovalStage?.participants, input.approverValues);
  if (approvalParticipants.length > 0) {
    stages.push({
      id: existingApprovalStage?.id ?? newId(),
      type: "approval" as const,
      approvalsNeeded: 1 as const,
      participants: approvalParticipants,
    });
  }

  if (stages.length === 0 && !monitor) return null;

  return {
    mode,
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
  };
}
