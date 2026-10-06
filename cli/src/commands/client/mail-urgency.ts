import type { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/**
 * Telegram-bridge side of the urgent-mail outbox (DUR-4573), a mirror of the
 * watcher outbox commands. The bridge passes the company from its bot
 * config, never from message text. Alert text never contains a mail body.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AckOptions extends BaseClientOptions {
  outcome?: string;
  note?: string;
}

export function registerMailUrgencyCommands(program: Command): void {
  const mail = program.command("mail-urgency").description("Urgent-mail Telegram outbox");

  addCommonClientOptions(
    mail
      .command("outbox")
      .description("Urgent-mail alerts waiting to be sent to Telegram, for one company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/mail-urgency-outbox`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    mail
      .command("outbox:ack")
      .description("Mark one alert as sent (delivered) or as not sendable (failed)")
      .argument("<alertId>", "Alert ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--outcome <outcome>", "delivered or failed", "delivered")
      .option("--note <text>", "A short plain note, e.g. why it could not be sent")
      .action(async (alertId: string, opts: AckOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (!UUID_PATTERN.test(alertId)) throw new Error("That is not an alert id.");
          if (opts.outcome !== "delivered" && opts.outcome !== "failed") {
            throw new Error("--outcome must be 'delivered' or 'failed'");
          }
          const body: Record<string, unknown> = { outcome: opts.outcome };
          if (opts.note?.trim()) body.note = opts.note.trim().slice(0, 300);
          const result = await ctx.api.post(
            apiPath`/api/companies/${ctx.companyId}/mail-urgency-outbox/${alertId}/ack`,
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
