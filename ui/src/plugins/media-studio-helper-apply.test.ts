import { describe, expect, it } from "vitest";
import { HELPER_APPLY_EVENT as HOST_EVENT } from "../lib/helper-apply";
import { HELPER_APPLY_EVENT as PLUGIN_EVENT, parseSheetText } from "../../../packages/plugins/media-studio/src/ui/index";

describe("Media Studio look editor ← Ask Paperclip", () => {
  it("uses the same apply event name as the host", () => {
    expect(PLUGIN_EVENT).toBe(HOST_EVENT);
  });

  it("reads a written character sheet into the sheet fields by label or key", () => {
    expect(
      parseSheetText(
        [
          "- **Hair:** long, blonde, loose waves",
          "Eyes: green",
          "2. Expression: soft smile",
          "Art style: natural photograph",
          "Mood: cheerful", // not a sheet field
          "Some sentence without a colon",
        ].join("\n"),
      ),
    ).toEqual({ hair: "long, blonde, loose waves", eyes: "green", expression: "soft smile", artStyle: "natural photograph" });
  });
});
