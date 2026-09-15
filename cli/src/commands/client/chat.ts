import { Command } from "commander";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/**
 * DUR-3978: the two calls the Telegram bridge needs to hold a conversation.
 *
 *   chat send     one message through the same chat router the web chat uses
 *                 (POST /api/chat/:agentId/messages): a quick answer comes
 *                 straight back, real work becomes a task.
 *   chat answers  the agent's latest answer for tasks started from a chat
 *                 (GET /api/companies/:companyId/issue-answers).
 *
 * Both take the company as an explicit --company-id. The bridge passes the
 * company from its bot config, never from message text.
 *
 * `chat send --json` prints an outcome object in every case the server
 * answered, including a refusal: `{ "ok": false, "status", "code", "error" }`.
 * A refusal is data for the caller (an expired conversation means "start a new
 * one"; a daily limit means "hand it over as a task"), not a crash, so it exits
 * 0. Without --json a refusal is reported like any other command error.
 */

interface ChatSendOptions extends BaseClientOptions {
  message: string;
  conversationId?: string;
  lane?: string;
}

export type ChatSendOutcome =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; status: number; code: string | null; error: string };

export function registerChatCommands(program: Command): void {
  const chat = program.command("chat").description("Chat with an agent the way the chat box does");

  addCommonClientOptions(
    chat
      .command("send")
      .description(
        "Send one chat message to an agent: a quick question is answered right away when the agent has quick answers on, real work becomes a task. With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--message <text>", "The message")
      .option("--conversation-id <id>", "Continue this quick-answer conversation")
      .option("--lane <lane>", "Force 'a' (quick answer) or 'b' (task) instead of letting the router decide")
      .action(async (agentId: string, opts: ChatSendOptions) => {
        try {
          const outcome = await runChatSend(agentId, opts);
          if (!outcome.ok && !opts.json) {
            throw new ApiRequestError(outcome.status, outcome.error);
          }
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    chat
      .command("answers")
      .description("Status and the agent's latest answer for tasks in one company (at most 50 ids)")
      .argument("<issueIds...>", "Task IDs")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (issueIds: string[], opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const ids = issueIds.flatMap((id) => id.split(",")).map((id) => id.trim()).filter(Boolean);
          if (ids.length === 0) throw new Error("At least one task id is required");
          const query = new URLSearchParams({ ids: ids.join(",") });
          const result = await ctx.api.get(
            `${apiPath`/api/companies/${ctx.companyId}/issue-answers`}?${query.toString()}`,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

export async function runChatSend(agentId: string, opts: ChatSendOptions): Promise<ChatSendOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const message = opts.message?.trim();
  if (!message) throw new Error("--message is required");
  if (opts.lane !== undefined && opts.lane !== "a" && opts.lane !== "b") {
    throw new Error("--lane must be 'a' or 'b'");
  }

  const body: Record<string, unknown> = { companyId: ctx.companyId, message };
  if (opts.conversationId?.trim()) body.conversationId = opts.conversationId.trim();
  if (opts.lane) body.laneHint = opts.lane;

  try {
    const result = await ctx.api.post<Record<string, unknown>>(apiPath`/api/chat/${agentId}/messages`, body);
    return { ok: true, ...(result ?? {}) };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      return { ok: false, status: err.status, code: refusalCode(err), error: err.message };
    }
    throw err;
  }
}

function refusalCode(err: ApiRequestError): string | null {
  const body = err.body && typeof err.body === "object" ? (err.body as Record<string, unknown>) : null;
  if (typeof body?.code === "string") return body.code;
  const details = err.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : null;
  if (typeof details?.code === "string") return details.code;
  if (typeof details?.reason === "string") return details.reason;
  return null;
}
