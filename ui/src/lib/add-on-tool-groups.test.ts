import { describe, expect, it } from "vitest";
import {
  OTHER_TOOLS_GROUP,
  addOnToolGroupKey,
  groupAddOnTools,
  selectionWithGroup,
  splitFirstSentence,
} from "./add-on-tool-groups";

describe("groupAddOnTools", () => {
  it("uses the category, else the add-on's name, else 'Other tools', in the fixed media order then A to Z", () => {
    const groups = groupAddOnTools([
      { name: "v", category: "Video and sound", pluginDisplayName: "Media Studio" },
      { name: "z", category: null, pluginDisplayName: "Zapier" },
      { name: "o", category: "", pluginDisplayName: "" },
      { name: "e", category: "Picture editing", pluginDisplayName: "Media Studio" },
      { name: "b", category: "billing", pluginDisplayName: "Acme" },
      { name: "p1", category: "Pictures", pluginDisplayName: "Media Studio" },
      { name: "a", pluginDisplayName: "Acme" },
      { name: "p2", category: " Pictures ", pluginDisplayName: "Other add-on" },
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      "Pictures",
      "Picture editing",
      "Video and sound",
      "Acme",
      "billing",
      "Zapier",
      OTHER_TOOLS_GROUP,
    ]);
    // Inside a group the server's order is kept, across add-ons.
    expect(groups[0]!.tools.map((tool) => tool.name)).toEqual(["p1", "p2"]);
    expect(groups.map((group) => group.key)).toEqual([
      "pictures",
      "picture-editing",
      "video-and-sound",
      "acme",
      "billing",
      "zapier",
      "other-tools",
    ]);
  });

  it("puts names that differ only in case into one group, so keys never clash", () => {
    const result = groupAddOnTools([
      { name: "a", category: "Pictures" },
      { name: "b", category: "pictures" },
      { name: "c", category: "Big charts" },
      { name: "d", category: "big-charts" },
    ]);
    expect(result.map((group) => [group.title, group.key, group.tools.map((tool) => tool.name)])).toEqual([
      ["Pictures", "pictures", ["a", "b"]],
      ["Big charts", "big-charts", ["c", "d"]],
    ]);
  });

  it("returns no groups for no tools", () => {
    expect(groupAddOnTools([])).toEqual([]);
  });

  it("makes a storage-safe key even from symbols only", () => {
    expect(addOnToolGroupKey("Video / Sound!")).toBe("video-sound");
    expect(addOnToolGroupKey("???")).toBe("group");
  });
});

describe("splitFirstSentence", () => {
  it("cuts at the first real sentence end", () => {
    expect(splitFirstSentence("Make music with Fal.ai. This can take a while.")).toEqual({
      first: "Make music with Fal.ai.",
      rest: "This can take a while.",
    });
    expect(splitFirstSentence('Lists names only. "Show" a look with generate-image.')).toEqual({
      first: "Lists names only.",
      rest: '"Show" a look with generate-image.',
    });
  });

  it("does not cut at decimals or a lower-case continuation", () => {
    expect(splitFirstSentence("Positions from 0.5 to 1, e.g. the sofa. Second.")).toEqual({
      first: "Positions from 0.5 to 1, e.g. the sofa.",
      rest: "Second.",
    });
  });

  it("keeps a single sentence whole, with nothing more to show", () => {
    expect(splitFirstSentence("Make a picture from a short description.")).toEqual({
      first: "Make a picture from a short description.",
      rest: "",
    });
    expect(splitFirstSentence("No full stop at all")).toEqual({ first: "No full stop at all", rest: "" });
  });
});

describe("selectionWithGroup", () => {
  it("adds every tool of the group without duplicates, keeping other ticks", () => {
    expect(selectionWithGroup(["x", "a"], ["a", "b"], true)).toEqual(["x", "a", "b"]);
  });

  it("removes only the group's tools", () => {
    expect(selectionWithGroup(["x", "a", "b"], ["a", "b"], false)).toEqual(["x"]);
  });
});
