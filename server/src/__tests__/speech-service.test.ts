import { describe, expect, it } from "vitest";
import {
  billableAudioSeconds,
  oggOpusDurationSeconds,
  prepareSpokenText,
  SPEECH_MODELS,
  SPEECH_REST_IN_TEXT,
  startOfUtcDay,
} from "../services/speech.js";

/** Voice messages: the pure parts of the speech service. */

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
  head.writeUInt16LE(preSkip, 10);
  return Buffer.concat([page(0n, head), page(BigInt(Math.round(seconds * 48_000) + preSkip), Buffer.from("x"))]);
}

describe("speech models", () => {
  it("are the cheap mini models, named in one place", () => {
    expect(SPEECH_MODELS).toEqual({ transcribe: "gpt-4o-mini-transcribe", speak: "gpt-4o-mini-tts" });
  });
});

describe("recording length", () => {
  it("reads an Ogg Opus recording's length from its last page", () => {
    expect(oggOpusDurationSeconds(oggOpus(12.5))).toBeCloseTo(12.5, 3);
    expect(billableAudioSeconds(oggOpus(12.5), 1)).toBe(13);
  });

  it("falls back to the stated length, then to a floor estimate from the size", () => {
    const webm = Buffer.alloc(40_000, 1);
    expect(oggOpusDurationSeconds(webm)).toBeNull();
    expect(billableAudioSeconds(webm, 7.2)).toBe(8);
    expect(billableAudioSeconds(webm)).toBe(10);
    expect(billableAudioSeconds(Buffer.alloc(10, 1))).toBe(1);
  });
});

describe("what is read aloud", () => {
  it("drops links, file ids, code and formatting marks", () => {
    const { text, truncated } = prepareSpokenText(
      "## Salg\n**12 sofaer** solgt. [Rapport](https://x.example/r) er klar.\n```\ncode()\n```\nFil 0f000000-0000-4000-8000-000000000001 ligger i Files: www.example.com/a",
    );
    expect(truncated).toBe(false);
    expect(text).toBe("Salg\n12 sofaer solgt. Rapport er klar.\nFil ligger i Files:");
  });

  it("stops on a sentence and says the rest is in the text", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Setning ${i} er her.`).join(" ");
    const { text, truncated } = prepareSpokenText(long, 200);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith(`er her. ${SPEECH_REST_IN_TEXT}`)).toBe(true);
  });

  it("is empty when there is only a link", () => {
    expect(prepareSpokenText("https://example.com/a").text).toBe("");
  });
});

describe("the daily allowance", () => {
  it("resets at midnight UTC", () => {
    expect(startOfUtcDay(new Date("2026-09-28T23:30:00+02:00")).toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });
});
