import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/**
 * Morning report: the two calls the host-side Telegram bridge makes to
 * deliver the daily briefing.
 *
 *   morning-report outbox      the reports written and waiting to be sent,
 *                              for one company (GET /api/companies/:id/morning-report-outbox)
 *   morning-report outbox:ack  mark one as sent (or as failed), once
 *                              Telegram took it
 *                              (POST .../morning-report-outbox/:reportId/ack)
 *
 * The bridge passes the company from its bot config, never from message
 * text — same shape as `watcher outbox` / `outbox:ack`.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AckOptions extends BaseClientOptions {
  outcome?: string;
  note?: string;
}

export function registerMorningReportCommands(program: Command): void {
  const morningReport = program.command("morning-report").description("Daily briefings and their Telegram outbox");

  addCommonClientOptions(
    morningReport
      .command("outbox")
      .description("Reports that are written and waiting to be sent to Telegram, for one company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/morning-report-outbox`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    morningReport
      .command("outbox:ack")
      .description("Mark one report as sent (delivered) or as not sendable (failed)")
      .argument("<reportId>", "Report ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--outcome <outcome>", "delivered or failed", "delivered")
      .option("--note <text>", "A short plain note, e.g. why it could not be sent")
      .action(async (reportId: string, opts: AckOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (!UUID_PATTERN.test(reportId)) throw new Error("That is not a report id.");
          if (opts.outcome !== "delivered" && opts.outcome !== "failed") {
            throw new Error("--outcome must be 'delivered' or 'failed'");
          }
          const body: Record<string, unknown> = { outcome: opts.outcome };
          if (opts.note?.trim()) body.note = opts.note.trim().slice(0, 300);
          const result = await ctx.api.post(
            apiPath`/api/companies/${ctx.companyId}/morning-report-outbox/${reportId}/ack`,
            body,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
