// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechSettings, TelegramBotSummary } from "@paperclipai/shared";
import { TelegramBotVoiceControls, TelegramVoiceSection } from "./TelegramVoiceSettings";

/**
 * Voice messages on the Telegram card: the operator picks the OpenAI key,
 * sets the daily allowance, and per bot chooses when answers are read aloud
 * and in which voice (with a Preview to hear it). The key's value never
 * appears; only its saved name.
 */

const mockSpeechApi = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  transcribe: vi.fn(),
  speak: vi.fn(),
}));
const mockPlaySpeech = vi.hoisted(() => vi.fn());
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockTelegramBotsApi = vi.hoisted(() => ({ setVoice: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/speech", () => ({ speechApi: mockSpeechApi, playSpeech: mockPlaySpeech }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/telegramBots", () => ({ telegramBotsApi: mockTelegramBotsApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const BOT = "33333333-3333-4333-8333-333333333333";
const OPENAI_SECRET = "44444444-4444-4444-8444-444444444444";
const OLD_SECRET = "55555555-5555-4555-8555-555555555555";
const GITHUB_SECRET = "66666666-6666-4666-8666-666666666666";

const settings: SpeechSettings = {
  companyId: COMPANY,
  keySecretId: null,
  keySecretName: null,
  dailyTranscribeSecondsCap: 3600,
  dailySpeakCharactersCap: 50000,
  usedToday: { transcribeSeconds: 125, speakCharacters: 1234 },
  models: { transcribe: "gpt-4o-mini-transcribe", speak: "gpt-4o-mini-tts" },
};

const bot: TelegramBotSummary = {
  id: BOT,
  companyId: COMPANY,
  agentId: "22222222-2222-4222-8222-222222222222",
  agentName: "Maja",
  name: "Maja",
  tokenHint: "8100000001:••••ng01",
  uiBase: null,
  allowedTelegramUserIds: ["111111"],
  enabled: true,
  receivesCompanyNotices: false,
  voiceReplyMode: "when_voice",
  voice: null,
  lastCheckAt: null,
  lastCheckOk: null,
  lastCheckUsername: null,
  lastCheckError: null,
  createdAt: "2026-09-16T09:00:00.000Z",
};

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function change(element: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("Telegram voice settings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSpeechApi.getSettings.mockResolvedValue(settings);
    mockSpeechApi.updateSettings.mockResolvedValue(settings);
    mockSecretsApi.list.mockResolvedValue([
      { id: GITHUB_SECRET, name: "GitHub", kind: "github_token", status: "active" },
      { id: OLD_SECRET, name: "Old key", kind: null, status: "active" },
      { id: OPENAI_SECRET, name: "OpenAI (company)", kind: "openai_api_key", status: "active" },
    ]);
    mockTelegramBotsApi.setVoice.mockResolvedValue(bot);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(node: React.ReactNode) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    await flushReact();
    return root;
  }

  it("offers only OpenAI keys (and keys with no type yet), OpenAI keys first, and saves the pick", async () => {
    const root = await render(<TelegramVoiceSection companyId={COMPANY} />);

    const select = container.querySelector<HTMLSelectElement>(`#speech-key-${COMPANY}`)!;
    const options = Array.from(select.options).map((option) => option.textContent);
    expect(options).toEqual(["None — voice messages are off", "OpenAI (company)", "Old key (type not set)"]);
    expect(container.querySelector('[data-testid="speech-no-key"]')).not.toBeNull();
    expect(container.textContent).toContain("Used today: 2 min 5 s of listening, 1,234 characters read aloud.");

    change(select, OPENAI_SECRET);
    await flushReact();
    expect(mockSpeechApi.updateSettings).toHaveBeenCalledWith(COMPANY, { keySecretId: OPENAI_SECRET });
    root.unmount();
  });

  it("saves the daily allowance in seconds and characters", async () => {
    const root = await render(<TelegramVoiceSection companyId={COMPANY} />);
    const minutes = container.querySelector<HTMLInputElement>(`#speech-minutes-${COMPANY}`)!;
    expect(minutes.value).toBe("60");
    change(minutes, "30");
    await flushReact();
    const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    save.click();
    await flushReact();
    expect(mockSpeechApi.updateSettings).toHaveBeenCalledWith(COMPANY, {
      dailyTranscribeSecondsCap: 1800,
      dailySpeakCharactersCap: 50000,
    });
    root.unmount();
  });

  it("read-only: shows the key's name and no controls to change it", async () => {
    mockSpeechApi.getSettings.mockResolvedValue({ ...settings, keySecretId: OPENAI_SECRET, keySecretName: "OpenAI (company)" });
    const root = await render(<TelegramVoiceSection companyId={COMPANY} readOnly />);
    expect(container.querySelector('[data-testid="speech-key-readonly"]')?.textContent).toBe("OpenAI (company)");
    expect(container.querySelector(`#speech-key-${COMPANY}`)).toBeNull();
    expect(mockSecretsApi.list).not.toHaveBeenCalled();
    root.unmount();
  });

  it("changes when a bot replies with voice, and its voice", async () => {
    const root = await render(<TelegramBotVoiceControls companyId={COMPANY} bot={bot} />);
    const mode = container.querySelector<HTMLSelectElement>(`#telegram-voice-mode-${BOT}`)!;
    expect(Array.from(mode.options).map((option) => option.textContent)).toEqual([
      "Never",
      "When I sent a voice message",
      "Always",
    ]);
    expect(mode.value).toBe("when_voice");
    change(mode, "always");
    await flushReact();
    expect(mockTelegramBotsApi.setVoice).toHaveBeenCalledWith(COMPANY, BOT, { voiceReplyMode: "always" });

    const voice = container.querySelector<HTMLSelectElement>(`#telegram-voice-${BOT}`)!;
    expect(voice.value).toBe("marin");
    change(voice, "cedar");
    await flushReact();
    expect(mockTelegramBotsApi.setVoice).toHaveBeenCalledWith(COMPANY, BOT, { voice: "cedar" });
    root.unmount();
  });

  it("Preview reads a sample in the bot's voice and plays it", async () => {
    const result = { audioBase64: "T2dnUw==", contentType: "audio/ogg", oggOpus: true, characters: 10, truncated: false, voice: "cedar", model: "m" };
    mockSpeechApi.speak.mockResolvedValue(result);
    mockPlaySpeech.mockResolvedValue({});
    const root = await render(<TelegramBotVoiceControls companyId={COMPANY} bot={{ ...bot, voice: "cedar" }} />);
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Preview")!.click();
    await flushReact();
    expect(mockSpeechApi.speak).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ voice: "cedar", source: "preview" }));
    expect(mockPlaySpeech).toHaveBeenCalledWith(result);
    root.unmount();
  });

  it("Preview explains a refusal in plain words", async () => {
    const { ApiError } = await import("../api/client");
    mockSpeechApi.speak.mockRejectedValue(
      new ApiError("Voice messages are not set up yet: pick an OpenAI key under Connections → Telegram → Voice messages.", 503, {}),
    );
    const root = await render(<TelegramBotVoiceControls companyId={COMPANY} bot={bot} />);
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Preview")!.click();
    await flushReact();
    expect(container.textContent).toContain("Voice messages are not set up yet");
    expect(mockPlaySpeech).not.toHaveBeenCalled();
    root.unmount();
  });
});
