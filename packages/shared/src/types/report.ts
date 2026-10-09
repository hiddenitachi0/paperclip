/**
 * DUR-4072 PR1: the calculation-script runner. A "script" is a named,
 * versioned Python program the server runs with JSON in, JSON out -- never
 * the agent. See packages/shared/src/validators/report.ts for the input
 * shapes and packages/db/src/schema/report_script*.ts for storage.
 */

export const REPORT_SCRIPT_VERSION_STATUSES = ["draft", "awaiting_approval", "approved", "retired"] as const;
export type ReportScriptVersionStatus = (typeof REPORT_SCRIPT_VERSION_STATUSES)[number];

export const REPORT_SCRIPT_RUN_TRIGGERS = ["fixture_test", "approval_check", "report_run"] as const;
export type ReportScriptRunTrigger = (typeof REPORT_SCRIPT_RUN_TRIGGERS)[number];

export const REPORT_SCRIPT_RUN_STATUSES = ["running", "succeeded", "failed", "timeout", "fingerprint_mismatch"] as const;
export type ReportScriptRunStatus = (typeof REPORT_SCRIPT_RUN_STATUSES)[number];

export interface ReportScript {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportScriptVersion {
  id: string;
  companyId: string;
  scriptId: string;
  versionNo: number;
  files: Record<string, string>;
  entrypoint: string;
  sha256: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  status: ReportScriptVersionStatus;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  /** The approval card showing this version's full source, once one was filed. */
  approvalId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ReportFixture {
  id: string;
  companyId: string;
  scriptVersionId: string;
  name: string;
  input: unknown;
  expectedOutput: unknown;
  tolerance: number;
  createdAt: string;
}

export interface ReportFixtureDiff {
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface ReportFixtureCheckResult {
  ok: boolean;
  tolerance: number;
  diffs: ReportFixtureDiff[];
}

export interface ReportScriptRun {
  id: string;
  companyId: string;
  scriptVersionId: string;
  fixtureId: string | null;
  trigger: ReportScriptRunTrigger;
  input: unknown;
  inputSha256: string;
  output: unknown;
  outputSha256: string | null;
  scriptSha256: string;
  runtimeFingerprint: string | null;
  status: ReportScriptRunStatus;
  durationMs: number | null;
  error: string | null;
  fixtureResult: ReportFixtureCheckResult | null;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * DUR-4072 PR2: report templates and report runs. A run is an ordinary
 * task: fetch data -> run the template's pinned, approved script -> numbers
 * JSON -> agent commentary (checked against the numbers, never calculated)
 * -> a report document with revisions. See validators/report.ts for input
 * shapes and packages/db/src/schema/report_templates.ts /
 * report_runs.ts for storage.
 */

export const REPORT_RUN_STATUSES = [
  "fetching_data",
  "calculating",
  "drafting_commentary",
  "needs_revision",
  "ready",
  "failed",
] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

export interface ReportTemplate {
  id: string;
  companyId: string;
  key: string;
  name: string;
  instructions: string;
  layout: Record<string, unknown>;
  dataConnectionId: string | null;
  scriptVersionId: string;
  isActive: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRun {
  id: string;
  companyId: string;
  templateId: string;
  status: ReportRunStatus;
  fetchedData: unknown;
  scriptRunId: string | null;
  numbers: unknown;
  commentaryText: string | null;
  ungroundedNumbers: string[];
  documentId: string | null;
  error: string | null;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** One fixture's outcome as the owner's approve action recorded it on the approval card. */
export interface ReportScriptApprovalFixtureResult {
  fixtureId: string;
  fixtureName: string;
  runId: string | null;
  status: ReportScriptRunStatus;
  ok: boolean;
  /** Plain-language outcome, e.g. "Matched every number" or "3 numbers differ". */
  summary: string;
  error: string | null;
  diffs: ReportFixtureDiff[];
}

/** What the owner's approve action answers: approved only if every fixture passed. */
export interface ReportScriptApprovalOutcome {
  approved: boolean;
  version: ReportScriptVersion;
  fixtureResults: ReportScriptApprovalFixtureResult[];
  /** Plain-language reason when not approved. */
  message: string | null;
}
