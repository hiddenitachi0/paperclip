import { describe, expect, it } from "vitest";
import {
  SKILL_GROUPS,
  firstSentence,
  groupSkills,
  matchesSkillSearch,
  skillGroupFor,
  stripInlineMarkdown,
  type GroupableSkill,
} from "./skill-groups";

/** The 16 skills on Filip's board, with their tags as stored. */
const BOARD_SKILLS: Array<GroupableSkill & { expected: string }> = [
  {
    slug: "agent-browser",
    name: "agent-browser",
    categories: ["browser", "puppeteer", "playwright", "verification"],
    description: "Drive a real browser to check pages, click through flows and take screenshots.",
    expected: "Web and browser",
  },
  {
    slug: "design-critique",
    name: "design-critique",
    categories: ["design", "product", "ux", "review"],
    description:
      "Give a structured product design critique — user job clarity, hierarchy, affordance, error states, accessibility, and consistency — focused on what to change, in what order, and why.",
    expected: "Design and review",
  },
  {
    slug: "doc-maintenance",
    name: "doc-maintenance",
    categories: ["docs", "documentation", "release-notes"],
    description:
      "Keep project docs aligned with recent code and feature changes — detect drift, update affected pages, and add release-relevant notes without rewriting unchanged sections.",
    expected: "Research and writing",
  },
  {
    slug: "issue-triage",
    name: "issue-triage",
    categories: ["paperclip", "triage", "inbox", "workflow", "paperclip-operations"],
    description:
      "Triage Paperclip inbox issues that are stale, blocked, in-review, or assigned-but-not-progressing, and decide a single next action per issue.",
    expected: "Paperclip work and planning",
  },
  {
    slug: "karpathy-guidelines",
    name: "karpathy-guidelines",
    categories: [],
    description:
      "Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication.",
    expected: "Coding practice",
  },
  {
    slug: "link-checker",
    name: "link-checker",
    categories: [],
    description: "Crawl a website and report broken internal and external links, using the server link-checker service.",
    expected: "Web and browser",
  },
  {
    slug: "opencode-local-ollama",
    name: "opencode-local-ollama",
    categories: [],
    description: "Run OpenCode against a model served by a local Ollama install.",
    expected: "Setup and admin",
  },
  {
    slug: "paperclip",
    name: "paperclip",
    categories: [],
    description:
      "Interact with the Paperclip control plane API to manage tasks, coordinate with other agents, and follow company governance.",
    expected: "Paperclip work and planning",
  },
  {
    slug: "paperclip-board",
    name: "paperclip-board",
    categories: [],
    description: "Manage a Paperclip company as a board member via chat.",
    expected: "Paperclip work and planning",
  },
  {
    slug: "paperclip-converting-plans-to-tasks",
    name: "paperclip-converting-plans-to-tasks",
    categories: [],
    description:
      "The Paperclip way of converting a plan into executable tasks. Use whenever you are asked to plan, scope, or break down work inside a Paperclip company.",
    expected: "Paperclip work and planning",
  },
  {
    slug: "paperclip-create-agent",
    name: "paperclip-create-agent",
    categories: [],
    description: "Create new agents in Paperclip with governance-aware hiring.",
    expected: "Paperclip work and planning",
  },
  {
    slug: "para-memory-files",
    name: "para-memory-files",
    categories: [],
    description:
      "File-based memory system using Tiago Forte's PARA method. Use this skill whenever you need to store, retrieve, update, or organize knowledge across sessions.",
    expected: "Memory and notes",
  },
  {
    slug: "release-announcement",
    name: "release-announcement",
    categories: ["release", "changelog", "announcement", "communication", "content"],
    description:
      "Write a release announcement — changelog, blog post, in-app note, or social post — that leads with user impact.",
    expected: "Research and writing",
  },
  {
    slug: "research-and-plan",
    name: "research-and-plan",
    categories: [],
    description:
      'How to research on the web and deliver a ready-to-read result page on a Paperclip task: trip plans and itineraries, price hunts ("find the best price on X").',
    expected: "Research and writing",
  },
  {
    slug: "task-planning",
    name: "task-planning",
    categories: ["paperclip", "planning", "issues", "delegation", "paperclip-operations"],
    description:
      "Turn a Paperclip issue or request into a structured implementation plan with child task graph, blockers, owners, and acceptance criteria.",
    expected: "Paperclip work and planning",
  },
  {
    slug: "wireframe",
    name: "wireframe",
    categories: ["design", "wireframe", "ux", "prototyping", "svg", "product"],
    description: "Sketch a low-fidelity wireframe as an SVG before building a screen.",
    expected: "Design and review",
  },
];

describe("skillGroupFor", () => {
  it.each(BOARD_SKILLS.map((skill) => [skill.slug, skill]))("puts %s in the right group", (_slug, skill) => {
    expect(skillGroupFor(skill).label).toBe(skill.expected);
  });

  it("places the board's skills the same way when they have no description at all", () => {
    for (const skill of BOARD_SKILLS) {
      expect(skillGroupFor({ ...skill, description: null }).label, skill.slug ?? "").toBe(skill.expected);
    }
  });

  it("uses tags before the name", () => {
    // The name says "paperclip", but the tags say it is about the browser.
    expect(
      skillGroupFor({ slug: "paperclip-screenshots", name: "Paperclip screenshots", categories: ["browser", "playwright"] })
        .label,
    ).toBe("Web and browser");
  });

  it("falls back to the name when the tags point nowhere", () => {
    expect(skillGroupFor({ slug: "wiki-query", name: "wiki-query", categories: ["llm"] }).label).toBe("Memory and notes");
  });

  it("uses the description when neither tags nor name say anything", () => {
    expect(
      skillGroupFor({ slug: "brief", name: "Brief", categories: [], description: "Keeps a daily journal of decisions." })
        .label,
    ).toBe("Memory and notes");
  });

  it("matches whole words only", () => {
    // "para" must not match "parallel", "link" must not match "linkedin".
    expect(skillGroupFor({ slug: "parallel-linkedin", name: "parallel-linkedin" }).label).toBe("Other");
  });

  it("treats tag spelling and case loosely", () => {
    expect(skillGroupFor({ slug: "x", name: "x", categories: ["Release Notes"] }).label).toBe("Research and writing");
    expect(skillGroupFor({ slug: "x", name: "x", categories: ["Paperclip_Operations"] }).label).toBe(
      "Paperclip work and planning",
    );
  });

  it("uses the last part of the key when the slug is missing", () => {
    expect(skillGroupFor({ key: "paperclipai/paperclip/para-memory-files", name: "Notes helper" }).label).toBe(
      "Memory and notes",
    );
  });

  it("puts skills with nothing recognisable in Other", () => {
    expect(skillGroupFor({ slug: "brag", name: "brag", categories: [], description: "Make it shiny." }).label).toBe(
      "Other",
    );
  });
});

describe("groupSkills", () => {
  it("returns only non-empty groups, in the fixed order", () => {
    const groups = groupSkills(BOARD_SKILLS);
    expect(groups.map((entry) => entry.group.label)).toEqual([
      "Paperclip work and planning",
      "Research and writing",
      "Design and review",
      "Coding practice",
      "Web and browser",
      "Memory and notes",
      "Setup and admin",
    ]);
    expect(groups.reduce((total, entry) => total + entry.skills.length, 0)).toBe(16);
  });

  it("lists the skills that are on first, then the rest, each alphabetically", () => {
    const on = new Set(["task-planning", "paperclip-board"]);
    const [paperclipGroup] = groupSkills(BOARD_SKILLS, (skill) => on.has(skill.slug ?? ""));
    expect(paperclipGroup!.group.label).toBe("Paperclip work and planning");
    expect(paperclipGroup!.selectedCount).toBe(2);
    expect(paperclipGroup!.skills.map((skill) => skill.slug)).toEqual([
      "paperclip-board",
      "task-planning",
      "issue-triage",
      "paperclip",
      "paperclip-converting-plans-to-tasks",
      "paperclip-create-agent",
    ]);
  });

  it("keeps Other last", () => {
    const groups = groupSkills([{ slug: "zzz", name: "zzz" }, { slug: "wiki", name: "wiki" }]);
    expect(groups.map((entry) => entry.group.label)).toEqual(["Memory and notes", "Other"]);
    expect(SKILL_GROUPS[SKILL_GROUPS.length - 1]!.label).toBe("Other");
  });
});

describe("matchesSkillSearch", () => {
  it("finds a skill by name or description, ignoring case", () => {
    const skill = BOARD_SKILLS.find((entry) => entry.slug === "link-checker")!;
    expect(matchesSkillSearch(skill, "LINK")).toBe(true);
    expect(matchesSkillSearch(skill, "broken internal")).toBe(true);
    expect(matchesSkillSearch(skill, "wireframe")).toBe(false);
    expect(matchesSkillSearch(skill, "  ")).toBe(true);
  });
});

describe("firstSentence", () => {
  it("cuts a long description after the first sentence", () => {
    expect(
      firstSentence("Behavioral guidelines to reduce mistakes. Use when writing, reviewing, or refactoring code."),
    ).toEqual({ first: "Behavioral guidelines to reduce mistakes.", hasMore: true });
  });

  it("keeps a single sentence whole", () => {
    expect(firstSentence("Crawl a website and report broken links.")).toEqual({
      first: "Crawl a website and report broken links.",
      hasMore: false,
    });
  });

  it("does not stop at e.g. or i.e.", () => {
    expect(firstSentence("Plan trips (e.g. itineraries) and price hunts. Never book anything.").first).toBe(
      "Plan trips (e.g. itineraries) and price hunts.",
    );
  });

  it("stops at the end of the first paragraph and joins wrapped lines", () => {
    expect(firstSentence("Manage a company\nas a board member\n\nCovers onboarding.")).toEqual({
      first: "Manage a company as a board member",
      hasMore: true,
    });
  });

  it("handles empty text", () => {
    expect(firstSentence(null)).toEqual({ first: "", hasMore: false });
    expect(firstSentence("   ")).toEqual({ first: "", hasMore: false });
  });
});

describe("stripInlineMarkdown", () => {
  it("drops code ticks, bold markers and link syntax for a plain preview", () => {
    expect(stripInlineMarkdown("Use `operationType: \"query\"` with **care**, see [the docs](https://x.y).")).toBe(
      'Use operationType: "query" with care, see the docs.',
    );
  });

  it("leaves snake_case words alone", () => {
    expect(stripInlineMarkdown("Reads release_notes and plain text.")).toBe("Reads release_notes and plain text.");
  });
});
