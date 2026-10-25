// The ready-to-hire position catalogue (@paperclipai/shared) must only name
// skills that actually ship: catalogue skills from this package, or the
// repo-root skills/ that every company gets automatically. It also checks the
// rest of each template so "Add from catalogue" can never create a broken
// position or job.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_THINKING_EFFORT_LEVELS,
  POSITION_CATALOGUE,
  catalogueSkillIdForKey,
  jobVariableSchema,
} from "@paperclipai/shared";
import { catalogSkills } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoSkillsDir = path.resolve(here, "../../../skills");
const CURRENT_CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

describe("position catalogue", () => {
  it("only references skills that ship with Paperclip", () => {
    const catalogKeys = new Set(catalogSkills.map((skill) => skill.key));
    const problems: string[] = [];
    for (const entry of POSITION_CATALOGUE) {
      for (const key of entry.skillKeys) {
        if (catalogueSkillIdForKey(key)) {
          if (!catalogKeys.has(key)) problems.push(`${entry.key}: ${key} is not in the skills catalogue`);
          continue;
        }
        const match = /^paperclipai\/paperclip\/([a-z0-9-]+)$/.exec(key);
        if (!match || !existsSync(path.join(repoSkillsDir, match[1]!, "SKILL.md"))) {
          problems.push(`${entry.key}: ${key} is not a shipped skill`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("uses keys Paperclip derives from the name, with no duplicates", () => {
    const keys = POSITION_CATALOGUE.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of POSITION_CATALOGUE) {
      expect(slugify(entry.name)).toBe(entry.key);
    }
  });

  it("suggests a current Claude model and a valid effort for every position", () => {
    for (const entry of POSITION_CATALOGUE) {
      expect(CURRENT_CLAUDE_MODELS).toContain(entry.suggestedModel);
      expect(CLAUDE_THINKING_EFFORT_LEVELS as readonly string[]).toContain(entry.suggestedEffort);
      expect(entry.modelReason.length).toBeGreaterThan(10);
    }
  });

  it("gives every position the core Paperclip skill and at least one job", () => {
    for (const entry of POSITION_CATALOGUE) {
      expect(entry.skillKeys).toContain("paperclipai/paperclip/paperclip");
      expect(entry.jobs.length).toBeGreaterThan(0);
      expect(entry.defaultInstructions).toContain("Nothing leaves the company without a person's approval");
    }
  });

  it("only uses job variables that are valid and declared", () => {
    for (const entry of POSITION_CATALOGUE) {
      for (const job of entry.jobs) {
        const declared = new Set(job.variables.map((variable) => variable.name));
        for (const variable of job.variables) {
          expect(jobVariableSchema.safeParse(variable).success, `${entry.key} / ${job.title} / ${variable.name}`).toBe(true);
        }
        for (const [, name] of job.instructions.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
          expect(declared.has(name!), `${entry.key} / ${job.title} uses {{${name}}}`).toBe(true);
        }
      }
    }
  });

  it("has no Brag position: Brag is a skill held by the Content & Video Producer", () => {
    expect(POSITION_CATALOGUE.find((entry) => entry.key === "brag")).toBeUndefined();
    const producer = POSITION_CATALOGUE.find((entry) => entry.key === "content-video-producer")!;
    expect(producer.replaces).toEqual(["brag"]);
    expect(producer.skillKeys).toEqual(
      expect.arrayContaining(["paperclipai/optional/content/brag", "paperclipai/optional/content/brag-video"]),
    );
  });

  it("grants merge requests only to building positions and never a deploy request", () => {
    for (const entry of POSITION_CATALOGUE) {
      const keys = entry.defaultGrants.map((grant) => grant.permissionKey);
      expect(keys).not.toContain("deploys:request");
      if (keys.includes("merges:request")) expect(["tech-lead", "developer"]).toContain(entry.key);
    }
  });
});
