// Agents must not start brag videos by themselves -- only when a person asks.
// The skills and the Content & Video Producer position say so in words the
// agent reads; the server enforces it separately (board-only Brag routes,
// person-only "brag video when this is done" tick box).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POSITION_CATALOGUE } from "@paperclipai/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "../catalog/optional/content", rel), "utf8");
const catalog = JSON.parse(readFileSync(path.join(here, "../generated/catalog.json"), "utf8"));

describe("brag videos only when a person asks", () => {
  it("the brag-video skill forbids starting one on the agent's own initiative", () => {
    const skill = read("brag-video/SKILL.md");
    expect(skill).toMatch(/Never start a brag video on your own initiative/);
    expect(skill).toMatch(/Never start a brag video unless a person asked for it on the task/);
    expect(skill).toMatch(/Make a short brag video when this is done/);
    const description = skill.split("\n").find((line) => line.startsWith("description:"))!;
    expect(description).toMatch(/only when a person asked/i);
    expect(description).toMatch(/Never start one on your own/);
  });

  it("the full /brag skill carries the same rule before anything else", () => {
    const skill = read("brag/SKILL.md");
    const rule = skill.indexOf("PAPERCLIP RULE — ONLY WHEN A PERSON ASKS");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(skill.indexOf("## Invocation dispatch"));
  });

  it("the generated catalogue is up to date with the rule", () => {
    const bragVideo = catalog.skills.find((s: { slug: string }) => s.slug === "brag-video");
    expect(bragVideo.description).toMatch(/Never start one on your own/);
  });

  it("the Content & Video Producer position tells the agent the same", () => {
    const producer = POSITION_CATALOGUE.find((p) => p.key === "content-video-producer")!;
    expect(producer.defaultInstructions).toMatch(/Only make a brag video when a person asked for one/);
  });
});
