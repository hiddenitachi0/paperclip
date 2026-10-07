import { describe, expect, it } from "vitest";
import {
  buildLaneAActionClaimRetryNote,
  detectLaneAActionClaim,
  detectLaneAPictureRequest,
  pickLaneAForcedToolName,
} from "../services/lane-a-action-claims.ts";
import { parseLaneATextToolCall } from "../services/lane-a-text-tool-calls.ts";

/**
 * 7-8 Oct: Maja made the first picture of a conversation, then answered every
 * follow-up ("another one from a different angle", "other angles") with text
 * and no picture -- on qwen3.8-27b and on Mistral Small 3.2. The replies and
 * requests below are the real ones from those conversations.
 */

const MEDIA_TOOLS = [
  "paperclip_media-studio__list-looks",
  "paperclip_media-studio__generate-image",
  "paperclip_media-studio__quick-picture",
  "paperclip_media-studio__generate-video",
  "paperclip_media-studio__generate-audio",
  "paperclip_media-studio__check-media-job",
  "paperclip_media-studio__improve-picture-prompt",
  "get_weather",
];

describe("replies that pretend to have made a picture", () => {
  it("catches a copied replay note", () => {
    const reply = "Mmm, sure thing boss, check this out\n\n[Picture made in this turn: file id 1234, seed 9. It was made by a picture tool call]";
    expect(detectLaneAActionClaim(reply)?.family).toBe("media");
  });

  it("catches 'another image' and other new wordings", () => {
    expect(detectLaneAActionClaim("I'll generate another image for you, but this time with a different angle.")?.family).toBe("media");
    expect(detectLaneAActionClaim("Here are some new pictures from the other side!")?.family).toBe("media");
    expect(detectLaneAActionClaim("I made a new picture just for you")?.family).toBe("media");
    expect(detectLaneAActionClaim("Her er et nytt bilde, sjef!")?.family).toBe("media");
  });

  it("catches a picture call written out as broken JSON", () => {
    const reply = '{"name":"generate-image","parameters":{"prompt":"An angel on a cloud 🔗,"look":"Maja Night"}}';
    expect(detectLaneAActionClaim(reply)?.family).toBe("media");
  });

  it("still leaves ordinary chat alone", () => {
    expect(detectLaneAActionClaim("I'll take a shot at answering that.")).toBeNull();
    expect(detectLaneAActionClaim("Pictures from that trip would be great.")).toBeNull();
  });
});

describe("detectLaneAPictureRequest", () => {
  it("recognises the real requests from 7-8 Oct", () => {
    const after = { pictureEarlier: true };
    expect(detectLaneAPictureRequest("Ooh I like it 😍 send me another image from a different angle", after)).toBe(true);
    expect(detectLaneAPictureRequest("Looking good, experiment with some other angles", after)).toBe(true);
    expect(detectLaneAPictureRequest("Improvise, show me the artistic side of yourself through an image", after)).toBe(true);
    expect(detectLaneAPictureRequest("Try again, i didnt get an image. Show me an image of yourself", after)).toBe(true);
    expect(detectLaneAPictureRequest("Show me with an image how you would dress for this weather", { pictureEarlier: false })).toBe(true);
  });

  it("recognises Norwegian requests", () => {
    expect(detectLaneAPictureRequest("Send meg et bilde av fjorden", { pictureEarlier: false })).toBe(true);
    expect(detectLaneAPictureRequest("Lag et nytt bilde", { pictureEarlier: false })).toBe(true);
    expect(detectLaneAPictureRequest("En til, fra en annen vinkel", { pictureEarlier: true })).toBe(true);
  });

  it("counts short follow-ups only right after a picture", () => {
    expect(detectLaneAPictureRequest("one more please", { pictureEarlier: true })).toBe(true);
    expect(detectLaneAPictureRequest("one more please", { pictureEarlier: false })).toBe(false);
    expect(detectLaneAPictureRequest("try again", { pictureEarlier: false })).toBe(false);
  });

  it("does not treat questions about a picture, or other chat, as a request", () => {
    const after = { pictureEarlier: true };
    expect(detectLaneAPictureRequest("What do you think of this image?", after)).toBe(false);
    expect(detectLaneAPictureRequest("Do you like the picture?", after)).toBe(false);
    expect(detectLaneAPictureRequest("How's the weather like in Drøbak?", after)).toBe(false);
    expect(detectLaneAPictureRequest("Hva synes du om bildet?", after)).toBe(false);
  });
});

describe("pickLaneAForcedToolName for media", () => {
  it("forces the picture generator, never a helper that only lists looks", () => {
    expect(pickLaneAForcedToolName("media", MEDIA_TOOLS, "send me another image")).toBe("paperclip_media-studio__generate-image");
  });

  it("forces the video or sound generator when that is what was asked", () => {
    expect(pickLaneAForcedToolName("media", MEDIA_TOOLS, "make me a short video of it")).toBe("paperclip_media-studio__generate-video");
    expect(pickLaneAForcedToolName("media", MEDIA_TOOLS, "make a song about Mondays")).toBe("paperclip_media-studio__generate-audio");
  });

  it("returns null when only helpers are offered", () => {
    expect(pickLaneAForcedToolName("media", ["paperclip_media-studio__list-looks", "get_weather"], "a picture")).toBeNull();
  });
});

describe("buildLaneAActionClaimRetryNote", () => {
  it("says the person asked when the retry comes from a request", () => {
    expect(buildLaneAActionClaimRetryNote("media", "request")).toContain("The person asked you to make the picture");
    expect(buildLaneAActionClaimRetryNote("media")).toContain("You said you would make the picture");
  });
});

describe("parseLaneATextToolCall", () => {
  const offered = MEDIA_TOOLS;

  it("turns a whole-reply JSON call into a real call to the offered tool", () => {
    const call = parseLaneATextToolCall('{"name":"generate-image","parameters":{"prompt":"A lighthouse at dusk","look":"Maja Night"}}', offered, "t1");
    expect(call).toEqual({ id: "t1", name: "paperclip_media-studio__generate-image", input: { prompt: "A lighthouse at dusk", look: "Maja Night" } });
  });

  it("accepts fenced, OpenAI-style and string-argument shapes", () => {
    expect(parseLaneATextToolCall('```json\n{"name":"get_weather","arguments":{"location":"Bergen"}}\n```', offered, "a")?.name).toBe("get_weather");
    expect(
      parseLaneATextToolCall('{"type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Oslo\\"}"}}', offered, "b")?.input,
    ).toEqual({ location: "Oslo" });
    expect(parseLaneATextToolCall('<tool_call>{"name":"get_weather","arguments":{"location":"Oslo"}}</tool_call>', offered, "c")?.name).toBe("get_weather");
  });

  it("ignores text around JSON, unknown or ambiguous tools, broken JSON and non-object arguments", () => {
    expect(parseLaneATextToolCall('Sure! {"name":"get_weather","arguments":{}}', offered, "x")).toBeNull();
    expect(parseLaneATextToolCall('{"name":"delete_everything","arguments":{}}', offered, "x")).toBeNull();
    expect(parseLaneATextToolCall('{"name":"generate-image","parameters":{"prompt":"broken}', offered, "x")).toBeNull();
    expect(parseLaneATextToolCall('{"name":"get_weather","arguments":[1,2]}', offered, "x")).toBeNull();
    expect(parseLaneATextToolCall('{"name":"generate","arguments":{}}', ["a__generate", "b__generate"], "x")).toBeNull();
    expect(parseLaneATextToolCall('{"name":"get_weather"}', [], "x")).toBeNull();
  });
});
