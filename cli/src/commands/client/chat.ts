import { Command } from "commander";
import { CHAT_ATTACHMENTS_MAX, CHAT_PHOTO_MAX_BYTES, chatPhotoFilename, sniffChatPhotoType } from "@paperclipai/shared";
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
 *   chat attach   store a photo someone sent (base64 on standard input) in the
 *                 company's Files under a "chat-photo-" name
 *                 (POST /api/companies/:companyId/files); `chat send
 *                 --attachment <fileId>` then hands it to the agent.
 *   chat image    the bytes of a picture a quick agent's reply carried
 *                 (GET /api/attachments/:id/content), base64 in JSON, so the
 *                 bridge can upload it to Telegram without handing Telegram
 *                 a private Paperclip address.
 *   chat media    DUR-4062: the same, but for a Media Studio video or audio
 *                 file (image/*, video/* or audio/* — not JUST a picture),
 *                 up to a larger byte limit (video files are bigger).
 *
 *   chat continue start a new quick-agent conversation that carries the relevant
 *                 part of this person's recent chat with the agent
 *                 (POST /api/lane-a/:agentId/continue); Telegram `/cont`.
 *   chat memory   the agent's memory notebook (GET /api/agents/:agentId/memories);
 *                 Telegram `/memory`.
 *   chat looks    Media Studio's saved looks through the agent's ticked "List
 *                 saved looks" tool (GET /api/lane-a/:agentId/looks); Telegram
 *                 `/looks`.
 *
 * All take the company as an explicit --company-id. The bridge passes the
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
  attachment?: string[];
}

interface ChatAttachOptions extends BaseClientOptions {
  stdin?: boolean;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

interface ChatReactionOptions extends BaseClientOptions {
  event: string;
  /** DUR-4345: the event is the answer to the one follow-up question about a disliked picture. */
  followUpAnswer?: boolean;
}

interface ChatContinueOptions extends BaseClientOptions {
  spec?: string;
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
      .option("--attachment <fileId>", "A picture in the company's Files sent with the message (repeat for more)", collect, [])
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
      .command("continue")
      .description(
        "Start a new quick-answer conversation that carries on from your earlier chat with the agent: nothing for the last conversation, a time (\"last 45 minutes\", \"this morning\") or a topic (\"our meeting today\"). With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--spec <text>", "What to continue: a time or a topic; leave out for the last conversation")
      .action(async (agentId: string, opts: ChatContinueOptions) => {
        try {
          const outcome = await runChatContinue(agentId, opts);
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
      .command("memory")
      .description(
        "The agent's memory notebook: the notes it was asked to remember, newest first. With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const outcome = await runChatGet(apiPath`/api/agents/${agentId}/memories`, opts);
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
      .command("looks")
      .description(
        "Media Studio's saved looks, through the agent's ticked \"List saved looks\" tool (no model call). With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .argument("<agentId>", "Agent ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ companyId: ctx.companyId! });
          const outcome = await runChatGet(`${apiPath`/api/lane-a/${agentId}/looks`}?${query.toString()}`, opts);
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
      .command("attach")
      .description(
        "Store a photo someone sent with a chat message in the company's Files (JPEG, PNG or WebP, at most 10 MB), read as base64 from standard input. Prints its file id for `chat send --attachment`. With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--stdin", "Read the photo as base64 from standard input")
      .action(async (opts: ChatAttachOptions) => {
        try {
          const outcome = await runChatAttach(opts);
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
      .command("image")
      .description(
        "The bytes of a picture a quick agent's reply carried, as base64 in JSON (pictures only). With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .argument("<fileId>", "The picture's file id (from the reply's actions)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (fileId: string, opts: BaseClientOptions) => {
        try {
          const outcome = await runChatImage(fileId, opts);
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
      .command("media")
      .description(
        "The bytes of a Media Studio video or audio (or picture) file, as base64 in JSON. With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .argument("<fileId>", "The file's id (a company file or issue attachment)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (fileId: string, opts: BaseClientOptions) => {
        try {
          const outcome = await runChatMedia(fileId, opts);
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
      .command("reaction")
      .description(
        "DUR-4344: record one Telegram emoji reaction (added or removed) on a message the bridge sent. The event is JSON (--event) and is validated by the server. With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--event <json>", "The reaction event as JSON")
      .option("--follow-up-answer", "The event is the answer to the follow-up question about a disliked picture")
      .action(async (opts: ChatReactionOptions) => {
        try {
          const outcome = await runChatReaction(opts);
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

/** Telegram's own upload limit for a document; a picture over this is not fetched. */
export const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatImageOutcome =
  | { ok: true; fileId: string; contentType: string; byteSize: number; contentBase64: string }
  | { ok: false; status: number; error: string };

/**
 * One picture's bytes. Only pictures (image/*), only up to
 * CHAT_IMAGE_MAX_BYTES, and only what this CLI's own sign-in may read (the
 * server checks company access on every request).
 */
export async function runChatImage(fileId: string, opts: BaseClientOptions): Promise<ChatImageOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  if (!FILE_ID_PATTERN.test(fileId)) return { ok: false, status: 400, error: "That is not a file id." };
  try {
    const result = await ctx.api.getBytes(apiPath`/api/attachments/${fileId}/content`, { ignoreNotFound: true });
    if (!result) return { ok: false, status: 404, error: "That picture was not found." };
    const contentType = (result.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!contentType.startsWith("image/")) return { ok: false, status: 415, error: "That file is not a picture." };
    if (result.bytes.length > CHAT_IMAGE_MAX_BYTES) {
      return { ok: false, status: 413, error: "That picture is too large to send." };
    }
    return {
      ok: true,
      fileId,
      contentType,
      byteSize: result.bytes.length,
      contentBase64: result.bytes.toString("base64"),
    };
  } catch (err) {
    if (err instanceof ApiRequestError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
}

/** Telegram's own upload limit for a video, audio file or document over the Bot API. */
export const CHAT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export type ChatMediaOutcome =
  | { ok: true; fileId: string; contentType: string; byteSize: number; contentBase64: string }
  | { ok: false; status: number; error: string };

/**
 * DUR-4062: one Media Studio file's bytes — a picture, a video or an
 * audio/music file. Same shape and access rules as `chat image`, but not
 * limited to image/* content types, and with video's larger byte limit.
 */
export async function runChatMedia(fileId: string, opts: BaseClientOptions): Promise<ChatMediaOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  if (!FILE_ID_PATTERN.test(fileId)) return { ok: false, status: 400, error: "That is not a file id." };
  try {
    const result = await ctx.api.getBytes(apiPath`/api/attachments/${fileId}/content`, { ignoreNotFound: true });
    if (!result) return { ok: false, status: 404, error: "That file was not found." };
    const contentType = (result.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!/^(image|video|audio)\//.test(contentType)) {
      return { ok: false, status: 415, error: "That file is not a picture, video or audio file." };
    }
    if (result.bytes.length > CHAT_MEDIA_MAX_BYTES) {
      return { ok: false, status: 413, error: "That file is too large to send." };
    }
    return {
      ok: true,
      fileId,
      contentType,
      byteSize: result.bytes.length,
      contentBase64: result.bytes.toString("base64"),
    };
  } catch (err) {
    if (err instanceof ApiRequestError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
}

export type ChatAttachOutcome =
  | { ok: true; fileId: string; contentType: string; byteSize: number }
  | { ok: false; status: number; error: string };

async function readStdinText(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Store a photo a person sent in the company's Files, with no task. The type
 * is decided from the bytes; the name is the server-wide "chat-photo-" name,
 * which tells Media Studio to check it for apparent age before it is sent to
 * any picture service.
 */
export async function runChatAttach(
  opts: ChatAttachOptions,
  deps: { stdin?: NodeJS.ReadableStream; now?: Date } = {},
): Promise<ChatAttachOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  if (!opts.stdin) throw new Error("Give the photo as base64 on standard input with --stdin");
  const raw = (await readStdinText(deps.stdin)).replace(/\s+/g, "");
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    return { ok: false, status: 400, error: "That picture could not be read." };
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > CHAT_PHOTO_MAX_BYTES) return { ok: false, status: 413, error: "That picture is too large." };
  const type = sniffChatPhotoType(bytes);
  if (!type) return { ok: false, status: 415, error: "That file is not a JPEG, PNG or WebP picture." };
  const form = new FormData();
  form.set("file", new Blob([bytes], { type }), chatPhotoFilename(type, deps.now));
  try {
    const created = await ctx.api.postForm<{ id?: unknown }>(apiPath`/api/companies/${ctx.companyId}/files`, form);
    const fileId = typeof created?.id === "string" ? created.id : null;
    if (!fileId || !FILE_ID_PATTERN.test(fileId)) return { ok: false, status: 502, error: "Paperclip did not say where the picture was saved." };
    return { ok: true, fileId, contentType: type, byteSize: bytes.length };
  } catch (err) {
    if (err instanceof ApiRequestError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
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
  const attachments = Array.from(new Set((opts.attachment ?? []).map((id) => id.trim()).filter(Boolean)));
  if (attachments.some((id) => !FILE_ID_PATTERN.test(id))) throw new Error("--attachment must be a file id");
  if (attachments.length > CHAT_ATTACHMENTS_MAX) throw new Error(`At most ${CHAT_ATTACHMENTS_MAX} attachments`);
  if (attachments.length > 0) body.attachmentFileIds = attachments;

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

/**
 * Continue an earlier conversation. The spec is sent as data in the body; the
 * company always comes from --company-id.
 */
export async function runChatContinue(agentId: string, opts: ChatContinueOptions): Promise<ChatSendOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const body: Record<string, unknown> = { companyId: ctx.companyId };
  const spec = opts.spec?.trim();
  if (spec) body.spec = spec;
  try {
    const result = await ctx.api.post<Record<string, unknown>>(apiPath`/api/lane-a/${agentId}/continue`, body);
    return { ok: true, ...(result ?? {}) };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      return { ok: false, status: err.status, code: refusalCode(err), error: err.message };
    }
    throw err;
  }
}

/** A GET whose refusal is data for the caller, like `chat send`. */
async function runChatGet(path: string, opts: BaseClientOptions): Promise<ChatSendOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  try {
    const result = await ctx.api.get<Record<string, unknown>>(path);
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

/**
 * DUR-4344: post one reaction event. The event is data, parsed here and sent
 * as the request body; the company always comes from --company-id.
 */
export async function runChatReaction(opts: ChatReactionOptions): Promise<ChatSendOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  let event: unknown;
  try {
    event = JSON.parse(opts.event);
  } catch {
    throw new Error("--event must be valid JSON");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("--event must be a JSON object");
  }
  try {
    const result = await ctx.api.post<Record<string, unknown>>(
      opts.followUpAnswer
        ? apiPath`/api/companies/${ctx.companyId}/telegram-reactions/follow-up-answer`
        : apiPath`/api/companies/${ctx.companyId}/telegram-reactions`,
      event,
    );
    return { ok: true, ...(result ?? {}) };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      return { ok: false, status: err.status, code: refusalCode(err), error: err.message };
    }
    throw err;
  }
}
