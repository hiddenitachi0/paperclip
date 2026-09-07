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
