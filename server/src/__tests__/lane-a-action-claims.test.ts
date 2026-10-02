import { describe, expect, it } from "vitest";
import {
  buildLaneAActionClaimFallbackLine,
  buildLaneAActionClaimRetryNote,
  detectLaneAActionClaim,
  isLaneAActionClaimFulfilled,
  pickLaneAForcedToolName,
} from "../services/lane-a-action-claims.ts";
import type { LaneAAction } from "../services/lane-a.ts";

describe("detectLaneAActionClaim", () => {
  it("catches an English media claim with no tool call behind it", () => {
    expect(detectLaneAActionClaim("Here is your picture!")?.family).toBe("media");
    expect(detectLaneAActionClaim("I'm generating a picture of myself now...")?.family).toBe("media");
    expect(detectLaneAActionClaim("[Generating a picture of a sunset]")?.family).toBe("media");
    expect(detectLaneAActionClaim("I'll fix it and give you another attempt")?.family).toBe("media");
  });

  it("catches a Norwegian media claim with no tool call behind it", () => {
    expect(detectLaneAActionClaim("Her er bildet ditt!")?.family).toBe("media");
    expect(detectLaneAActionClaim("Jeg lager et bilde til deg nå.")?.family).toBe("media");
  });

  it("catches English and Norwegian memory claims", () => {
    expect(detectLaneAActionClaim("I've remembered that for you.")?.family).toBe("memory");
    expect(detectLaneAActionClaim("I'll remember this.")?.family).toBe("memory");
    expect(detectLaneAActionClaim("Jeg har lagret det.")?.family).toBe("memory");
    expect(detectLaneAActionClaim("Jeg skal huske dette.")?.family).toBe("memory");
  });

  it("catches English and Norwegian task claims", () => {
    expect(detectLaneAActionClaim("I've started the job for you.")?.family).toBe("task");
    expect(detectLaneAActionClaim("I'll get started on that task.")?.family).toBe("task");
    expect(detectLaneAActionClaim("Jeg har startet jobben.")?.family).toBe("task");
    expect(detectLaneAActionClaim("Jeg skal sette i gang oppgaven.")?.family).toBe("task");
  });

  it("catches English and Norwegian lookup claims", () => {
    expect(detectLaneAActionClaim("I've checked the weather for you.")?.family).toBe("lookup");
    expect(detectLaneAActionClaim("Let me check the price for you.")?.family).toBe("lookup");
    expect(detectLaneAActionClaim("Jeg har sjekket været.")?.family).toBe("lookup");
    expect(detectLaneAActionClaim("Jeg skal sjekke prisene.")?.family).toBe("lookup");
  });

  it("does not flag ordinary chat", () => {
    expect(detectLaneAActionClaim("Hi! How can I help you today?")).toBeNull();
    expect(detectLaneAActionClaim("I think the weather here is usually nice in June.")).toBeNull();
    expect(detectLaneAActionClaim("Pictures from that trip would be great.")).toBeNull();
    expect(detectLaneAActionClaim("Jeg liker bilder av fjell.")).toBeNull();
    expect(detectLaneAActionClaim("Jeg husker at du sa det i går.")).toBeNull();
  });
});

describe("isLaneAActionClaimFulfilled", () => {
  const ok = (tool: string, extra: Partial<LaneAAction> = {}): LaneAAction => ({ tool, summary: "", ok: true, ...extra } as LaneAAction);
  const failed = (tool: string): LaneAAction => ({ tool, summary: "", ok: false } as LaneAAction);

  it("is fulfilled when a matching tool succeeded, by exact name", () => {
    expect(isLaneAActionClaimFulfilled("memory", [ok("remember")])).toBe(true);
    expect(isLaneAActionClaimFulfilled("task", [ok("start_job")])).toBe(true);
    expect(isLaneAActionClaimFulfilled("lookup", [ok("get_weather")])).toBe(true);
  });

  it("is fulfilled for media by the real Media Studio tool name (dash, not underscore)", () => {
    expect(isLaneAActionClaimFulfilled("media", [ok("paperclip_media-studio__generate-image")])).toBe(true);
  });

  it("is fulfilled for media by any tool that actually produced an image", () => {
    expect(isLaneAActionClaimFulfilled("media", [ok("acme_pictures__make-picture", { image: { fileId: "x" } } as never)])).toBe(true);
  });

  it("is not fulfilled by a failed call, an unrelated tool, or no calls at all", () => {
    expect(isLaneAActionClaimFulfilled("memory", [failed("remember")])).toBe(false);
    expect(isLaneAActionClaimFulfilled("memory", [ok("get_weather")])).toBe(false);
    expect(isLaneAActionClaimFulfilled("media", [])).toBe(false);
  });
});

describe("pickLaneAForcedToolName", () => {
  it("finds the offered tool matching the family", () => {
    expect(pickLaneAForcedToolName("memory", ["get_weather", "remember", "forget"])).toBe("remember");
    expect(pickLaneAForcedToolName("media", ["paperclip_media-studio__generate-image", "get_weather"])).toBe(
      "paperclip_media-studio__generate-image",
    );
  });

  it("returns null when no offered tool matches", () => {
    expect(pickLaneAForcedToolName("memory", ["get_weather", "start_job"])).toBeNull();
    expect(pickLaneAForcedToolName("media", [])).toBeNull();
  });
});

describe("retry note and fallback line builders", () => {
  it("names the specific action in both the retry note and the fallback line", () => {
    expect(buildLaneAActionClaimRetryNote("media")).toContain("make the picture");
    expect(buildLaneAActionClaimRetryNote("media")).toContain("Call the tool now, or say plainly that you cannot.");
    expect(buildLaneAActionClaimFallbackLine("media")).toBe("I could not make the picture this time.");
    expect(buildLaneAActionClaimFallbackLine("memory")).toBe("I could not save that to memory this time.");
    expect(buildLaneAActionClaimFallbackLine("task")).toBe("I could not start the job this time.");
    expect(buildLaneAActionClaimFallbackLine("lookup")).toBe("I could not check that this time.");
  });
});
