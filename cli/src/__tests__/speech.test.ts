import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSpeechCommands, runSpeechTranscribe } from "../commands/client/speech.js";

// Voice messages: the Telegram bridge calls these two commands around a voice
// message. The recording never travels on the command line.

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_ID = "33333333-3333-4333-8333-333333333333";
const RECORDING = Buffer.from("OggS\u0000fake-recording", "latin1");

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSpeechCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(
    [...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"],
    { from: "user" },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("speech commands", () => {
  let printed: string[];
  let tmp: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    printed = [];
    tmp = mkdtempSync(path.join(os.tmpdir(), "paperclip-speech-cli-"));
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("sends a recording read as base64 from standard input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "Hei Maja", billedSeconds: 3, model: "m" }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSpeechTranscribe(
      {
        companyId: COMPANY_ID,
        apiBase: "http://localhost:3100",
        apiKey: "board-token",
        stdin: true,
        filename: "file_7.oga",
        duration: "3",
        source: "telegram",
        telegramBotId: BOT_ID,
        json: true,
      },
      { stdin: Readable.from([`${RECORDING.toString("base64").slice(0, 8)}\n`, RECORDING.toString("base64").slice(8)]) },
    );

    expect(outcome).toEqual({ ok: true, text: "Hei Maja", billedSeconds: 3, model: "m" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/speech/transcribe`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      audioBase64: RECORDING.toString("base64"),
      filename: "file_7.oga",
      durationSeconds: 3,
      source: "telegram",
      telegramBotId: BOT_ID,
    });
  });

  it("can read the recording from a file instead", async () => {
    const file = path.join(tmp, "note.ogg");
    writeFileSync(file, RECORDING);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "Hei", billedSeconds: 1, model: "m" }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["speech", "transcribe", "-C", COMPANY_ID, "--file", file, "--json"]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ audioBase64: RECORDING.toString("base64"), filename: "note.ogg", source: "chat" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ ok: true, text: "Hei" });
  });

  it("refuses without a recording source, without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(run(["speech", "transcribe", "-C", COMPANY_ID, "--json"])).rejects.toThrow("process.exit(1)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints a refusal as data with its code, so the bridge can explain it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: "Voice messages are not set up yet: pick an OpenAI key under Connections → Telegram → Voice messages.",
            code: "SPEECH_KEY_MISSING",
            details: { code: "SPEECH_KEY_MISSING" },
          },
          503,
        ),
      ),
    );
    const file = path.join(tmp, "note.ogg");
    writeFileSync(file, RECORDING);

    await run(["speech", "transcribe", "-C", COMPANY_ID, "--file", file, "--json"]);

    expect(process.exit).not.toHaveBeenCalled();
    expect(JSON.parse(printed.join("\n"))).toEqual({
      ok: false,
      status: 503,
      code: "SPEECH_KEY_MISSING",
      error: "Voice messages are not set up yet: pick an OpenAI key under Connections → Telegram → Voice messages.",
    });
  });

  it("asks for a text to be read aloud, with the voice and the bot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ audioBase64: "T2dnUw==", contentType: "audio/ogg", oggOpus: true, characters: 3 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "speech", "speak", "-C", COMPANY_ID,
      "--text", "Hei",
      "--voice", "cedar",
      "--source", "telegram",
      "--telegram-bot-id", BOT_ID,
      "--json",
    ]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/speech/speak`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      text: "Hei",
      voice: "cedar",
      source: "telegram",
      telegramBotId: BOT_ID,
    });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ ok: true, oggOpus: true, audioBase64: "T2dnUw==" });
  });

  it("refuses an unknown source without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      run(["speech", "speak", "-C", COMPANY_ID, "--text", "Hei", "--source", "radio", "--json"]),
    ).rejects.toThrow("process.exit(1)");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
