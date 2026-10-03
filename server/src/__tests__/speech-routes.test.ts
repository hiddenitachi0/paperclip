import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  companySpeechSettings,
  createDb,
  secretAccessEvents,
  speechUsageEvents,
  telegramBots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { speechRoutes } from "../routes/speech.js";
import { telegramBotRoutes } from "../routes/telegram-bots.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { SPEECH_MODELS } from "../services/speech.js";

/**
 * Voice messages: the speech routes. What a careless change would quietly
 * take away: the key never leaves the server (not in an answer, not in an
 * error), the provider gets the request shape it expects, the daily allowance
 * holds, and no agent can reach any of it.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping speech route tests: ${support.reason ?? "unsupported environment"}`);
}

const OPENAI_KEY = "sk-proj-speechtestkey0123456789abcdefABCDEF";
const BOT_TOKEN = "8100000001:AAHtestingtestingtestingtesting01";

/** A tiny but well-formed Ogg Opus header + one last page saying `seconds` long. */
function oggOpus(seconds: number, preSkip = 312): Buffer {
  const page = (granule: bigint, payload: Buffer) => {
    const header = Buffer.alloc(27);
    header.write("OggS", 0, "latin1");
    header.writeBigInt64LE(granule, 6);
    header[26] = 1;
    return Buffer.concat([header, Buffer.from([payload.length]), payload]);
  };
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  return Buffer.concat([
    page(0n, head),
    page(BigInt(Math.round(seconds * 48_000) + preSkip), Buffer.from("fake-opus-audio")),
  ]);
}

type FetchCall = { url: string; init: RequestInit };

function fakeOpenAi(options: { transcript?: string; speech?: Buffer; status?: number; errorBody?: string } = {}) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (options.status && options.status !== 200) {
      return new Response(options.errorBody ?? "{}", { status: options.status });
    }
    if (String(url).endsWith("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: options.transcript ?? " Hei Maja, hvor mange sofaer? " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array(options.speech ?? oggOpus(2)), {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls, mock: impl };
}

d("speech routes", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-speech-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("speech-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(speechUsageEvents);
    await db.delete(companySpeechSettings);
    await db.delete(telegramBots);
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    return agentService(db).create(companyId, {
      name: `Maja-${randomUUID().slice(0, 6)}`,
      role: "assistant",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  async function seedKey(companyId: string, kind: "openai_api_key" | "github_token" | null = "openai_api_key") {
    return secretService(db).create(companyId, {
      name: `OpenAI ${randomUUID().slice(0, 6)}`,
      provider: "local_encrypted",
      value: OPENAI_KEY,
      ...(kind ? { kind } : {}),
    });
  }

  const ownerActor = () => ({ type: "board", source: "local_implicit", userId: "operator", isInstanceAdmin: true });
  const memberActor = (companyIds: string[], membershipRole = "admin") => ({
    type: "board",
    source: "session",
    userId: "member",
    isInstanceAdmin: false,
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole })),
  });
  const agentActor = (companyId: string, agentId: string) => ({
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: null,
  });

  function createApp(actor: Record<string, unknown>, fetchImpl: typeof fetch = fakeOpenAi().impl) {
    const app = express();
    app.use(express.json({ limit: "30mb" }));
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", speechRoutes(db, { fetchImpl }));
    app.use("/api", telegramBotRoutes(db, { fetchImpl }));
    app.use(errorHandler);
    return app;
  }

  async function pickKey(app: express.Express, companyId: string, secretId: string) {
    const res = await request(app).put(`/api/companies/${companyId}/speech-settings`).send({ keySecretId: secretId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res;
  }

  // ── Settings ───────────────────────────────────────────────────────────

  it("starts with no key and the default allowances, and a picked key is shown by name only", async () => {
    const companyId = await seedCompany();
    const key = await seedKey(companyId);
    const app = createApp(ownerActor());

    const before = await request(app).get(`/api/companies/${companyId}/speech-settings`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      keySecretId: null,
      dailyTranscribeSecondsCap: 3600,
      dailySpeakCharactersCap: 50_000,
      usedToday: { transcribeSeconds: 0, speakCharacters: 0 },
      models: { transcribe: "gpt-4o-mini-transcribe", speak: "gpt-4o-mini-tts" },
    });

    const picked = await pickKey(app, companyId, key.id);
    expect(picked.body).toMatchObject({ keySecretId: key.id, keySecretName: key.name });
    expect(JSON.stringify(picked.body)).not.toContain(OPENAI_KEY);

    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetType, "speech"));
    expect(binding).toMatchObject({ companyId, secretId: key.id, targetId: companyId, configPath: "openai_api_key" });

    const caps = await request(app)
      .put(`/api/companies/${companyId}/speech-settings`)
      .send({ dailyTranscribeSecondsCap: 600, dailySpeakCharactersCap: 1000 });
    expect(caps.body).toMatchObject({ keySecretId: key.id, dailyTranscribeSecondsCap: 600, dailySpeakCharactersCap: 1000 });

    const cleared = await request(app).put(`/api/companies/${companyId}/speech-settings`).send({ keySecretId: null });
    expect(cleared.body.keySecretId).toBeNull();

    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activity.map((row) => row.action)).toContain("speech.settings_changed");
    expect(JSON.stringify(activity)).not.toContain(OPENAI_KEY);
  });

  it("the same OpenAI key can be both the speech key and a quick agent's key", async () => {
    const companyId = await seedCompany();
    const key = await seedKey(companyId);
    const app = createApp(ownerActor());
    await pickKey(app, companyId, key.id);
    // Not a dedicated target: binding it elsewhere still works.
    await expect(
      secretService(db).syncSecretRefsForTarget(
        companyId,
        { targetType: "agent", targetId: randomUUID() },
        [{ secretId: key.id, configPath: "laneA.apiKey" }],
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses a saved secret that is not an OpenAI key, and one from another company", async () => {
    const companyId = await seedCompany();
    const other = await seedCompany();
    const github = await seedKey(companyId, "github_token");
    const foreign = await seedKey(other);
    const app = createApp(ownerActor());

    const wrongKind = await request(app).put(`/api/companies/${companyId}/speech-settings`).send({ keySecretId: github.id });
    expect(wrongKind.status).toBe(422);
    expect(wrongKind.body.error).toContain("need an OpenAI API key");

    const wrongCompany = await request(app).put(`/api/companies/${companyId}/speech-settings`).send({ keySecretId: foreign.id });
    expect(wrongCompany.status).toBe(404);
  });

  it("accepts a saved secret with no kind (saved before kinds existed)", async () => {
    const companyId = await seedCompany();
    const legacy = await seedKey(companyId, null);
    await pickKey(createApp(ownerActor()), companyId, legacy.id);
  });

  // ── Speech to text ─────────────────────────────────────────────────────

  it("transcribes with the mini transcribe model, counts the seconds, and never returns the key", async () => {
    const companyId = await seedCompany();
    const key = await seedKey(companyId);
    const openai = fakeOpenAi();
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, key.id);
    const audio = oggOpus(4.2);

    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/transcribe`)
      .send({ audioBase64: audio.toString("base64"), filename: "file_7.oga", durationSeconds: 1, source: "telegram" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ text: "Hei Maja, hvor mange sofaer?", billedSeconds: 5, model: "gpt-4o-mini-transcribe" });
    expect(JSON.stringify(res.body)).not.toContain(OPENAI_KEY);

    expect(openai.calls).toHaveLength(1);
    const call = openai.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(call.init.redirect).toBe("error");
    const form = call.init.body as FormData;
    expect(form.get("model")).toBe(SPEECH_MODELS.transcribe);
    expect(form.get("response_format")).toBe("json");
    // Language is left to the model to detect (Norwegian and English).
    expect(form.get("language")).toBeNull();
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true);

    const usage = await db.select().from(speechUsageEvents).where(eq(speechUsageEvents.companyId, companyId));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "transcribe", amount: 5, model: "gpt-4o-mini-transcribe", source: "telegram" });

    const reads = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, key.id));
    expect(reads.length).toBeGreaterThan(0);
  });

  it("refuses in plain words when no key is picked", async () => {
    const companyId = await seedCompany();
    const openai = fakeOpenAi();
    const app = createApp(ownerActor(), openai.impl);
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/transcribe`)
      .send({ audioBase64: oggOpus(2).toString("base64") });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SPEECH_KEY_MISSING");
    expect(res.body.error).toContain("pick an OpenAI key");
    expect(openai.calls).toHaveLength(0);
  });

  it("refuses a recording over five minutes before calling OpenAI", async () => {
    const companyId = await seedCompany();
    const openai = fakeOpenAi();
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/transcribe`)
      .send({ audioBase64: oggOpus(320).toString("base64") });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("That recording is longer than 5 minutes. Please send a shorter one, or type it.");
    expect(openai.calls).toHaveLength(0);
  });

  it("holds the daily speech-to-text allowance", async () => {
    const companyId = await seedCompany();
    const openai = fakeOpenAi();
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    await request(app).put(`/api/companies/${companyId}/speech-settings`).send({ dailyTranscribeSecondsCap: 60 });

    const first = await request(app)
      .post(`/api/companies/${companyId}/speech/transcribe`)
      .send({ audioBase64: oggOpus(50).toString("base64") });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/companies/${companyId}/speech/transcribe`)
      .send({ audioBase64: oggOpus(20).toString("base64") });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("SPEECH_DAILY_LIMIT");
    expect(second.body.error).toContain("Today's allowance for voice messages (1 minute) is used up");
    expect(openai.calls).toHaveLength(1);

    const settings = await request(app).get(`/api/companies/${companyId}/speech-settings`);
    expect(settings.body.usedToday).toEqual({ transcribeSeconds: 50, speakCharacters: 0 });
  });

  it("scrubs the key out of a provider error, and logs no usage", async () => {
    const companyId = await seedCompany();
    const openai = fakeOpenAi({
      status: 400,
      errorBody: JSON.stringify({ error: { message: `Invalid file for key ${OPENAI_KEY}` } }),
    });
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/transcribe`)
      .send({ audioBase64: oggOpus(2).toString("base64") });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("SPEECH_PROVIDER_FAILED");
    expect(JSON.stringify(res.body)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(res.body)).toContain("[redacted]");
    expect(await db.select().from(speechUsageEvents)).toHaveLength(0);
  });

  it("says plainly when OpenAI refuses the key", async () => {
    const companyId = await seedCompany();
    const app = createApp(ownerActor(), fakeOpenAi({ status: 401, errorBody: `bad key ${OPENAI_KEY}` }).impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/speak`)
      .send({ text: "Hei" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SPEECH_KEY_REFUSED");
    expect(JSON.stringify(res.body)).not.toContain(OPENAI_KEY);
  });

  // ── Text to speech ─────────────────────────────────────────────────────

  it("reads aloud with the mini TTS model as Ogg Opus, only the text, in the bot's voice", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const openai = fakeOpenAi({ speech: oggOpus(3) });
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const bot = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots`)
      .send({ agentId: agent.id, name: "Maja", botToken: BOT_TOKEN });
    expect(bot.status).toBe(201);
    const voice = await request(app)
      .put(`/api/companies/${companyId}/telegram-bots/${bot.body.id}/voice`)
      .send({ voice: "cedar" });
    expect(voice.body).toMatchObject({ voice: "cedar", voiceReplyMode: "when_voice" });

    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/speak`)
      .send({
        text: "**Vi solgte 12 sofaer.** Se https://paperclip.example/x og fil 0f000000-0000-4000-8000-000000000001.",
        source: "telegram",
        telegramBotId: bot.body.id,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ contentType: "audio/ogg", oggOpus: true, voice: "cedar", truncated: false });
    expect(Buffer.from(res.body.audioBase64, "base64").equals(oggOpus(3))).toBe(true);

    const call = openai.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/speech");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: "Vi solgte 12 sofaer. Se og fil .",
      response_format: "opus",
    });
    const usage = await db.select().from(speechUsageEvents).where(eq(speechUsageEvents.companyId, companyId));
    expect(usage[0]).toMatchObject({ kind: "speak", amount: "Vi solgte 12 sofaer. Se og fil .".length, telegramBotId: bot.body.id });
  });

  it("reads at most 1,500 characters and says the rest is in the text", async () => {
    const companyId = await seedCompany();
    const openai = fakeOpenAi();
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const long = Array.from({ length: 80 }, (_, i) => `Dette er setning nummer ${i}.`).join(" ");
    const res = await request(app).post(`/api/companies/${companyId}/speech/speak`).send({ text: long });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    const input = JSON.parse(String(openai.calls[0]!.init.body)).input as string;
    expect(input.length).toBeLessThanOrEqual(1500);
    expect(input.endsWith(". The rest is in the text.")).toBe(true);
  });

  it("holds the daily text-to-speech allowance before calling OpenAI", async () => {
    const companyId = await seedCompany();
    const openai = fakeOpenAi();
    const app = createApp(ownerActor(), openai.impl);
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    await request(app).put(`/api/companies/${companyId}/speech-settings`).send({ dailySpeakCharactersCap: 20 });
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/speak`)
      .send({ text: "This sentence is longer than twenty characters." });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("SPEECH_DAILY_LIMIT");
    expect(res.body.error).toContain("Today's allowance for reading answers aloud (20 characters) is used up");
    expect(openai.calls).toHaveLength(0);
  });

  it("refuses a text with nothing to read aloud", async () => {
    const companyId = await seedCompany();
    const app = createApp(ownerActor());
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/speak`)
      .send({ text: "https://example.com/only-a-link" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SPEECH_NOTHING_TO_SAY");
  });

  it("refuses another company's Telegram bot", async () => {
    const companyId = await seedCompany();
    const other = await seedCompany();
    const agent = await seedAgent(other);
    const app = createApp(ownerActor());
    await pickKey(app, companyId, (await seedKey(companyId)).id);
    const bot = await request(app)
      .post(`/api/companies/${other}/telegram-bots`)
      .send({ agentId: agent.id, name: "Other", botToken: BOT_TOKEN });
    const res = await request(app)
      .post(`/api/companies/${companyId}/speech/speak`)
      .send({ text: "Hei", telegramBotId: bot.body.id });
    expect(res.status).toBe(404);
  });

  // ── Telegram voice settings ────────────────────────────────────────────

  it("stores the bot's reply mode and voice, and the bridge roster carries them", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(ownerActor());
    const bot = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots`)
      .send({ agentId: agent.id, name: "Maja", botToken: BOT_TOKEN });
    expect(bot.body).toMatchObject({ voiceReplyMode: "when_voice", voice: null });

    const changed = await request(app)
      .put(`/api/companies/${companyId}/telegram-bots/${bot.body.id}/voice`)
      .send({ voiceReplyMode: "always", voice: "marin" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ voiceReplyMode: "always", voice: "marin" });

    const bad = await request(app)
      .put(`/api/companies/${companyId}/telegram-bots/${bot.body.id}/voice`)
      .send({ voiceReplyMode: "loud" });
    expect(bad.status).toBe(400);

    const roster = await request(app).get("/api/instance/telegram-bridge-config");
    expect(roster.body.bots).toEqual([
      expect.objectContaining({ id: bot.body.id, voiceReplyMode: "always", voice: "marin" }),
    ]);
  });

  // ── Who may call what ──────────────────────────────────────────────────

  it("never lets an agent use or change speech, not even in its own company", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const openai = fakeOpenAi();
    await pickKey(createApp(ownerActor()), companyId, (await seedKey(companyId)).id);
    const app = createApp(agentActor(companyId, agent.id), openai.impl);

    const calls = [
      request(app).get(`/api/companies/${companyId}/speech-settings`),
      request(app).put(`/api/companies/${companyId}/speech-settings`).send({ keySecretId: null }),
      request(app).post(`/api/companies/${companyId}/speech/transcribe`).send({ audioBase64: oggOpus(2).toString("base64") }),
      request(app).post(`/api/companies/${companyId}/speech/speak`).send({ text: "Hei" }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
    }
    expect(openai.calls).toHaveLength(0);
  });

  it("keeps other companies out, and only the owner or an admin may change the settings", async () => {
    const companyId = await seedCompany();
    const other = await seedCompany();
    const openai = fakeOpenAi();

    const outsider = createApp(memberActor([other]), openai.impl);
    expect((await request(outsider).get(`/api/companies/${companyId}/speech-settings`)).status).toBe(403);
    expect(
      (await request(outsider).post(`/api/companies/${companyId}/speech/speak`).send({ text: "Hei" })).status,
    ).toBe(403);

    const operator = createApp(memberActor([companyId], "operator"), openai.impl);
    expect((await request(operator).get(`/api/companies/${companyId}/speech-settings`)).status).toBe(200);
    const change = await request(operator)
      .put(`/api/companies/${companyId}/speech-settings`)
      .send({ dailySpeakCharactersCap: 1 });
    expect(change.status).toBe(403);
    expect(openai.calls).toHaveLength(0);
  });
});
