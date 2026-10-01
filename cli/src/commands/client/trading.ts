import { Command } from "commander";
import { setTradingStrategyStatusSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/**
 * DUR-4171: the kill switch the UI's pause/resume button and the Telegram
 * bridge's command both call (see server/src/routes/trading.ts). The bridge
 * runs this the same way it runs `approval`/`telegram` today -- `docker exec`
 * with the operator's stored board credential -- which is why the server
 * gate here is owner/admin/instance-admin, not agent-callable.
 */

interface TradingStrategySummary {
  id: string;
  name: string;
  asset: string;
  status: string;
  pauseReason: string | null;
}

export function registerTradingCommands(program: Command): void {
  const trading = program.command("trading").description("Trading agent strategies (paper trading)");

  addCommonClientOptions(
    trading
      .command("list")
      .description("List trading strategies for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<TradingStrategySummary[]>(apiPath`/api/companies/${ctx.companyId}/trading/strategies`)) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ id: row.id, name: row.name, asset: row.asset, status: row.status, pauseReason: row.pauseReason }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    trading
      .command("status")
      .description("Set a strategy's status (the kill switch: pause or resume)")
      .argument("<strategyId>", "Trading strategy ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--status <status>", "running|paused")
      .action(async (strategyId: string, opts: BaseClientOptions & { status: string }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = setTradingStrategyStatusSchema.parse({ status: opts.status });
          const updated = await ctx.api.post<TradingStrategySummary>(
            apiPath`/api/companies/${ctx.companyId}/trading/strategies/${strategyId}/status`,
            payload,
          );
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    trading
      .command("pause-all")
      .description("Kill switch: pause every currently-running strategy for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<TradingStrategySummary[]>(apiPath`/api/companies/${ctx.companyId}/trading/strategies`)) ?? [];
          const running = rows.filter((row) => row.status === "running");
          const paused: TradingStrategySummary[] = [];
          for (const row of running) {
            const updated = await ctx.api.post<TradingStrategySummary>(
              apiPath`/api/companies/${ctx.companyId}/trading/strategies/${row.id}/status`,
              setTradingStrategyStatusSchema.parse({ status: "paused" }),
            );
            if (updated) paused.push(updated);
          }
          printOutput(paused, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    trading
      .command("dashboard")
      .description("Dashboard summary for a strategy")
      .argument("<strategyId>", "Trading strategy ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (strategyId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const summary = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/trading/strategies/${strategyId}/dashboard`);
          printOutput(summary, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
