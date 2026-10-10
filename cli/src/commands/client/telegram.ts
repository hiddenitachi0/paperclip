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
  // How the bridge picks the bot that gets the company's approvals and
  // questions when no agent's own bot should. Passed through unchanged.
  receivesCompanyNotices?: boolean;
  createdAt?: string;
  agentRole?: string | null;
  // Voice messages: when the bridge reads an answer aloud, and the voice.
  voiceReplyMode?: string;
  voice?: string | null;
  // Hermes parity slice 1: this bot answers linked people. Passed through unchanged.
  answersLinkedPeople?: boolean;
};

/**
 * Hermes parity slice 1: the bridge's calls for linked people (see
 * server/src/routes/telegram-chat.ts). The message, the code and the Telegram
 * username travel as option values the bridge fills from environment
 * variables, never as part of the command text. A refusal the server answered
 * is printed as {ok:false,status,error} and exits 0, like `chat send --json`,
 * so the bridge can tell "Paperclip said no" from "Paperclip did not answer".
 */
type PeopleOutcome = ({ ok: true } & Record<string, unknown>) | { ok: false; status: number; error: string };

async function peopleCall(
  opts: BaseClientOptions,
  call: (ctx: ReturnType<typeof resolveCommandContext>) => Promise<Record<string, unknown> | null>,
): Promise<PeopleOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  try {
    return { ok: true, ...((await call(ctx)) ?? {}) };
  } catch (err) {
    if (err instanceof ApiRequestError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
}

interface PeopleAskOptions extends BaseClientOptions {
  telegramUserId: string;
  chatId: string;
  message: string;
  fresh?: boolean;
  pictureStdin?: boolean;
}

async function readStdinText(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface PeopleLinkOptions extends BaseClientOptions {
  telegramUserId: string;
  code: string;
  telegramUsername?: string;
}

interface PeopleAckOptions extends BaseClientOptions {
  outcome: string;
}

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

  addCommonClientOptions(
    telegram
      .command("people-ask")
      .description("A linked person's question to the company bot: answered by the quick agent, or handed to the full agent. Instance admin only.")
      .argument("<botId>", "The bot the message came in on")
      .requiredOption("-C, --company-id <id>", "The bot's company")
      .requiredOption("--telegram-user-id <id>", "The sender's Telegram user id")
      .requiredOption("--chat-id <id>", "The chat the message came from")
      .requiredOption("--message <text>", "The message")
      .option("--fresh", "Start a fresh conversation with the quick agent")
      .option("--picture-stdin", "A photo sent with the message, as base64 on standard input (stored only if the person may ask)")
      .action(async (botId: string, opts: PeopleAskOptions) => {
        try {
          const pictureBase64 = opts.pictureStdin ? (await readStdinText()).replace(/\s+/g, "") : "";
          if (opts.pictureStdin && !pictureBase64) throw new Error("The picture on standard input is empty");
          const outcome = await peopleCall(opts, (ctx) =>
            ctx.api.post<Record<string, unknown>>(apiPath`/api/companies/${ctx.companyId!}/telegram-chat/ask`, {
              botId,
              telegramUserId: String(opts.telegramUserId),
              chatId: String(opts.chatId),
              message: opts.message,
              ...(opts.fresh ? { fresh: true } : {}),
              ...(pictureBase64 ? { picture: { dataBase64: pictureBase64 } } : {}),
            }),
          );
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    telegram
      .command("people-link")
      .description("Link the sender's Telegram account to the Paperclip person whose one-time code this is. Instance admin only.")
      .argument("<botId>", "The bot the code was sent to")
      .requiredOption("-C, --company-id <id>", "The bot's company")
      .requiredOption("--telegram-user-id <id>", "The sender's Telegram user id")
      .requiredOption("--code <code>", "The one-time code from the person's profile page")
      .option("--telegram-username <name>", "The sender's @username, shown on their profile page")
      .action(async (botId: string, opts: PeopleLinkOptions) => {
        try {
          const outcome = await peopleCall(opts, (ctx) =>
            ctx.api.post<Record<string, unknown>>(apiPath`/api/companies/${ctx.companyId!}/telegram-chat/link`, {
              botId,
              telegramUserId: String(opts.telegramUserId),
              code: opts.code,
              telegramUsername: opts.telegramUsername?.trim() || null,
            }),
          );
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    telegram
      .command("people-outbox")
      .description("Answers to linked people's questions that are ready to send. Instance admin only.")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const outcome = await peopleCall(opts, (ctx) =>
            ctx.api.get<Record<string, unknown>>(apiPath`/api/companies/${ctx.companyId!}/telegram-chat/outbox`),
          );
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    telegram
      .command("people-ack")
      .description("Mark one answer as sent (delivered) or not sendable (failed). Instance admin only.")
      .argument("<requestId>", "The answer's id from people-outbox")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--outcome <outcome>", "delivered or failed")
      .action(async (requestId: string, opts: PeopleAckOptions) => {
        try {
          if (opts.outcome !== "delivered" && opts.outcome !== "failed") {
            throw new Error("--outcome must be 'delivered' or 'failed'");
          }
          const outcome = await peopleCall(opts, (ctx) =>
            ctx.api.post<Record<string, unknown>>(
              apiPath`/api/companies/${ctx.companyId!}/telegram-chat/outbox/${requestId}/ack`,
              { outcome: opts.outcome },
            ),
          );
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
