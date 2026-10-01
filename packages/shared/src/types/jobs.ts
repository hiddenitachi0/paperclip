import type { JobRunMode, JobStatus, JobTriggerKind, JobVariableType } from "../constants.js";

export type JobVariableDefaultValue = string | number | boolean | null;

export interface JobVariable {
  name: string;
  label: string | null;
  type: JobVariableType;
  defaultValue: JobVariableDefaultValue;
  required: boolean;
  options: string[];
}

export interface JobPositionSummary {
  id: string;
  name: string;
  key: string;
}

export interface Job {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  title: string;
  instructions: string | null;
  status: JobStatus;
  variables: JobVariable[];
  runMode: JobRunMode;
  modelProfile: string | null;
  effort: string | null;
  outputFormat: string | null;
  requiresApproval: boolean;
  isBuiltin: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobDetail extends Job {
  positions: JobPositionSummary[];
  triggers: JobTrigger[];
}

export interface JobListItem extends Job {
  positions: JobPositionSummary[];
}

export interface JobTrigger {
  id: string;
  companyId: string;
  jobId: string;
  kind: JobTriggerKind;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  publicId: string | null;
  signingMode: string | null;
  replayWindowSec: number | null;
  emailMatchAddress: string | null;
  lastResult: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobRun {
  id: string;
  companyId: string;
  jobId: string;
  triggerId: string | null;
  runAgentId: string;
  source: string;
  status: string;
  formValues: Record<string, unknown>;
  linkedIssueId: string | null;
  idempotencyKey: string | null;
  failureReason: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  triggeredAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
