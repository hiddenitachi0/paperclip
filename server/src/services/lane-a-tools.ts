import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

/**
 * Quick agents (Lane A, round 2): the small set of things a quick agent is
 * allowed to DO, beyond answering in text. This is a strict allow-list — the
 * model can only call what is defined here (plus its own Tools-library
 * grants, handled in lane-a.ts); any other tool name is refused. Every call
 * is written to activity_log by the caller (lane-a.ts) so the operator can
 * see what the quick agent did.
 *
 * Keep each tool cheap, synchronous and side-effect-light: Lane A has no
 * approval card, no runtime and no retry, so a tool here must be safe to run
 * up to LANE_A_MAX_TOOL_CALLS times per message.
 */

export const LANE_A_BUILTIN_TOOL_NAMES = ["route_to_agent", "get_weather", "lookup_issue"] as const;
export type LaneABuiltinToolName = (typeof LANE_A_BUILTIN_TOOL_NAMES)[number];

const BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(LANE_A_BUILTIN_TOOL_NAMES);

export function isLaneABuiltinTool(name: string): name is LaneABuiltinToolName {
  return BUILTIN_TOOL_NAME_SET.has(name);
}

/** Outbound HTTP calls (weather) must never hang a synchronous chat turn. */
export const LANE_A_TOOL_HTTP_TIMEOUT_MS = 6_000;
/** Upper bound on the text a tool hands back to the model. */
const TOOL_RESULT_MAX_CHARS = 4_000;
const ROUTE_REQUEST_MAX_CHARS = 20_000;
const ROUTE_TITLE_MAX_LENGTH = 80;

// Mirrors chat-router.ts's SECRETARY_UNAVAILABLE_AGENT_STATUSES plus
// pending_approval: none of these can pick up a task right now.
const UNAVAILABLE_AGENT_STATUSES = new Set(["terminated", "paused", "error", "pending_approval"]);

export interface LaneAToolResult {
  ok: boolean;
  /** What the model sees as the tool result. */
  content: string;
  /** Plain-language one-liner for the operator (activity log + chat panel). */
  summary: string;
}

export interface LaneAToolColleague {
  id: string;
  name: string;
  role: string;
  status: string;
  urlKey?: string | null;
}

export interface LaneAToolIssueSummary {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  assigneeAgentId: string | null;
  updatedAt: Date;
}

export interface LaneAToolContext {
  companyId: string;
  /** The quick agent doing the calling. */
  agent: { id: string; name: string };
  /** Who is talking to the quick agent (user or agent). */
  requester: { userId: string | null; agentId: string | null };
  conversationId: string;
}

/**
 * Everything the tools need from the outside world, injectable so the tool
 * loop can be unit-tested with fakes (no DB, no network).
 */
export interface LaneAToolDeps {
  listAgents(companyId: string): Promise<LaneAToolColleague[]>;
  createIssueForAgent(input: {
    companyId: string;
    assigneeAgentId: string;
    title: string;
    description: string;
    ctx: LaneAToolContext;
  }): Promise<{ id: string; identifier: string | null; status: string }>;
  lookupIssue(reference: string): Promise<LaneAToolIssueSummary | null>;
  fetch: typeof fetch;
}

export function buildLaneABuiltinToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: "route_to_agent",
      description:
        "Hand a piece of work to a colleague. Creates a task for that colleague and wakes them up. " +
        "Use it when the person asks for something that must be built, fixed, investigated or otherwise done " +
        "by someone else. Pick the colleague from the list in your instructions; pass their name.",
      input_schema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Colleague's name (or id) from the colleague list." },
          request: {
            type: "string",
            description: "What the colleague should do, in full, written so they can start without asking back.",
          },
          title: { type: "string", description: "Optional short task title (max 80 characters)." },
        },
        required: ["agent", "request"],
      },
    },
    {
      name: "get_weather",
      description:
        "Current weather and a short 3-day outlook for a place (city or town name). " +
        "Public data, no account needed.",
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string", description: "Place name, e.g. 'Oslo' or 'Bergen, Norway'." },
        },
        required: ["location"],
      },
    },
    {
      name: "lookup_issue",
      description:
        "Read-only summary of one task in this company by its reference (e.g. 'DUR-12') or id: " +
        "title, status, priority, who has it, and the start of its description.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Task reference such as 'DUR-12', or the task id." },
        },
        required: ["reference"],
      },
    },
  ];
}

function clip(text: string, max = TOOL_RESULT_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

// Mirrors buildLaneBTitle in server/src/routes/chat-router.ts.
function buildTaskTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  const source = firstLine || text;
  if (source.length <= ROUTE_TITLE_MAX_LENGTH) return source;
  return `${source.slice(0, ROUTE_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export function isAgentAvailableForRouting(agent: { status: string }): boolean {
  return !UNAVAILABLE_AGENT_STATUSES.has(agent.status);
}

/** Exact id match first, then case-insensitive name / url key. Returns all name matches so ambiguity can be reported. */
export function resolveColleague(
  colleagues: LaneAToolColleague[],
  wanted: string,
  excludeAgentId: string,
): { match: LaneAToolColleague | null; candidates: LaneAToolColleague[] } {
  const candidatesPool = colleagues.filter((c) => c.id !== excludeAgentId && isAgentAvailableForRouting(c));
  const byId = candidatesPool.find((c) => c.id === wanted);
  if (byId) return { match: byId, candidates: [byId] };
  const needle = wanted.toLowerCase();
  const byName = candidatesPool.filter(
    (c) => c.name.toLowerCase() === needle || (c.urlKey ?? "").toLowerCase() === needle,
  );
  if (byName.length === 1) return { match: byName[0]!, candidates: byName };
  if (byName.length > 1) return { match: null, candidates: byName };
  const partial = candidatesPool.filter((c) => c.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { match: partial[0]!, candidates: partial };
  return { match: null, candidates: partial };
}

// WMO weather interpretation codes as used by open-meteo.
const WEATHER_CODE_TEXT: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "heavy showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

export function describeWeatherCode(code: unknown): string {
  return typeof code === "number" && WEATHER_CODE_TEXT[code] ? WEATHER_CODE_TEXT[code]! : "unknown conditions";
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(LANE_A_TOOL_HTTP_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`weather service answered ${response.status}`);
  return response.json();
}

/** Formats an open-meteo geocoding + forecast pair into a few plain lines. Exported for tests. */
export function formatWeatherReport(place: { name: string; country?: string; admin1?: string }, forecast: unknown): string {
  const f = (forecast ?? {}) as {
    current?: { temperature_2m?: number; wind_speed_10m?: number; precipitation?: number; weather_code?: number };
    daily?: {
      time?: string[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_sum?: number[];
      weather_code?: number[];
    };
  };
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const lines: string[] = [];
  if (f.current) {
    const c = f.current;
    lines.push(
      `Now in ${where}: ${describeWeatherCode(c.weather_code)}` +
        (typeof c.temperature_2m === "number" ? `, ${c.temperature_2m}°C` : "") +
        (typeof c.wind_speed_10m === "number" ? `, wind ${c.wind_speed_10m} km/h` : "") +
        (typeof c.precipitation === "number" && c.precipitation > 0 ? `, ${c.precipitation} mm precipitation` : ""),
    );
  }
  const days = f.daily?.time ?? [];
  for (let i = 0; i < days.length && i < 3; i++) {
    const max = f.daily?.temperature_2m_max?.[i];
    const min = f.daily?.temperature_2m_min?.[i];
    const rain = f.daily?.precipitation_sum?.[i];
    lines.push(
      `${days[i]}: ${describeWeatherCode(f.daily?.weather_code?.[i])}` +
        (typeof min === "number" && typeof max === "number" ? `, ${min}°C to ${max}°C` : "") +
        (typeof rain === "number" ? `, ${rain} mm precipitation` : ""),
    );
  }
  return lines.length > 0 ? lines.join("\n") : `No weather data available for ${where}.`;
}

export function createLaneABuiltinToolExecutor(deps: LaneAToolDeps) {
  async function routeToAgent(input: Record<string, unknown>, ctx: LaneAToolContext): Promise<LaneAToolResult> {
    const wanted = readString(input, "agent");
    const request = readString(input, "request").slice(0, ROUTE_REQUEST_MAX_CHARS);
    if (!wanted || !request) {
      return { ok: false, content: "Both 'agent' and 'request' are required.", summary: "Could not hand over: missing colleague or request." };
    }
    if (!ctx.requester.userId) {
      // Handing work to a colleague creates a task in their name. Only a
      // person may ask a quick agent to do that — an agent talking to a
      // quick agent gets a plain refusal instead of a silent no-op.
      return {
        ok: false,
        content: "Only a person can ask me to hand work to a colleague; this request came from another agent.",
        summary: "Refused to hand over work: the request did not come from a person.",
      };
    }
    const colleagues = await deps.listAgents(ctx.companyId);
    const { match, candidates } = resolveColleague(colleagues, wanted, ctx.agent.id);
    if (!match) {
      const names = candidates.map((c) => `${c.name} (${c.role})`).join(", ");
      return {
        ok: false,
        content: candidates.length > 1
          ? `Several colleagues match "${wanted}": ${names}. Ask which one is meant, then call again with the exact name.`
          : `No available colleague named "${wanted}". Available: ${colleagues
              .filter((c) => c.id !== ctx.agent.id && isAgentAvailableForRouting(c))
              .map((c) => `${c.name} (${c.role})`)
              .join(", ") || "nobody right now"}.`,
        summary: `Could not find a colleague called "${wanted}".`,
      };
    }
    const explicitTitle = readString(input, "title");
    const title = buildTaskTitle(explicitTitle || request);
    const description =
      `${request}\n\n---\nHanded over by ${ctx.agent.name} (quick agent) on behalf of the person who asked.`;
    const issue = await deps.createIssueForAgent({
      companyId: ctx.companyId,
      assigneeAgentId: match.id,
      title,
      description,
      ctx,
    });
    const ref = issue.identifier ?? issue.id;
    return {
      ok: true,
      content: `Done. ${match.name} now has task ${ref} ("${title}") and has been woken up to start on it.`,
      summary: `Handed to ${match.name} as task ${ref}.`,
    };
  }

  async function getWeather(input: Record<string, unknown>): Promise<LaneAToolResult> {
    const location = readString(input, "location").slice(0, 120);
    if (!location) return { ok: false, content: "'location' is required.", summary: "Weather lookup without a place." };
    try {
      const geo = (await fetchJson(
        deps.fetch,
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
      )) as { results?: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }> };
      const place = geo.results?.[0];
      if (!place) {
        return { ok: false, content: `Could not find a place called "${location}".`, summary: `No such place: "${location}".` };
      }
      const forecast = await fetchJson(
        deps.fetch,
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,wind_speed_10m,precipitation,weather_code` +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&forecast_days=3&timezone=auto`,
      );
      const report = formatWeatherReport(place, forecast);
      return { ok: true, content: clip(report), summary: `Looked up the weather for ${place.name}.` };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: `The weather service did not answer in time (${reason}). Say so plainly; do not guess the weather.`,
        summary: `Weather lookup for "${location}" failed.`,
      };
    }
  }

  async function lookupIssue(input: Record<string, unknown>, ctx: LaneAToolContext): Promise<LaneAToolResult> {
    const reference = readString(input, "reference").slice(0, 120);
    if (!reference) return { ok: false, content: "'reference' is required.", summary: "Task lookup without a reference." };
    const issue = await deps.lookupIssue(reference);
    // A task from another company must look exactly like a missing one.
    if (!issue || issue.companyId !== ctx.companyId) {
      return { ok: false, content: `No task "${reference}" in this company.`, summary: `No task found for "${reference}".` };
    }
    let assignee = "nobody";
    if (issue.assigneeAgentId) {
      const colleagues = await deps.listAgents(ctx.companyId);
      assignee = colleagues.find((c) => c.id === issue.assigneeAgentId)?.name ?? "a colleague";
    }
    const ref = issue.identifier ?? issue.id;
    const lines = [
      `${ref} — ${issue.title}`,
      `Status: ${issue.status}. Priority: ${issue.priority}. Assigned to: ${assignee}. Last updated: ${issue.updatedAt.toISOString()}.`,
    ];
    if (issue.description?.trim()) lines.push("", clip(issue.description.trim(), 600));
    return { ok: true, content: clip(lines.join("\n")), summary: `Looked up task ${ref}.` };
  }

  return async function execute(
    name: string,
    input: Record<string, unknown>,
    ctx: LaneAToolContext,
  ): Promise<LaneAToolResult> {
    switch (name) {
      case "route_to_agent":
        return routeToAgent(input, ctx);
      case "get_weather":
        return getWeather(input);
      case "lookup_issue":
        return lookupIssue(input, ctx);
      default:
        return {
          ok: false,
          content: `"${name}" is not something I am allowed to do.`,
          summary: `Refused a tool that is not on the allow-list ("${name}").`,
        };
    }
  };
}

/** The real dependencies: company agents, issue create/lookup through the same services chat-router uses. */
export function createDbLaneAToolDeps(db: Db): LaneAToolDeps {
  return {
    async listAgents(companyId) {
      const rows = await agentService(db).list(companyId);
      return rows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        urlKey: agent.urlKey,
      }));
    },
    async createIssueForAgent({ companyId, assigneeAgentId, title, description, ctx }) {
      const issues = issueService(db);
      const issue = await issues.create(companyId, {
        id: randomUUID(),
        title,
        description,
        assigneeAgentId,
        status: "todo",
        priority: "medium",
        createdByAgentId: ctx.requester.agentId,
        createdByUserId: ctx.requester.userId,
      });
      const actorType = ctx.requester.userId ? "user" : "agent";
      const actorId = ctx.requester.userId ?? ctx.requester.agentId ?? "system";
      await logActivity(db, {
        companyId,
        actorType,
        actorId,
        agentId: ctx.agent.id,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          title: issue.title,
          identifier: issue.identifier,
          source: "lane_a_route_to_agent",
          quickAgentId: ctx.agent.id,
          conversationId: ctx.conversationId,
        },
      });
      void queueIssueAssignmentWakeup({
        heartbeat: heartbeatService(db),
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "lane_a.route_to_agent",
        requestedByActorType: actorType,
        requestedByActorId: actorId,
      });
      return { id: issue.id, identifier: issue.identifier ?? null, status: issue.status };
    },
    async lookupIssue(reference) {
      const issue = await issueService(db).getById(reference);
      if (!issue) return null;
      return {
        id: issue.id,
        companyId: issue.companyId,
        identifier: issue.identifier ?? null,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        description: issue.description ?? null,
        assigneeAgentId: issue.assigneeAgentId ?? null,
        updatedAt: issue.updatedAt,
      };
    },
    fetch: (input, init) => fetch(input, init),
  };
}
