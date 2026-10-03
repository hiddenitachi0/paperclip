import { describe, expect, it, vi } from "vitest";
import {
  LANE_A_BUILTIN_TOOL_NAMES,
  buildLaneABuiltinToolDefinitions,
  createLaneABuiltinToolExecutor,
  formatWeatherReport,
  isLaneABuiltinTool,
  resolveColleague,
  type LaneAToolContext,
  type LaneAToolDeps,
} from "../services/lane-a-tools.ts";

// Quick agents (Lane A, round 2): the built-in tools run against injected
// dependencies, so the allow-list and each tool can be tested without a
// database, a model, or the network.

const companyId = "11111111-1111-4111-8111-111111111112";
const quickAgentId = "11111111-1111-4111-8111-111111111111";
const bobId = "22222222-2222-4222-8222-222222222222";
const finnId = "33333333-3333-4333-8333-333333333333";

const colleagues = [
  { id: quickAgentId, name: "Ada", role: "secretary", status: "active", urlKey: "ada" },
  { id: bobId, name: "Bob", role: "engineer", status: "active", urlKey: "bob" },
  { id: finnId, name: "Finn", role: "finance", status: "paused", urlKey: "finn" },
];

function makeDeps(overrides: Partial<LaneAToolDeps> = {}): LaneAToolDeps {
  return {
    listAgents: vi.fn(async () => colleagues),
    canAssignTask: vi.fn(async () => ({ allowed: true, explanation: "ok" })),
    createIssueForAgent: vi.fn(async () => ({ id: "issue-1", identifier: "DUR-12", status: "todo" })),
    lookupIssue: vi.fn(async () => null),
    fetch: vi.fn(async () => {
      throw new Error("network disabled in tests");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

function ctx(overrides: Partial<LaneAToolContext> = {}): LaneAToolContext {
  return {
    companyId,
    agent: { id: quickAgentId, name: "Ada" },
    requester: { userId: "user-1", agentId: null },
    actor: { type: "board", userId: "user-1", companyIds: [companyId], source: "session" },
    conversationId: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

describe("allow-list", () => {
  it("publishes exactly the three built-in tools", () => {
    const names = buildLaneABuiltinToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual([...LANE_A_BUILTIN_TOOL_NAMES]);
    expect(isLaneABuiltinTool("get_weather")).toBe(true);
    expect(isLaneABuiltinTool("delete_everything")).toBe(false);
  });

  it("refuses a tool that is not on the allow-list without touching any dependency", async () => {
    const deps = makeDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("send_email", { to: "x" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not something I am allowed to do");
    expect(deps.listAgents).not.toHaveBeenCalled();
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe("route_to_agent", () => {
  it("creates a task for the named colleague and reports the reference", async () => {
    const deps = makeDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(
      "route_to_agent",
      { agent: "bob", request: "Please fix the login page\nIt shows a blank screen." },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Handed to Bob as task DUR-12.");
    expect(result.content).toContain("DUR-12");
    // The permission check ran for the resolved colleague before the task was created.
    expect(deps.canAssignTask).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, assigneeAgentId: bobId, ctx: expect.objectContaining({ actor: expect.objectContaining({ userId: "user-1" }) }) }),
    );
    expect(deps.createIssueForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        assigneeAgentId: bobId,
        title: "Please fix the login page",
        description: expect.stringContaining("Handed over by Ada"),
      }),
    );
  });

  it("does not hand work to a paused colleague or to itself", async () => {
    const deps = makeDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const paused = await execute("route_to_agent", { agent: "Finn", request: "do the books" }, ctx());
    expect(paused.ok).toBe(false);
    expect(paused.content).toContain('No available colleague named "Finn"');
    expect(paused.content).toContain("Bob (engineer)");
    const self = await execute("route_to_agent", { agent: "Ada", request: "talk to yourself" }, ctx());
    expect(self.ok).toBe(false);
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("refuses when the requester is another agent rather than a person", async () => {
    const deps = makeDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(
      "route_to_agent",
      { agent: "Bob", request: "do it" },
      ctx({ requester: { userId: null, agentId: finnId } }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Only a person can ask me");
    expect(deps.canAssignTask).not.toHaveBeenCalled();
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("refuses plainly, without creating a task, when the person may not assign work to that colleague", async () => {
    const deps = makeDeps({
      canAssignTask: vi.fn(async () => ({ allowed: false, explanation: "user principal user-1 is not an active member" })),
    });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("route_to_agent", { agent: "Bob", request: "fix the login page" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not allowed to hand work to Bob");
    expect(result.content).toContain("no task was created");
    expect(result.summary).toBe("Refused to hand work to Bob: the person asking may not assign tasks to them.");
    // The policy's internal explanation is not surfaced to the model or the person.
    expect(result.content).not.toContain("principal");
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("asks for clarification when several colleagues match", () => {
    const pool = [
      ...colleagues,
      { id: "55555555-5555-4555-8555-555555555555", name: "Bob Jr", role: "designer", status: "active", urlKey: "bob-jr" },
    ];
    const exact = resolveColleague(pool, "Bob", quickAgentId);
    expect(exact.match?.id).toBe(bobId);
    const fuzzy = resolveColleague(pool, "bo", quickAgentId);
    expect(fuzzy.match).toBeNull();
    expect(fuzzy.candidates.map((c) => c.name)).toEqual(["Bob", "Bob Jr"]);
  });
});

describe("start_job", () => {
  function depsWithJobs(overrides: Partial<LaneAToolDeps> = {}) {
    return makeDeps({
      startJob: {
        listRunnable: vi.fn(async () => [
          { id: "job-revise", title: "Revise contract" },
          { id: "job-draft", title: "Draft new contract" },
        ]),
        run: vi.fn(async () => ({ issueId: "issue-9", identifier: "DUR-99", title: "Revise contract" })),
      },
      ...overrides,
    });
  }

  it("starts the named job on the named colleague and reports the reference", async () => {
    const deps = depsWithJobs();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "bob", job: "Revise contract", note: "the Acme NDA" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Started job \"Revise contract\" on Bob as DUR-99.");
    expect(result.task).toEqual({ issueId: "issue-9", identifier: "DUR-99", title: "Revise contract" });
    expect(deps.canAssignTask).toHaveBeenCalledWith(expect.objectContaining({ companyId, assigneeAgentId: bobId }));
    expect(deps.startJob!.listRunnable).toHaveBeenCalledWith(companyId, bobId);
    expect(deps.startJob!.run).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, jobId: "job-revise", runAgentId: bobId, note: "the Acme NDA" }),
    );
  });

  it("matches a job title case-insensitively and without a note", async () => {
    const deps = depsWithJobs();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "Bob", job: "revise CONTRACT" }, ctx());
    expect(result.ok).toBe(true);
    expect(deps.startJob!.run).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-revise", note: null }));
  });

  it("refuses when the requester is another agent rather than a person", async () => {
    const deps = depsWithJobs();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute(
      "start_job",
      { colleague: "Bob", job: "Revise contract" },
      ctx({ requester: { userId: null, agentId: finnId } }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Only a person can ask me");
    expect(deps.startJob!.listRunnable).not.toHaveBeenCalled();
  });

  it("refuses when the person may not assign work to that colleague, without listing jobs", async () => {
    const deps = depsWithJobs({
      canAssignTask: vi.fn(async () => ({ allowed: false, explanation: "not a member" })),
    });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "Bob", job: "Revise contract" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not allowed to hand work to Bob");
    expect(deps.startJob!.listRunnable).not.toHaveBeenCalled();
    expect(deps.startJob!.run).not.toHaveBeenCalled();
  });

  it("refuses when the colleague has no runnable jobs", async () => {
    const deps = depsWithJobs({ startJob: { listRunnable: vi.fn(async () => []), run: vi.fn() } });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "Bob", job: "Revise contract" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("has no one-press jobs set up");
    expect(deps.startJob!.run).not.toHaveBeenCalled();
  });

  it("refuses and lists available titles when the job name does not match", async () => {
    const deps = depsWithJobs();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "Bob", job: "Review the invoice" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("is not one of Bob's one-press jobs");
    expect(result.content).toContain("Revise contract");
    expect(result.content).toContain("Draft new contract");
    expect(deps.startJob!.run).not.toHaveBeenCalled();
  });

  it("asks for clarification when several job titles match", async () => {
    const deps = depsWithJobs({
      startJob: {
        listRunnable: vi.fn(async () => [
          { id: "job-revise", title: "Revise contract" },
          { id: "job-revise-nda", title: "Revise contract (NDA)" },
        ]),
        run: vi.fn(),
      },
    });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "Bob", job: "contract" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Several of Bob's jobs match");
    expect(deps.startJob!.run).not.toHaveBeenCalled();
  });

  it("falls back to route_to_agent's refusal when start_job is not wired", async () => {
    const deps = makeDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_job", { colleague: "Bob", job: "Revise contract" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Use route_to_agent instead");
  });
});

describe("get_weather", () => {
  function jsonResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
  }

  it("geocodes the place, fetches the forecast and returns a plain report", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ name: "Oslo", country: "Norway", latitude: 59.9, longitude: 10.7 }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          current: { temperature_2m: 12.5, wind_speed_10m: 9, precipitation: 0, weather_code: 2 },
          daily: {
            time: ["2026-09-07", "2026-09-08"],
            temperature_2m_max: [15, 14],
            temperature_2m_min: [8, 7],
            precipitation_sum: [0, 3.2],
            weather_code: [1, 61],
          },
        }),
      );
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("get_weather", { location: "Oslo" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Now in Oslo, Norway: partly cloudy, 12.5°C, wind 9 km/h");
    expect(result.content).toContain("2026-09-08: light rain, 7°C to 14°C, 3.2 mm precipitation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("geocoding-api.open-meteo.com");
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("fails plainly (and tells the model not to guess) when the service is down", async () => {
    const deps = makeDeps();
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("get_weather", { location: "Oslo" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("do not guess the weather");
  });

  it("reports an unknown place", async () => {
    const deps = makeDeps({ fetch: vi.fn().mockResolvedValue(jsonResponse({ results: [] })) as unknown as typeof fetch });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("get_weather", { location: "Nowhereville" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Could not find a place called "Nowhereville"');
  });

  it("formats an empty forecast without throwing", () => {
    expect(formatWeatherReport({ name: "X" }, {})).toBe("No weather data available for X.");
  });
});

describe("lookup_issue", () => {
  const issue = {
    id: "issue-1",
    companyId,
    identifier: "DUR-12",
    title: "Fix login",
    status: "in_progress",
    priority: "high",
    description: "The login page is blank.",
    assigneeAgentId: bobId,
    updatedAt: new Date("2026-09-07T10:00:00Z"),
  };

  it("summarises a task in this company, naming the assignee", async () => {
    const deps = makeDeps({ lookupIssue: vi.fn(async () => issue) });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("lookup_issue", { reference: "DUR-12" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("DUR-12 — Fix login");
    expect(result.content).toContain("Assigned to: Bob");
    expect(result.content).toContain("The login page is blank.");
  });

  it("treats a task from another company exactly like a missing one", async () => {
    const deps = makeDeps({ lookupIssue: vi.fn(async () => ({ ...issue, companyId: "99999999-9999-4999-8999-999999999999" })) });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("lookup_issue", { reference: "DUR-12" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toBe('No task "DUR-12" in this company.');
  });
});

// DUR-4000: the colleague list advertises "Sales agent 1 (Maja)", so a
// hand-over may name the job, the person, or exactly that display string.
describe("resolveColleague with personas", () => {
  const self = "00000000-0000-4000-8000-000000000000";
  const pool = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Sales agent 1",
      displayName: "Sales agent 1 (Maja)",
      personaDisplayName: "Maja",
      role: "sales",
      status: "idle",
      urlKey: "sales-agent-1",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Accountant",
      displayName: "Accountant",
      personaDisplayName: null,
      role: "finance",
      status: "idle",
      urlKey: "accountant",
    },
  ];

  it("matches the full display name, case-insensitively, and the person's name alone", () => {
    expect(resolveColleague(pool, "Sales agent 1 (Maja)", self).match?.id).toBe(pool[0]!.id);
    expect(resolveColleague(pool, "sales agent 1 (maja)", self).match?.id).toBe(pool[0]!.id);
    expect(resolveColleague(pool, "Maja", self).match?.id).toBe(pool[0]!.id);
    expect(resolveColleague(pool, "Sales agent 1", self).match?.id).toBe(pool[0]!.id);
  });

  it("strips a trailing ' (…)' from the wanted name, so a stale display string still resolves", () => {
    const detached = [{ ...pool[0]!, displayName: "Sales agent 1", personaDisplayName: null }, pool[1]!];
    expect(resolveColleague(detached, "Sales agent 1 (Maja)", self).match?.id).toBe(pool[0]!.id);
    expect(resolveColleague(pool, "Accountant (someone)", self).match?.id).toBe(pool[1]!.id);
  });

  it("still resolves colleagues that carry no display name at all (older callers)", () => {
    const bare = pool.map(({ displayName: _d, personaDisplayName: _p, ...rest }) => rest);
    expect(resolveColleague(bare, "Accountant", self).match?.id).toBe(pool[1]!.id);
    expect(resolveColleague(bare, "Maja", self).match).toBeNull();
  });
});

describe("start_research_task", () => {
  const brief = "Best price on a Moccamaster KBG Select, black, delivered in Norway.";

  it("makes a task for the quick agent itself, with the brief first and the delivery rules after", async () => {
    const deps = makeDeps({ researchSkillLink: vi.fn(async () => "[research-and-plan](skill://s1?s=research-and-plan)") });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_research_task", { kind: "price_hunt", brief, title: "Best price: Moccamaster" }, ctx());

    expect(result.ok).toBe(true);
    expect(deps.canAssignTask).toHaveBeenCalledWith(expect.objectContaining({ companyId, assigneeAgentId: quickAgentId }));
    const created = vi.mocked(deps.createIssueForAgent).mock.calls[0]![0];
    expect(created).toMatchObject({ companyId, assigneeAgentId: quickAgentId, title: "Best price: Moccamaster", source: "start_research_task" });
    expect(created.description.startsWith(brief)).toBe(true);
    expect(created.description).toContain("Follow the [research-and-plan](skill://s1?s=research-and-plan) skill.");
    expect(created.description).toContain("a table of offers (shop, price including shipping, delivery time, return policy, link, checked at)");
    expect(created.description).toContain("key `result`");
    expect(created.description).toContain("#document-result");
    expect(created.description).toContain("set the task to done");
    expect(result.task).toEqual({ issueId: "issue-1", identifier: "DUR-12", title: "Best price: Moccamaster" });
    expect(result.summary).toBe("Started research task DUR-12: Best price: Moccamaster.");
    expect(result.content).toContain("Do not start the research here");
  });

  it("still makes the task without the skill (the description says what to deliver) and treats an odd kind as research", async () => {
    const deps = makeDeps({ researchSkillLink: vi.fn(async () => { throw new Error("db down"); }) });
    const execute = createLaneABuiltinToolExecutor(deps);
    const result = await execute("start_research_task", { kind: "book_flights", brief: "Compare the three best robot vacuums under 5000 kr" }, ctx());

    expect(result.ok).toBe(true);
    const created = vi.mocked(deps.createIssueForAgent).mock.calls[0]![0];
    expect(created.description).toContain("Follow the research-and-plan skill if you have it.");
    expect(created.description).toContain("a short summary first");
    expect(created.title).toBe("Compare the three best robot vacuums under 5000 kr");
  });

  it("needs a brief", async () => {
    const deps = makeDeps();
    const result = await createLaneABuiltinToolExecutor(deps)("start_research_task", { kind: "trip_plan" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.task).toBeUndefined();
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("only a person can start one", async () => {
    const deps = makeDeps();
    const result = await createLaneABuiltinToolExecutor(deps)(
      "start_research_task",
      { kind: "trip_plan", brief: "Weekend in Bergen" },
      ctx({ requester: { userId: null, agentId: bobId } }),
    );
    expect(result.ok).toBe(false);
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("refuses when the person may not give this agent tasks", async () => {
    const deps = makeDeps({ canAssignTask: vi.fn(async () => ({ allowed: false, explanation: "no" })) });
    const result = await createLaneABuiltinToolExecutor(deps)("start_research_task", { kind: "trip_plan", brief: "Weekend in Bergen" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("no task was created");
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("refuses when the quick agent itself cannot run tasks (paused)", async () => {
    const deps = makeDeps();
    const result = await createLaneABuiltinToolExecutor(deps)(
      "start_research_task",
      { kind: "trip_plan", brief: "Weekend in Bergen" },
      ctx({ agent: { id: finnId, name: "Finn" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("no task");
    expect(deps.createIssueForAgent).not.toHaveBeenCalled();
  });

  it("route_to_agent also reports the task it made, so the chat can follow it", async () => {
    const deps = makeDeps();
    const result = await createLaneABuiltinToolExecutor(deps)("route_to_agent", { agent: "Bob", request: "Fix the login page" }, ctx());
    expect(result.task).toEqual({ issueId: "issue-1", identifier: "DUR-12", title: "Fix the login page" });
  });
});

describe("search_conversations", () => {
  it("is on the allow-list with a schema that takes one required query string", () => {
    expect(LANE_A_BUILTIN_TOOL_NAMES).toContain("search_conversations");
    const def = buildLaneABuiltinToolDefinitions().find((tool) => tool.name === "search_conversations")!;
    expect(def.input_schema).toMatchObject({ required: ["query"], additionalProperties: false });
  });

  it("refuses plainly where it is not wired", async () => {
    const deps = makeDeps();
    const result = await createLaneABuiltinToolExecutor(deps)("search_conversations", { query: "delivery address" }, ctx());
    expect(result).toMatchObject({ ok: false, summary: "Conversation search is not available on this path." });
  });

  it("requires a query", async () => {
    const deps = makeDeps({ searchConversations: vi.fn(async () => []) });
    const result = await createLaneABuiltinToolExecutor(deps)("search_conversations", {}, ctx());
    expect(result).toMatchObject({ ok: false, summary: "Searched conversations without a query." });
    expect(deps.searchConversations).not.toHaveBeenCalled();
  });

  it("passes the query and ctx through, and says plainly when nothing was found", async () => {
    const searchConversations = vi.fn(async () => []);
    const deps = makeDeps({ searchConversations });
    const result = await createLaneABuiltinToolExecutor(deps)("search_conversations", { query: "delivery address" }, ctx());
    expect(searchConversations).toHaveBeenCalledWith("delivery address", expect.objectContaining({ companyId }));
    expect(result).toMatchObject({ ok: true, summary: 'Searched past conversations for "delivery address": nothing found.' });
    expect(result.content).toContain('No earlier conversation');
  });

  it("renders found hits with date and who said it", async () => {
    const hits = [
      { conversationId: "c1", createdAt: new Date("2026-09-20T10:00:00.000Z"), role: "user" as const, content: "The delivery address is 12 Main Street." },
      { conversationId: "c1", createdAt: new Date("2026-09-20T10:00:05.000Z"), role: "assistant" as const, content: "Got it, 12 Main Street." },
    ];
    const deps = makeDeps({ searchConversations: vi.fn(async () => hits) });
    const result = await createLaneABuiltinToolExecutor(deps)("search_conversations", { query: "delivery address" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("- (2026-09-20, them) \"The delivery address is 12 Main Street.\"");
    expect(result.content).toContain("- (2026-09-20, you) \"Got it, 12 Main Street.\"");
    expect(result.summary).toBe('Searched past conversations for "delivery address": found 2.');
  });
});
