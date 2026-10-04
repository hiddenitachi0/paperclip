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
 * DUR-4499: `disk-health` reads the instance disk report
 * (GET /api/instance/disk-health). The host-side Telegram bridge calls it to
 * warn the operator at 80% / 90% full. Read-only.
 */
export function registerDiskHealthCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("disk-health")
      .description("Disk usage of the data volume and its biggest folders")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/instance/disk-health`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
