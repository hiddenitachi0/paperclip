/**
 * DUR-4072 PR1: the calculation-script runner. A "script" is a named,
 * versioned Python program the server runs with JSON in, JSON out -- never
 * the agent. See packages/shared/src/validators/report.ts for the input
 * shapes and packages/db/src/schema/report_script*.ts for storage.
 */

export const REPORT_SCRIPT_VERSION_STATUSES = ["draft", "tested", "approved", "retired"] as const;
export type ReportScriptVersionStatus = (typeof REPORT_SCRIPT_VERSION_STATUSES)[number];

export const REPORT_SCRIPT_RUN_TRIGGERS = ["fixture_test", "manual", "report_run"] as const;
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
  lockfile: string | null;
  sha256: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  status: ReportScriptVersionStatus;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
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
