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
 * DUR-3978 slice 2: the one call the host-side Telegram bridge makes to learn
 * which bots it should be running.
 *
 * The bridge does not talk to the API over the network — it runs `docker exec`
 * into the container and calls this command, exactly as it already does for
 * approvals and tasks. So the credential this uses is the operator's stored
 * board credential that is already on the box, and the server-side gate is
 * instance-admin (see server/src/routes/telegram-bots.ts for why that gate and
 * not a shared bridge secret).
 *
 * Two server calls, on purpose: the roster carries no token at all, and each
 * token is fetched one bot at a time from a separate instance-admin-only
 * route. A bot whose token cannot be read is skipped rather than failing the
 * whole call — one broken bot must not take the others off the air.
 */

type BridgeRosterBot = {
  id: string;
  agentId: string;
  name: string;
  companyId: string;
  uiBase: string | null;
  allowedUserIds: string[];
};

export function registerTelegramCommands(program: Command): void {
  const telegram = program
    .command("telegram")
    .description("Telegram bots connected in Paperclip");

  addCommonClientOptions(
    telegram
      .command("bridge-config")
      .description(
        "Every enabled Telegram bot on this instance, with the token each one needs. Instance admin only.",
      )
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const roster = await ctx.api.get<{ bots?: BridgeRosterBot[] }>(
            apiPath`/api/instance/telegram-bridge-config`,
          );
          const bots: Array<BridgeRosterBot & { token: string }> = [];
          for (const bot of roster?.bots ?? []) {
            try {
              const resolved = await ctx.api.get<{ token?: string }>(
                apiPath`/api/companies/${bot.companyId}/telegram-bots/${bot.id}/bridge-token`,
              );
              if (typeof resolved?.token === "string" && resolved.token) {
                bots.push({ ...bot, token: resolved.token });
              }
            } catch {
              // Skip this one bot. Never print the reason: the failing request
              // URL carries the bot id and the response may quote the
              // credential store.
            }
          }
          printOutput({ bots }, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
