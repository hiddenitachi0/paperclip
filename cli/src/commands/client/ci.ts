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
 * DUR-5183: `ci status` reads the checks of one version of a project's deploy repository
 * (GET /api/companies/:companyId/projects/:projectId/ci-status) through the server, which
 * holds the company's GitHub access. A box that only has a read-only deploy key can use it
 * to wait for green before filing a deploy card.
 *
 * Exit code: 0 green (or no checks set up at all), 2 pending, 1 failed (or any error),
 * 3 could not be told (GitHub unreachable), so a script can loop on it.
 */

interface CiStatusOptions extends BaseClientOptions {
  companyId?: string;
  project: string;
  sha: string;
}

interface CiStatusResponse {
  state: "green" | "pending" | "failed" | "none" | "unknown";
  failedChecks: string[];
  pendingChecks: string[];
  sha: string;
  repo: string;
}

export function describeCiStatus(status: CiStatusResponse): { text: string; exitCode: number } {
  switch (status.state) {
    case "green":
      return { text: "green", exitCode: 0 };
    case "none":
      return { text: "green (this repository has no checks for that version)", exitCode: 0 };
    case "pending": {
      const count = status.pendingChecks.length;
      const names = count > 0 ? `: ${status.pendingChecks.join(", ")}` : "";
      const noun = count === 1 ? "check" : "checks";
      return { text: `pending (${count} ${noun} still running${names})`, exitCode: 2 };
    }
    case "failed":
      return { text: `failed: ${status.failedChecks.join(", ") || "a check failed"}`, exitCode: 1 };
    default:
      return { text: "unknown (GitHub could not be asked, try again)", exitCode: 3 };
  }
}

export function registerCiCommands(program: Command): void {
  const ci = program.command("ci").description("Check status of a version of a project's code");

  addCommonClientOptions(
    ci
      .command("status")
      .description("Are the checks of this version green? Exit code 0 green, 2 pending, 1 failed, 3 unknown")
      .requiredOption("--project <id>", "Project ID")
      .requiredOption("--sha <sha>", "Commit id (7 to 40 hex characters)")
      .action(async (opts: CiStatusOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ sha: opts.sha });
          const status = await ctx.api.get<CiStatusResponse>(
            `${apiPath`/api/companies/${ctx.companyId}/projects/${opts.project}/ci-status`}?${query.toString()}`,
          );
          if (!status) throw new Error("The server returned no answer.");
          const { text, exitCode } = describeCiStatus(status);
          if (ctx.json) printOutput(status, { json: true });
          else console.log(text);
          process.exitCode = exitCode;
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
