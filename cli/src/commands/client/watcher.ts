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
 * Watchers: the two calls the host-side Telegram bridge makes to deliver
 * market-price alerts.
 *
 *   watcher outbox      the alerts that are written and waiting to be sent,
 *                       for one company (GET /api/companies/:id/watcher-outbox)
 *   watcher outbox:ack  mark one as sent (or as failed), once Telegram took
 *                       it (POST .../watcher-outbox/:alertId/ack)
 *
 * The bridge passes the company from its bot config, never from message
 * text. A picture is fetched separately with `chat image`, so the bytes
 * reach Telegram without Telegram ever getting a Paperclip address.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AckOptions extends BaseClientOptions {
  outcome?: string;
  note?: string;
}

export function registerWatcherCommands(program: Command): void {
  const watcher = program.command("watcher").description("Market-price watchers and their Telegram outbox");

  addCommonClientOptions(
    watcher
      .command("outbox")
      .description("Alerts that are written and waiting to be sent to Telegram, for one company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/watcher-outbox`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    watcher
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
            apiPath`/api/companies/${ctx.companyId}/watcher-outbox/${alertId}/ack`,
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
