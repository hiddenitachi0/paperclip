import { describe, expect, it } from "vitest";
import { laneAEmptyReplyFallback } from "../services/lane-a.js";

describe("laneAEmptyReplyFallback", () => {
  it("names that a tool ran when the empty reply followed a tool call", () => {
    const actions = [{ tool: "paperclip_media-studio__list-looks", summary: "Used the List saved looks (Media Studio) add-on tool.", ok: true }] as never;
    const text = laneAEmptyReplyFallback(actions);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("model gave no answer");
  });

  it("gives a plain non-empty reply even when no tool was called", () => {
    const text = laneAEmptyReplyFallback([]);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("model gave no answer");
  });
});
