import { readFile } from "node:fs/promises";
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
 * Voice messages: the two calls the Telegram bridge makes around a voice
 * message.
 *
 *   speech transcribe   a recording -> text (POST /api/companies/:id/speech/transcribe)
 *   speech speak        text -> a recording (POST /api/companies/:id/speech/speak)
 *
 * The recording never travels on the command line: `transcribe` reads it as
 * base64 from standard input (`--stdin`, what the bridge uses through
 * `docker exec -i`) or from a file (`--file`). The text to read aloud comes in
 * `--text`, which the bridge fills from an environment variable, exactly like
 * `chat send --message`.
 *
 * Like `chat send`, with --json a refusal (no key picked, the daily allowance
 * used up, a recording that is too long) is printed as
 * `{ "ok": false, "status", "code", "error" }` and exits 0, so the caller can
 * tell the person what happened in plain words.
 */

interface SpeechTranscribeOptions extends BaseClientOptions {
  stdin?: boolean;
  file?: string;
  filename?: string;
  contentType?: string;
  duration?: string;
  source?: string;
  telegramBotId?: string;
}

interface SpeechSpeakOptions extends BaseClientOptions {
  text: string;
  voice?: string;
  source?: string;
  telegramBotId?: string;
}

export type SpeechOutcome =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; status: number; code: string | null; error: string };

const SOURCES = new Set(["telegram", "chat", "preview"]);

export function registerSpeechCommands(program: Command): void {
  const speech = program.command("speech").description("Voice messages: speech to text, and text read aloud");

  addCommonClientOptions(
    speech
      .command("transcribe")
      .description(
        "Turn a recording into text. The recording comes as base64 on standard input (--stdin) or from a file (--file). With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--stdin", "Read the recording as base64 from standard input")
      .option("--file <path>", "Read the recording from this file")
      .option("--filename <name>", "The recording's file name, e.g. voice.ogg (only the extension is used)")
      .option("--content-type <type>", "The recording's type, e.g. audio/ogg")
      .option("--duration <seconds>", "How long the recording is, in seconds")
      .option("--source <source>", "Where it came from: telegram, chat or preview", "chat")
      .option("--telegram-bot-id <id>", "The Telegram bot it came through")
      .action(async (opts: SpeechTranscribeOptions) => {
        try {
          const outcome = await runSpeechTranscribe(opts);
          if (!outcome.ok && !opts.json) throw new ApiRequestError(outcome.status, outcome.error);
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    speech
      .command("speak")
      .description(
        "Read a text aloud: prints the recording as base64 in JSON. With --json a refusal is printed as {ok:false,...} and exits 0.",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--text <text>", "The text to read aloud")
      .option("--voice <voice>", "The voice, e.g. marin")
      .option("--source <source>", "Where it is for: telegram, chat or preview", "chat")
      .option("--telegram-bot-id <id>", "The Telegram bot it is for")
      .action(async (opts: SpeechSpeakOptions) => {
        try {
          const outcome = await runSpeechSpeak(opts);
          if (!outcome.ok && !opts.json) throw new ApiRequestError(outcome.status, outcome.error);
          printOutput(outcome, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sourceOf(value: string | undefined): string {
  const source = (value ?? "chat").trim();
  if (!SOURCES.has(source)) throw new Error("--source must be telegram, chat or preview");
  return source;
}

async function post(opts: BaseClientOptions, path: string, body: Record<string, unknown>): Promise<SpeechOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  try {
    const result = await ctx.api.post<Record<string, unknown>>(path, body);
    return { ok: true, ...(result ?? {}) };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      return { ok: false, status: err.status, code: refusalCode(err), error: err.message };
    }
    throw err;
  }
}

export async function runSpeechTranscribe(
  opts: SpeechTranscribeOptions,
  deps: { stdin?: NodeJS.ReadableStream } = {},
): Promise<SpeechOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  if (Boolean(opts.stdin) === Boolean(opts.file)) {
    throw new Error("Give the recording with exactly one of --stdin or --file");
  }
  let audioBase64: string;
  if (opts.file) {
    audioBase64 = (await readFile(opts.file)).toString("base64");
  } else {
    audioBase64 = (await readStdin(deps.stdin)).replace(/\s+/g, "");
  }
  if (!audioBase64) throw new Error("The recording is empty");
  const body: Record<string, unknown> = { audioBase64, source: sourceOf(opts.source) };
  if (opts.filename?.trim()) body.filename = opts.filename.trim();
  else if (opts.file) body.filename = opts.file.split(/[\\/]/).pop();
  if (opts.contentType?.trim()) body.contentType = opts.contentType.trim();
  if (opts.duration !== undefined) {
    const seconds = Number(opts.duration);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--duration must be a number of seconds");
    body.durationSeconds = seconds;
  }
  if (opts.telegramBotId?.trim()) body.telegramBotId = opts.telegramBotId.trim();
  return post(opts, apiPath`/api/companies/${ctx.companyId}/speech/transcribe`, body);
}

export async function runSpeechSpeak(opts: SpeechSpeakOptions): Promise<SpeechOutcome> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const text = opts.text?.trim();
  if (!text) throw new Error("--text is required");
  const body: Record<string, unknown> = { text, source: sourceOf(opts.source) };
  if (opts.voice?.trim()) body.voice = opts.voice.trim();
  if (opts.telegramBotId?.trim()) body.telegramBotId = opts.telegramBotId.trim();
  return post(opts, apiPath`/api/companies/${ctx.companyId}/speech/speak`, body);
}

function refusalCode(err: ApiRequestError): string | null {
  const body = err.body && typeof err.body === "object" ? (err.body as Record<string, unknown>) : null;
  if (typeof body?.code === "string") return body.code;
  const details = err.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : null;
  if (typeof details?.code === "string") return details.code;
  if (typeof details?.reason === "string") return details.reason;
  return null;
}
