import { describe, expect, it } from "vitest";
import { isSeededBragPosition } from "../services/position-catalogue.js";

const seeded = {
  key: "brag",
  isBuiltin: true,
  skillKeys: ["paperclipai/optional/content/brag"],
  defaultGrants: [],
  connectorKeys: [],
  defaultMcpServers: [],
} as never;

describe("isSeededBragPosition (DUR-4802 finding 3)", () => {
  it("matches only the position Paperclip seeded", () => {
    expect(isSeededBragPosition(seeded)).toBe(true);
  });

  it("leaves a user-made or customised Brag position alone", () => {
    const base = seeded as Record<string, unknown>;
    expect(isSeededBragPosition({ ...base, isBuiltin: false } as never)).toBe(false);
    expect(isSeededBragPosition({ ...base, defaultGrants: [{ permissionKey: "merges:request" }] } as never)).toBe(false);
    expect(isSeededBragPosition({ ...base, connectorKeys: ["gmail"] } as never)).toBe(false);
    expect(isSeededBragPosition({ ...base, defaultMcpServers: [{ name: "x" }] } as never)).toBe(false);
    expect(
      isSeededBragPosition({ ...base, skillKeys: ["paperclipai/optional/content/brag", "paperclipai/paperclip/paperclip"] } as never),
    ).toBe(false);
    expect(isSeededBragPosition({ ...base, key: "content-video-producer" } as never)).toBe(false);
  });
});
