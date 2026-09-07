import { Command } from "commander";
import {
  APPROVAL_TYPES,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  withdrawApprovalSchema,
  type Approval,
  type ApprovalComment,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ApprovalListOptions extends BaseClientOptions {
  companyId?: string;
  status?: string;
}

interface ApprovalDecisionOptions extends BaseClientOptions {
  decisionNote?: string;
  decidedByUserId?: string;
}

interface ApprovalCreateOptions extends BaseClientOptions {
  companyId?: string;
  type: string;
  requestedByAgentId?: string;
  payload: string;
  issueIds?: string;
}

interface ApprovalResubmitOptions extends BaseClientOptions {
  payload?: string;
}

interface ApprovalCommentOptions extends BaseClientOptions {
  body: string;
}

// Shown under `approval create --help`. request_board_approval is the type
// the deploy runner and the other request_board_approval kinds hang off, and
// it was missing from the type list entirely, so agents guessed.
const APPROVAL_CREATE_HELP = `
Examples:
  Ask the board to deploy a commit (the deploy runner acts on kind "deploy" once approved):
    paperclipai approval create -C <companyId> --type request_board_approval --payload '{
      "kind": "deploy",
      "projectId": "<projectId>",
      "workspaceId": "<the project's deploy workspaceId>",
      "commit": "<full or 12-char sha on the project's deploy branch>",
      "title": "Deploy fix for the login page",
      "note": "Approving puts commit abc123 live. It fixes the sign-in error reported this morning."
    }'

  Roll production back to an older version (board only -- an agent gets a 403):
    add "allowBackwardDeploy": true to the deploy payload above, pointing "commit" at the
    older version. The project page's "Roll back to previous version" button does this for you.

Notes:
  - Only kind "deploy" is deployed. "deploy_pr", "release", "rollout" and similar are refused.
  - Write "title" and "note" for a person: what it does, and what happens if approved.
`;

export function registerApprovalCommands(program: Command): void {
  const approval = program.command("approval").description("Approval operations");

  addCommonClientOptions(
    approval
      .command("list")
      .description("List approvals for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--status <status>", "Status filter")
      .action(async (opts: ApprovalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          const query = params.toString();
          const rows =
            (await ctx.api.get<Approval[]>(
              `${apiPath`/api/companies/${ctx.companyId}/approvals`}${query ? `?${query}` : ""}`,
            )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                type: row.type,
                status: row.status,
                requestedByAgentId: row.requestedByAgentId,
                requestedByUserId: row.requestedByUserId,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    approval
      .command("get")
      .description("Get one approval")
      .argument("<approvalId>", "Approval ID")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Approval>(apiPath`/api/approvals/${approvalId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("issues")
      .description("List issues linked to an approval")
      .argument("<approvalId>", "Approval ID")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issues = await ctx.api.get(apiPath`/api/approvals/${approvalId}/issues`);
          printOutput(issues, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("create")
      .description("Create an approval request")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--type <type>", `Approval type (${APPROVAL_TYPES.join("|")})`)
      .requiredOption("--payload <json>", "Approval payload as JSON object")
      .option("--requested-by-agent-id <id>", "Requesting agent ID")
      .option("--issue-ids <csv>", "Comma-separated linked issue IDs")
      .addHelpText("after", APPROVAL_CREATE_HELP)
      .action(async (opts: ApprovalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payloadJson = parseJsonObject(opts.payload, "payload");
          const payload = createApprovalSchema.parse({
            type: opts.type,
            payload: payloadJson,
            requestedByAgentId: opts.requestedByAgentId,
            issueIds: parseCsv(opts.issueIds),
          });
          const created = await ctx.api.post<Approval>(apiPath`/api/companies/${ctx.companyId}/approvals`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    approval
      .command("approve")
      .description("Approve an approval request")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .option("--decided-by-user-id <id>", "Decision actor user ID")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveApprovalSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/approve`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("reject")
      .description("Reject an approval request")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .option("--decided-by-user-id <id>", "Decision actor user ID")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveApprovalSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/reject`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("request-revision")
      .description("Request revision for an approval")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .option("--decided-by-user-id <id>", "Decision actor user ID")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = requestApprovalRevisionSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/request-revision`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("resubmit")
      .description("Resubmit an approval (optionally with new payload)")
      .argument("<approvalId>", "Approval ID")
      .option("--payload <json>", "Payload JSON object")
      .action(async (approvalId: string, opts: ApprovalResubmitOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resubmitApprovalSchema.parse({
            payload: opts.payload ? parseJsonObject(opts.payload, "payload") : undefined,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/resubmit`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("withdraw")
      .description("Withdraw your own not-yet-decided approval request (e.g. a stale duplicate)")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = withdrawApprovalSchema.parse({
            decisionNote: opts.decisionNote,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/withdraw`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("comment")
      .description("Add comment to an approval")
      .argument("<approvalId>", "Approval ID")
      .requiredOption("--body <text>", "Comment body")
      .action(async (approvalId: string, opts: ApprovalCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const created = await ctx.api.post<ApprovalComment>(apiPath`/api/approvals/${approvalId}/comments`, {
            body: opts.body,
          });
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const rows = value.split(",").map((v) => v.trim()).filter(Boolean);
  return rows.length > 0 ? rows : undefined;
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${name} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid ${name} JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
