import { describe, expect, it } from "vitest";
import { guardLaneAPictureClaims, LANE_A_NO_PICTURE_MADE_NOTE } from "../services/lane-a.js";

describe("guardLaneAPictureClaims", () => {
  const made = [{ tool: "paperclip_media-studio__generate-image", summary: "Made a picture.", ok: true, image: { fileId: "ec1a16d7-4594-4417-93c0-ea2154e30db4", seed: 1, issueId: null, contentPath: "/x", contentType: "image/png" } }] as never;

  it("removes a copied picture note and says plainly no picture was made when no tool made one", () => {
    const reply = "Here I am, boss 😉 [Picture made in this turn: file id 3b46dd3d-8e1e-485b-8291-6d82f2f59687, seed 112908976]";
    const out = guardLaneAPictureClaims(reply, []);
    expect(out).not.toContain("3b46dd3d");
    expect(out).toContain("Here I am, boss");
    expect(out.endsWith(LANE_A_NO_PICTURE_MADE_NOTE)).toBe(true);
  });

  it("only removes the note when a picture really was made", () => {
    const reply = "Here you go! [Picture made in this turn: file id ec1a16d7-4594-4417-93c0-ea2154e30db4, seed 1]";
    const out = guardLaneAPictureClaims(reply, made);
    expect(out).toBe("Here you go!");
  });

  it("leaves ordinary replies untouched", () => {
    expect(guardLaneAPictureClaims("Just chatting, boss.", [])).toBe("Just chatting, boss.");
    expect(guardLaneAPictureClaims("Just chatting, boss.", [])).toBe("Just chatting, boss.");
  });
});
