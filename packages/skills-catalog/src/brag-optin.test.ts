import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(here, "../generated/catalog.json"), "utf8"));

describe("brag skill (script-bearing) policy", () => {
  const brag = catalog.skills.find((s: { slug: string }) => s.slug === "brag");

  it("is opt-in only and never default-installed", () => {
    expect(brag).toBeTruthy();
    expect(brag.defaultInstall).toBe(false);
  });

  it("does not vendor music files", () => {
    const paths: string[] = brag.files.map((f: { path: string }) => f.path);
    expect(paths.some((p) => p.startsWith("assets/music/"))).toBe(false);
  });

  it("audio reference carries the no-bundled-music policy banner", () => {
    const audio = readFileSync(
      path.join(here, "../catalog/optional/content/brag/references/audio.md"),
      "utf8",
    );
    expect(audio.startsWith("> **PAPERCLIP POLICY — NO BUNDLED MUSIC.**")).toBe(true);
    expect(audio).not.toMatch(/cp <skill-dir>\/assets\/music/);
  });
});
