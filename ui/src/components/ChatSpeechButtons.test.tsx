// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMicButton, ChatSpeakButton } from "./ChatSpeechButtons";

/**
 * Voice in the in-app chat: the mic records in the browser and sends the
 * recording through the speech endpoint; the words come back into the chat
 * box. The speaker reads one answer aloud.
 */

const mockSpeechApi = vi.hoisted(() => ({ transcribe: vi.fn(), speak: vi.fn() }));
const mockPlaySpeech = vi.hoisted(() => vi.fn());
vi.mock("../api/speech", () => ({
  speechApi: mockSpeechApi,
  playSpeech: mockPlaySpeech,
  blobToBase64: async () => "UkVDT1JESU5H",
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";

class FakeMediaRecorder extends EventTarget {
  static last: FakeMediaRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  constructor(public stream: MediaStream) {
    super();
    FakeMediaRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const data = new Event("dataavailable") as Event & { data: Blob };
    data.data = new Blob(["RECORDING"], { type: this.mimeType });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("chat speech buttons", () => {
  let container: HTMLDivElement;
  const trackStop = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
    });
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("records, sends the recording to be written down, and hands back the words", async () => {
    mockSpeechApi.transcribe.mockResolvedValue({ text: " Hvor mange sofaer? ", billedSeconds: 2, model: "m" });
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const root = createRoot(container);
    root.render(<ChatMicButton companyId={COMPANY} onTranscript={onTranscript} onError={onError} />);
    await flush();

    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-mic-button"]')!;
    expect(button.getAttribute("aria-label")).toBe("Speak your message");
    button.click();
    await flush();
    expect(button.getAttribute("aria-label")).toBe("Stop recording");

    button.click();
    await flush();

    expect(trackStop).toHaveBeenCalled();
    expect(mockSpeechApi.transcribe).toHaveBeenCalledWith(COMPANY, {
      audioBase64: "UkVDT1JESU5H",
      filename: "recording.webm",
      contentType: "audio/webm;codecs=opus",
      durationSeconds: 1,
      source: "chat",
    });
    expect(onTranscript).toHaveBeenCalledWith("Hvor mange sofaer?");
    expect(onError).not.toHaveBeenCalled();
    root.unmount();
  });

  it("says so when the microphone is not allowed", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("denied"));
    const onError = vi.fn();
    const root = createRoot(container);
    root.render(<ChatMicButton companyId={COMPANY} onTranscript={vi.fn()} onError={onError} />);
    await flush();
    container.querySelector<HTMLButtonElement>('[data-testid="chat-mic-button"]')!.click();
    await flush();
    expect(onError).toHaveBeenCalledWith("The browser did not allow the microphone. Allow it for this page and try again.");
    expect(mockSpeechApi.transcribe).not.toHaveBeenCalled();
    root.unmount();
  });

  it("is hidden where the browser cannot record", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const root = createRoot(container);
    root.render(<ChatMicButton companyId={COMPANY} onTranscript={vi.fn()} onError={vi.fn()} />);
    await flush();
    expect(container.querySelector('[data-testid="chat-mic-button"]')).toBeNull();
    root.unmount();
  });

  it("the speaker reads one answer aloud", async () => {
    const result = { audioBase64: "T2dnUw==", contentType: "audio/ogg" };
    mockSpeechApi.speak.mockResolvedValue(result);
    mockPlaySpeech.mockResolvedValue({});
    const root = createRoot(container);
    root.render(<ChatSpeakButton companyId={COMPANY} text="Vi solgte 12 sofaer." onError={vi.fn()} />);
    await flush();
    container.querySelector<HTMLButtonElement>('[data-testid="chat-speak-button"]')!.click();
    await flush();
    expect(mockSpeechApi.speak).toHaveBeenCalledWith(COMPANY, { text: "Vi solgte 12 sofaer.", source: "chat" });
    expect(mockPlaySpeech).toHaveBeenCalledWith(result);
    root.unmount();
  });
});
