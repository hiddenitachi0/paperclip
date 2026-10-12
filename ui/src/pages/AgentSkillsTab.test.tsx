// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";

/**
 * The agent's Skills tab, grouped by type: a one-line "On for this agent"
 * list, one collapsible group per kind of skill ("Web and browser", ...),
 * short descriptions with a "More" toggle, a search box once the list is
 * long, and the adapter details tucked into a closed "How skills are applied"
 * block. Ticking a skill still saves the same desired-skills list as before.
 */

const AGENT = "22222222-2222-4222-8222-222222222222";
const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockAgentsApi = vi.hoisted(() => ({ skills: vi.fn(), syncSkills: vi.fn() }));
const mockCompanySkillsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
// The real Markdown renderer needs the theme provider; plain text is enough here.
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/companySkills", () => ({ companySkillsApi: mockCompanySkillsApi }));

const { AgentSkillsTab } = await import("./AgentSkillsTab");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function companySkill(slug: string, categories: string[], description: string) {
  return {
    id: `id-${slug}`,
    companyId: COMPANY,
    key: `paperclipai/paperclip/${slug}`,
    slug,
    name: slug,
    description,
    categories,
  };
}

const LINK_CHECKER = companySkill(
  "link-checker",
  [],
  "Crawl a website and report broken internal and external links. Uses the server link-checker service.",
);
const AGENT_BROWSER = companySkill(
  "agent-browser",
  ["browser", "puppeteer", "playwright", "verification"],
  "Drive a real browser to check pages.",
);
const TASK_PLANNING = companySkill(
  "task-planning",
  ["paperclip", "planning", "issues", "delegation", "paperclip-operations"],
  "Turn a Paperclip issue into a structured plan.",
);
const PAPERCLIP = companySkill("paperclip", [], "Interact with the Paperclip control plane API.");
const WIREFRAME = companySkill("wireframe", ["design", "wireframe", "ux"], "Sketch a wireframe.");

const BASE_SKILLS = [LINK_CHECKER, AGENT_BROWSER, TASK_PLANNING, PAPERCLIP, WIREFRAME];

function snapshot(desiredSkills: string[]) {
  return {
    agentId: AGENT,
    companyId: COMPANY,
    adapterType: "claude_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries: desiredSkills.map((key) => ({
      key,
      runtimeName: key.split("/").pop(),
      desired: true,
      managed: true,
      state: "configured",
      origin: "company_managed",
      detail: "Will be materialized into the stable Paperclip-managed Claude prompt bundle on the next run.",
    })),
    warnings: [],
  };
}

function agent(): Agent {
  return {
    id: AGENT,
    urlKey: "front-desk",
    companyId: COMPANY,
    name: "Front desk",
    role: "general",
    status: "active",
    adapterType: "claude_local",
    adapterConfig: {},
  } as unknown as Agent;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("AgentSkillsTab grouped by type", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompanySkillsApi.list.mockResolvedValue(BASE_SKILLS);
    mockAgentsApi.skills.mockResolvedValue(snapshot([TASK_PLANNING.key, LINK_CHECKER.key]));
    mockAgentsApi.syncSkills.mockImplementation(async (_agentId: string, desired: string[]) => snapshot(desired));
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentSkillsTab agent={agent()} companyId={COMPANY} />
      </QueryClientProvider>,
    );
    await flush();
  }

  const group = (id: string) => container.querySelector<HTMLElement>(`[data-testid="agent-skill-group-${id}"]`);
  const rowNames = (element: Element | null) =>
    Array.from(element?.querySelectorAll('[data-testid="agent-skill-name"]') ?? []).map(
      (node) => node.textContent,
    );
  const checkboxFor = (slug: string) =>
    container.querySelector<HTMLInputElement>(
      `[data-testid="agent-skill-row-paperclipai/paperclip/${slug}"] input[type="checkbox"]`,
    );

  it("lists the skills that are on in one line at the top", async () => {
    await render();
    expect(container.querySelector('[data-testid="agent-skills-on"]')?.textContent).toBe(
      "On for this agent: link-checker, task-planning",
    );
  });

  it("puts each skill in its group, groups in a fixed order, skills that are on first", async () => {
    await render();
    const groups = Array.from(container.querySelectorAll('[data-testid^="agent-skill-group-"]')).map(
      (element) => element.getAttribute("data-testid"),
    );
    expect(groups).toEqual([
      "agent-skill-group-paperclip-work",
      "agent-skill-group-design-review",
      "agent-skill-group-web-browser",
    ]);
    expect(rowNames(group("paperclip-work"))).toEqual(["task-planning", "paperclip"]);
    expect(rowNames(group("web-browser"))).toEqual(["link-checker", "agent-browser"]);
  });

  it("opens groups with a skill that is on and closes the rest with an 'x of y on' summary", async () => {
    await render();
    expect(group("paperclip-work")?.getAttribute("data-state")).toBe("open");
    expect(group("web-browser")?.getAttribute("data-state")).toBe("open");
    const design = group("design-review");
    expect(design?.getAttribute("data-state")).toBe("closed");
    expect(design?.textContent).toContain("0 of 1 on");
    // Closed groups keep their rows mounted, just hidden.
    expect(checkboxFor("wireframe")).not.toBeNull();
  });

  it("shows only the first sentence until More is pressed, without ticking the skill", async () => {
    await render();
    const row = container.querySelector('[data-testid="agent-skill-row-paperclipai/paperclip/link-checker"]')!;
    expect(row.textContent).toContain("Crawl a website and report broken internal and external links.");
    expect(row.textContent).not.toContain("Uses the server link-checker service.");

    const more = row.querySelector<HTMLButtonElement>('[data-testid="skill-summary-toggle"]')!;
    expect(more.textContent).toBe("More");
    more.click();
    await flush();

    expect(row.textContent).toContain("Uses the server link-checker service.");
    expect(row.querySelector('[data-testid="skill-summary-toggle"]')?.textContent).toBe("Less");
    expect(checkboxFor("link-checker")?.checked).toBe(true);
    expect(mockAgentsApi.syncSkills).not.toHaveBeenCalled();
  });

  it("keeps the View link and the will-be-materialized note on each skill", async () => {
    await render();
    const row = container.querySelector('[data-testid="agent-skill-row-paperclipai/paperclip/task-planning"]')!;
    expect(row.querySelector('a[href="/skills/id-task-planning"]')?.textContent).toBe("View");
    expect(row.textContent).toContain("Will be materialized");
  });

  it("saves the new list when a skill is ticked", async () => {
    await render();
    checkboxFor("wireframe")!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await flush();
    expect(mockAgentsApi.syncSkills).toHaveBeenCalledWith(
      AGENT,
      [TASK_PLANNING.key, LINK_CHECKER.key, WIREFRAME.key],
      COMPANY,
    );
  });

  it("tucks the adapter details into a closed 'How skills are applied' block", async () => {
    await render();
    const howApplied = container.querySelector<HTMLElement>('[data-testid="agent-skills-how-applied"]');
    expect(howApplied?.getAttribute("data-state")).toBe("closed");
    expect(howApplied?.textContent).toContain("Applied when the agent runs");
    expect(howApplied?.textContent).toContain("Selected skills");
  });

  it("shows skills installed outside Paperclip in their own closed, read-only block", async () => {
    const withOutside = snapshot([TASK_PLANNING.key]);
    withOutside.entries.push({
      key: "outside-helper",
      runtimeName: "outside-helper",
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      detail: null as unknown as string,
    });
    mockAgentsApi.skills.mockResolvedValue(withOutside);
    await render();
    const outside = container.querySelector<HTMLElement>('[data-testid="agent-skills-unmanaged"]');
    expect(outside?.getAttribute("data-state")).toBe("closed");
    expect(outside?.textContent).toContain("Added outside Paperclip (1)");
    expect(rowNames(outside)).toEqual(["outside-helper"]);
    expect(outside?.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("names a requested skill that is missing from the library by its key", async () => {
    mockAgentsApi.skills.mockResolvedValue(snapshot(["someone/else/ghost-skill"]));
    await render();
    expect(container.querySelector('[data-testid="agent-skills-on"]')?.textContent).toBe(
      "On for this agent: someone/else/ghost-skill",
    );
    expect(container.textContent).toContain("Requested skills missing from the company library");
  });

  it("has no search box for a short list", async () => {
    await render();
    expect(container.querySelector('[data-testid="agent-skills-search"]')).toBeNull();
  });

  it("adds a search box above 12 skills that filters by name or description", async () => {
    const extra = Array.from({ length: 10 }, (_, index) =>
      companySkill(`extra-skill-${index}`, [], `Filler skill number ${index}.`),
    );
    mockCompanySkillsApi.list.mockResolvedValue([...BASE_SKILLS, ...extra]);
    await render();

    const search = container.querySelector<HTMLInputElement>('[data-testid="agent-skills-search"]');
    expect(search).not.toBeNull();

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(search, "broken");
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const results = container.querySelector('[data-testid="agent-skills-search-results"]');
    expect(rowNames(results)).toEqual(["link-checker"]);
    expect(results?.textContent).toContain("Web and browser");
    expect(container.querySelector('[data-testid^="agent-skill-group-"]')).toBeNull();

    setValue.call(search, "nothing like this");
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(container.querySelector('[data-testid="agent-skills-search-results"]')?.textContent).toContain(
      'No skills match "nothing like this".',
    );
  });
});
