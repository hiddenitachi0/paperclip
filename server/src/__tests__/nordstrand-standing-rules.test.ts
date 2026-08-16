import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STANDING_RULES_BLOCK,
  buildNordstrandCompanyInstructionsMarkdown,
  buildNordstrandStandingRulesSkillMarkdown,
  extractStandingRulesBlock,
} from "../services/nordstrand-standing-rules.js";

const RULE_HEADING_RE = /^(\d+)\. /gm;

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SEARCH_ROOTS = [
  path.join(REPO_ROOT, "skills"),
];

async function walkMarkdownFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return out;
}

describe("Nordstrand standing rules (DUR-33 drift guard)", () => {
  it("seeds exactly nine numbered rules", () => {
    const matches = [...STANDING_RULES_BLOCK.matchAll(RULE_HEADING_RE)].map((match) => Number(match[1]));
    expect(matches).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps rule 8 (no intercompany elimination) and rule 9 (discounted/B-grade sales dimension)", () => {
    expect(STANDING_RULES_BLOCK).toContain("8. No intercompany elimination");
    expect(STANDING_RULES_BLOCK).toContain(
      "9. Discounted and B-grade sales are their own dimension and never fall into a margin denominator.",
    );
  });

  it("does not regress to the seven-rule draft", () => {
    const ruleCount = [...STANDING_RULES_BLOCK.matchAll(RULE_HEADING_RE)].length;
    expect(ruleCount).toBe(9);
    expect(ruleCount).not.toBe(7);
  });

  it("COMPANY.md's rules block is byte-identical to the nordstrand-standing-rules skill's block", () => {
    const companyMarkdown = buildNordstrandCompanyInstructionsMarkdown();
    const skillMarkdown = buildNordstrandStandingRulesSkillMarkdown();

    const companyBlock = extractStandingRulesBlock(companyMarkdown);
    const skillBlock = extractStandingRulesBlock(skillMarkdown);

    expect(companyBlock).not.toBeNull();
    expect(skillBlock).not.toBeNull();
    expect(companyBlock).toBe(skillBlock);
  });

  it("fails on a planted re-paste: mutating one copy breaks byte-identity", () => {
    const companyMarkdown = buildNordstrandCompanyInstructionsMarkdown();
    const tamperedSkillMarkdown = buildNordstrandStandingRulesSkillMarkdown().replace(
      "8. No intercompany elimination",
      "8. Some intercompany elimination",
    );

    const companyBlock = extractStandingRulesBlock(companyMarkdown);
    const tamperedSkillBlock = extractStandingRulesBlock(tamperedSkillMarkdown);

    expect(companyBlock).not.toBe(tamperedSkillBlock);
  });

  it("no agent AGENTS.md or role template still carries a pasted 'Standing rules (non-negotiable)' heading", async () => {
    const agentsMdCandidates = [
      ...(await walkMarkdownFiles(path.join(REPO_ROOT, "skills"))),
    ];
    const offenders: string[] = [];
    for (const filePath of agentsMdCandidates) {
      const content = await fs.readFile(filePath, "utf8").catch(() => "");
      if (/standing rules\s*\(non-negotiable\)/i.test(content)) {
        offenders.push(filePath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
