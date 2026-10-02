import { describe, expect, it } from "vitest";
import { GENERATE_IMAGE_DESCRIPTION, LIST_LOOKS_DESCRIPTION } from "../../../packages/plugins/media-studio/src/manifest.js";

// DUR-4371: a local model ("show me in looks of X") picked list-looks over
// generate-image and made up the look's arguments. Both descriptions must
// say, plainly, which tool is for showing/making a picture and which is only
// for listing names, so a small model does not have to infer it.
describe("media-studio tool descriptions route picture requests away from list-looks", () => {
  it("generate-image says it is the tool for showing/making/drawing a picture in or with a look", () => {
    expect(GENERATE_IMAGE_DESCRIPTION).toMatch(/show, make or draw a picture/i);
    expect(GENERATE_IMAGE_DESCRIPTION).toContain("list-looks only lists names");
  });

  it("list-looks says it is only for listing which looks exist, and points to generate-image for a picture", () => {
    expect(LIST_LOOKS_DESCRIPTION).toMatch(/^ONLY for when the person asks which looks exist/);
    expect(LIST_LOOKS_DESCRIPTION).toContain("it never shows, makes or draws a picture");
    expect(LIST_LOOKS_DESCRIPTION).toContain("use generate-image");
  });
});
