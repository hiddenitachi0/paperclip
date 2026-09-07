import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  DEFAULT_MAX_TURNS_PER_RUN,
  DEFAULT_SESSION_RESET_AFTER_HOURS,
  DEFAULT_SESSION_RESET_AFTER_RUNS,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  adapterHonoursMaxTurnsPerRun,
  decideSessionReset,
  heartbeatService,
  parseSessionCompactionPolicy,
  resolveMaxTurnsPerRun,
} from "../services/heartbeat.ts";
import { instanceSettingsService, readMaxTurnsPerRunOverride } from "../services/instance-settings.ts";
import {
  buildTurnCapContinuationNote,
  buildTurnCapRepeatedOperatorNotice,
} from "../services/operator-notices.ts";

// DUR-3943 items 4 and 5: the two context-cost policies. Every turn of a
// run re-sends the whole standing context, so (4) the turn ceiling per run
// and (5) how long a saved session is resumed before it is dropped are the
// two knobs that bound what one task can cost. Both are instance settings
// with per-agent overrides; the tests below pin the precedence, the reset
// decisions, and what happens when a run hits the cap.

const general = (patch: Partial<{ maxTurnsPerRun: number; sessionResetAfterRuns: number; sessionResetAfterHours: number }> = {}) => ({
  maxTurnsPerRun: DEFAULT_MAX_TURNS_PER_RUN,
  sessionResetAfterRuns: DEFAULT_SESSION_RESET_AFTER_RUNS,
  sessionResetAfterHours: DEFAULT_SESSION_RESET_AFTER_HOURS,
  ...patch,
});

describe("max turns per run (DUR-3943 item 4): precedence", () => {
  it("uses the instance setting when the agent has no limit of its own", () => {
    expect(resolveMaxTurnsPerRun({}, general())).toEqual({ maxTurnsPerRun: 60, source: "instance" });
    expect(resolveMaxTurnsPerRun(null, general({ maxTurnsPerRun: 45 }))).toEqual({ maxTurnsPerRun: 45, source: "instance" });
    expect(resolveMaxTurnsPerRun({ maxTurnsPerRun: 0 }, general())).toEqual({ maxTurnsPerRun: 60, source: "instance" });
    expect(resolveMaxTurnsPerRun({ maxTurnsPerRun: "" }, general())).toEqual({ maxTurnsPerRun: 60, source: "instance" });
    expect(resolveMaxTurnsPerRun({ maxTurnsPerRun: "lots" }, general())).toEqual({ maxTurnsPerRun: 60, source: "instance" });
  });

  it("lets the agent's own number win, whatever the instance setting says", () => {
    expect(resolveMaxTurnsPerRun({ maxTurnsPerRun: 120 }, general())).toEqual({ maxTurnsPerRun: 120, source: "agent" });
    expect(resolveMaxTurnsPerRun({ maxTurnsPerRun: "25" }, general())).toEqual({ maxTurnsPerRun: 25, source: "agent" });
    expect(resolveMaxTurnsPerRun({ maxTurnsPerRun: 7.9 }, general({ maxTurnsPerRun: 200 }))).toEqual({ maxTurnsPerRun: 7, source: "agent" });
  });

  it("falls back to the shipped default when the stored instance value is unusable", () => {
    expect(resolveMaxTurnsPerRun({}, { maxTurnsPerRun: Number.NaN })).toEqual({
      maxTurnsPerRun: DEFAULT_MAX_TURNS_PER_RUN,
      source: "instance",
    });
  });

  it("only applies to adapters that pass the cap to their CLI", () => {
    expect(adapterHonoursMaxTurnsPerRun("claude_local")).toBe(true);
    expect(adapterHonoursMaxTurnsPerRun("hermes_local")).toBe(true);
    expect(adapterHonoursMaxTurnsPerRun("codex_local")).toBe(false);
    expect(adapterHonoursMaxTurnsPerRun("http")).toBe(false);
  });

  it("reads an override the same way the settings page lists it", () => {
    expect(readMaxTurnsPerRunOverride({ maxTurnsPerRun: 120 })).toBe(120);
    expect(readMaxTurnsPerRunOverride({ maxTurnsPerRun: 0 })).toBeNull();
    expect(readMaxTurnsPerRunOverride({})).toBeNull();
  });
});

describe("max turns per run (DUR-3943 item 4): plain-language notes", () => {
  it("says the work continues when a fresh run was queued", () => {
    expect(buildTurnCapContinuationNote({ turns: 60, outcome: "continued" })).toBe(
      "Stopped after 60 turns, the limit for one run; the work continues in a fresh run.",
    );
    expect(buildTurnCapContinuationNote({ turns: null, outcome: "continued" })).toBe(
      "Stopped at the turn limit for one run; the work continues in a fresh run.",
    );
  });

  it("says the task needs a look after repeated cap hits", () => {
    expect(buildTurnCapContinuationNote({ turns: 60, outcome: "exhausted", timesInARow: 3 })).toBe(
      "Stopped after 60 turns, the limit for one run. This task has hit the limit 3 times in a row, so no further fresh run was queued; it needs a look.",
    );
  });

  it("says why the work was not continued, in plain words rather than the internal gate code", () => {
    const note = (reasonCode: string | null) => buildTurnCapContinuationNote({ turns: 60, outcome: "not_continued", reasonCode });
    expect(note("issue_not_in_progress")).toBe(
      "Stopped after 60 turns, the limit for one run; the work was not continued because the task is no longer in progress.",
    );
    expect(note("issue_terminal_status")).toBe(
      "Stopped after 60 turns, the limit for one run; the work was not continued because the task was finished in the meantime.",
    );
    expect(note("issue_cancelled")).toContain("because the task was cancelled in the meantime.");
    expect(note("issue_reassigned")).toContain("because the task was handed to someone else.");
    expect(note("issue_execution_lock_changed")).toContain("because another run has taken over the task.");
    expect(note("agent_not_invokable")).toContain("because the agent is not available to run right now");
    expect(note("budget_blocked")).toContain("because the agent's budget does not allow another run right now.");
    expect(note("policy_disabled")).toContain("because automatic continuation is switched off for this agent.");
    // Unknown codes and missing codes never leak into the note.
    expect(note("some_new_gate_code")).toBe(
      "Stopped after 60 turns, the limit for one run; the work was not continued because the task could not be picked up again automatically.",
    );
    expect(note(null)).toContain("because the task could not be picked up again automatically.");
    expect(note("issue_not_in_progress")).not.toMatch(/suppressed|in_progress|errorCode/);
  });

  it("writes the operator notice in plain words with the task named", () => {
    const notice = buildTurnCapRepeatedOperatorNotice({
      agentName: "Backend Engineer",
      issueIdentifier: "DUR-3943",
      issueTitle: "Cut agent context cost",
      turns: 60,
      timesInARow: 3,
    });
    expect(notice).toBe(
      'Backend Engineer hit the limit of 60 turns per run on "Cut agent context cost" (DUR-3943) 3 times in a row. ' +
        "Paperclip stopped queuing fresh runs for it, because a task that keeps running out of turns is usually stuck, too big, or unclear. " +
        "Have a look at the task, then split it, clarify it, or wake the agent again when it is ready to continue.",
    );
    expect(
      buildTurnCapRepeatedOperatorNotice({ agentName: null, issueIdentifier: null, issueTitle: null, turns: null, timesInARow: 1 }),
    ).toContain("An agent hit the limit of the turn limit per run on its task again.");
  });
});

describe("session reset policy (DUR-3943 item 5): precedence", () => {
  const agent = (adapterType: string, runtimeConfig: Record<string, unknown> = {}) => ({ adapterType, runtimeConfig });

  it("ships with session resets off: the defaults are 0 and every adapter keeps its built-in behaviour", () => {
    expect(DEFAULT_SESSION_RESET_AFTER_RUNS).toBe(0);
    expect(DEFAULT_SESSION_RESET_AFTER_HOURS).toBe(0);
    // Adapters with native context management: never reset by Paperclip.
    for (const adapterType of ["claude_local", "codex_local", "acpx_local", "hermes_local"]) {
      expect(parseSessionCompactionPolicy(agent(adapterType), general()), adapterType).toEqual({
        enabled: true,
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      });
    }
    // Adapters whose upstream default already rotates keep 200 runs / 72 hours.
    for (const adapterType of ["cursor", "cursor_cloud", "gemini_local", "opencode_local", "pi_local"]) {
      expect(parseSessionCompactionPolicy(agent(adapterType), general()), adapterType).toEqual({
        enabled: true,
        maxSessionRuns: 200,
        maxRawInputTokens: 2_000_000,
        maxSessionAgeHours: 72,
      });
    }
  });

  it("applies the instance-wide run and age limits to a Claude agent once the operator opts in", () => {
    expect(parseSessionCompactionPolicy(agent("claude_local"), general({ sessionResetAfterRuns: 8, sessionResetAfterHours: 24 }))).toEqual({
      enabled: true,
      maxSessionRuns: 8,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 24,
    });
    // Each criterion is opted into on its own; 0 keeps the adapter's default for that one.
    expect(parseSessionCompactionPolicy(agent("claude_local"), general({ sessionResetAfterRuns: 3, sessionResetAfterHours: 0 }))).toEqual({
      enabled: true,
      maxSessionRuns: 3,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(agent("codex_local"), general({ sessionResetAfterRuns: 0, sessionResetAfterHours: 12 }))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 12,
    });
  });

  it("keeps the adapter's raw-token threshold and replaces only the run/age limits for other sessioned adapters", () => {
    expect(parseSessionCompactionPolicy(agent("cursor"), general({ sessionResetAfterRuns: 8, sessionResetAfterHours: 24 }))).toEqual({
      enabled: true,
      maxSessionRuns: 8,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 24,
    });
    // 0 on one criterion keeps that adapter's own limit, it does not switch it off.
    expect(parseSessionCompactionPolicy(agent("gemini_local"), general({ sessionResetAfterRuns: 8, sessionResetAfterHours: 0 }))).toEqual({
      enabled: true,
      maxSessionRuns: 8,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets the agent's own override win over the instance setting, field by field", () => {
    const optedIn = general({ sessionResetAfterRuns: 8, sessionResetAfterHours: 24 });
    expect(
      parseSessionCompactionPolicy(
        agent("claude_local", { heartbeat: { sessionCompaction: { maxSessionRuns: 20 } } }),
        optedIn,
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 20,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 24,
    });
    expect(
      parseSessionCompactionPolicy(
        agent("claude_local", { heartbeat: { sessionCompaction: { enabled: false, maxSessionAgeHours: 0 } } }),
        optedIn,
      ),
    ).toEqual({
      enabled: false,
      maxSessionRuns: 8,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("behaves exactly as before when no instance settings are passed", () => {
    expect(parseSessionCompactionPolicy(agent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });
});

describe("session reset policy (DUR-3943 item 5): reset decisions", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
  const policy = { enabled: true, maxSessionRuns: 8, maxRawInputTokens: 0, maxSessionAgeHours: 24 };

  it("keeps resuming while the session is young and has been used fewer times than the limit", () => {
    expect(
      decideSessionReset({ policy, sessionRunCount: 7, sessionStartedAt: hoursAgo(23), latestRawInputTokens: null, now }),
    ).toEqual({ reset: false, reason: null });
  });

  it("resets after the configured number of runs on the same task", () => {
    expect(
      decideSessionReset({ policy, sessionRunCount: 8, sessionStartedAt: hoursAgo(1), latestRawInputTokens: null, now }),
    ).toEqual({
      reset: true,
      reason: "the saved session had already been used for 8 runs on this task (the limit is 8)",
    });
  });

  it("resets once the session is older than the configured hours, measured from its first use", () => {
    expect(
      decideSessionReset({ policy, sessionRunCount: 2, sessionStartedAt: hoursAgo(25), latestRawInputTokens: null, now }),
    ).toEqual({
      reset: true,
      reason: "the saved session was 25 hours old (the limit is 24)",
    });
    expect(
      decideSessionReset({ policy, sessionRunCount: 2, sessionStartedAt: hoursAgo(24), latestRawInputTokens: null, now }),
    ).toMatchObject({ reset: true });
  });

  it("treats 0 as never on that criterion, and a switched-off policy as never", () => {
    expect(
      decideSessionReset({
        policy: { ...policy, maxSessionRuns: 0, maxSessionAgeHours: 0 },
        sessionRunCount: 500,
        sessionStartedAt: hoursAgo(1000),
        latestRawInputTokens: null,
        now,
      }),
    ).toEqual({ reset: false, reason: null });
    expect(
      decideSessionReset({ policy: { ...policy, enabled: false }, sessionRunCount: 500, sessionStartedAt: hoursAgo(1000), latestRawInputTokens: null, now }),
    ).toEqual({ reset: false, reason: null });
  });

  it("still honours an adapter's raw-token threshold when one is set", () => {
    expect(
      decideSessionReset({
        policy: { ...policy, maxRawInputTokens: 1_000 },
        sessionRunCount: 1,
        sessionStartedAt: hoursAgo(1),
        latestRawInputTokens: 1_500,
        now,
      }),
    ).toEqual({ reset: true, reason: "the saved session had grown to 1,500 input tokens (the limit is 1,000)" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres context-cost policy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("context-cost policies against the database", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-context-cost-policies-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(input?: {
    adapterConfig?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    adapterType?: string;
    name?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: input?.name ?? "Backend Engineer",
      role: "engineer",
      status: "active",
      adapterType: input?.adapterType ?? "claude_local",
      adapterConfig: input?.adapterConfig ?? {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: { enabled: true, maxAttempts: 2, delayMs: 1_000 },
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedMaxTurnRun(input: {
    companyId: string;
    agentId: string;
    now: Date;
    scheduledRetryAttempt?: number;
    issueStatus?: string;
  }) {
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Stopped after 60 turns, the limit for one run.",
      errorCode: "max_turns_exhausted",
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: { stopReason: "max_turns_exhausted", num_turns: 60 },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: input.now,
      createdAt: input.now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Cut agent context cost",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      executionRunId: runId,
      executionAgentNameKey: "backendengineer",
      executionLockedAt: input.now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { runId, issueId, identifier: `${issuePrefix}-1` };
  }

  it("ships both policies with the approved defaults and saves changes through the general settings", async () => {
    const settings = instanceSettingsService(db);
    const initial = await settings.getGeneral();
    expect(initial).toMatchObject({ maxTurnsPerRun: 60, sessionResetAfterRuns: 0, sessionResetAfterHours: 0 });

    const updated = await settings.updateGeneral({ maxTurnsPerRun: 80, sessionResetAfterRuns: 8, sessionResetAfterHours: 48 });
    expect(updated.general).toMatchObject({ maxTurnsPerRun: 80, sessionResetAfterRuns: 8, sessionResetAfterHours: 48 });
    // Untouched fields keep their values.
    expect(updated.general.silentRunTimeoutMinutes).toBe(initial.silentRunTimeoutMinutes);
    expect((await settings.getGeneral()).maxTurnsPerRun).toBe(80);
  });

  it("lists the agents with their own turn cap and can put every agent on the instance setting", async () => {
    const settings = instanceSettingsService(db);
    const a = await seedCompanyAndAgent({ name: "Fork Lead", adapterConfig: { maxTurnsPerRun: 120, model: "claude-sonnet-4-6" } });
    const b = await seedCompanyAndAgent({ name: "Backend Engineer", adapterConfig: { maxTurnsPerRun: 1000 } });
    const c = await seedCompanyAndAgent({ name: "Secretary", adapterConfig: { model: "claude-haiku-4-5" } });

    const listed = await settings.listMaxTurnsPerRunAgentOverrides();
    expect(listed.map((row) => [row.agentName, row.maxTurnsPerRun])).toEqual([
      ["Backend Engineer", 1000],
      ["Fork Lead", 120],
    ]);

    const cleared = await settings.clearMaxTurnsPerRunAgentOverrides();
    expect(new Set(cleared.clearedAgentIds)).toEqual(new Set([a.agentId, b.agentId]));
    expect(await settings.listMaxTurnsPerRunAgentOverrides()).toEqual([]);

    // The rest of each agent's config survives; the untouched agent is untouched.
    const rows = await db.select({ id: agents.id, adapterConfig: agents.adapterConfig }).from(agents);
    const byId = new Map(rows.map((row) => [row.id, row.adapterConfig as Record<string, unknown>]));
    expect(byId.get(a.agentId)).toEqual({ model: "claude-sonnet-4-6" });
    expect(byId.get(b.agentId)).toEqual({});
    expect(byId.get(c.agentId)).toEqual({ model: "claude-haiku-4-5" });
  });

  it("queues a fresh run and leaves a plain note when a run hits the turn cap the first time", async () => {
    const now = new Date("2026-09-07T10:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { runId } = await seedMaxTurnRun({ companyId, agentId, now });

    const result = await heartbeat.continueAfterTurnCap(runId, { turnCap: 60, now });
    expect(result).toMatchObject({ outcome: "scheduled", timesInARow: 1 });

    const run = await db.select({ error: heartbeatRuns.error }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(run?.error).toBe("Stopped after 60 turns, the limit for one run; the work continues in a fresh run.");

    const continuation = await db
      .select({ status: heartbeatRuns.status, scheduledRetryReason: heartbeatRuns.scheduledRetryReason, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
    expect(continuation).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON });
    const wake = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, continuation?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wake?.reason).toBe(MAX_TURN_CONTINUATION_WAKE_REASON);

    // No operator notice yet: one cap hit is routine.
    const notices = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "heartbeat.turn_limit_repeated")));
    expect(notices).toEqual([]);
  });

  it("tells the operator once the same task has hit the cap three times in a row, and stops queuing runs", async () => {
    const now = new Date("2026-09-07T10:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndAgent();
    // This run is already the second continuation (attempt 2 of the allowed 2).
    const { runId, identifier } = await seedMaxTurnRun({ companyId, agentId, now, scheduledRetryAttempt: 2 });

    const result = await heartbeat.continueAfterTurnCap(runId, { turnCap: 60, now });
    expect(result).toMatchObject({ outcome: "retry_exhausted", timesInARow: 3 });

    const run = await db.select({ error: heartbeatRuns.error }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(run?.error).toBe(
      "Stopped after 60 turns, the limit for one run. This task has hit the limit 3 times in a row, so no further fresh run was queued; it needs a look.",
    );
    const continuations = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(continuations).toEqual([]);

    const notices = await db
      .select({ action: activityLog.action, details: activityLog.details, agentId: activityLog.agentId, runId: activityLog.runId })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "heartbeat.turn_limit_repeated")));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.agentId).toBe(agentId);
    expect(notices[0]?.runId).toBe(runId);
    expect(notices[0]?.details).toMatchObject({ agentId, timesInARow: 3, turns: 60, issueIdentifier: identifier });
    expect(String(notices[0]?.details?.message)).toBe(
      `Backend Engineer hit the limit of 60 turns per run on "Cut agent context cost" (${identifier}) 3 times in a row. ` +
        "Paperclip stopped queuing fresh runs for it, because a task that keeps running out of turns is usually stuck, too big, or unclear. " +
        "Have a look at the task, then split it, clarify it, or wake the agent again when it is ready to continue.",
    );
  });

  it("does not continue a task that is no longer in progress, and says so in the note", async () => {
    const now = new Date("2026-09-07T10:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { runId } = await seedMaxTurnRun({ companyId, agentId, now, issueStatus: "done" });

    const result = await heartbeat.continueAfterTurnCap(runId, { turnCap: 60, now });
    expect(result).toMatchObject({ outcome: "not_scheduled", reasonCode: "issue_terminal_status" });
    const run = await db.select({ error: heartbeatRuns.error }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(run?.error).toBe(
      "Stopped after 60 turns, the limit for one run; the work was not continued because the task was finished in the meantime.",
    );
  });

  it("leaves a Claude agent's saved session alone by default, however many runs it has had", async () => {
    const sessionId = "99999999-2222-4333-8444-555555555555";
    const now = new Date("2026-09-07T12:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndAgent({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    for (let index = 0; index < 12; index += 1) {
      const createdAt = new Date(now.getTime() - (72 - index) * 60 * 60 * 1000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        sessionIdAfter: sessionId,
        finishedAt: createdAt,
        usageJson: { rawInputTokens: 10 },
        createdAt,
        updatedAt: createdAt,
      });
    }
    expect(await heartbeat.evaluateSessionReset({ agentId, sessionId, now })).toMatchObject({ rotate: false, reason: null });
  });

  it("resets a Claude agent's saved session after the instance-wide number of runs on the same task once the operator opts in", async () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const now = new Date("2026-09-07T12:00:00.000Z");
    await instanceSettingsService(db).updateGeneral({ sessionResetAfterRuns: 8, sessionResetAfterHours: 24 });
    const { companyId, agentId } = await seedCompanyAndAgent({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    const seedRuns = async (count: number, startedAt: Date) => {
      for (let index = 0; index < count; index += 1) {
        const createdAt = new Date(startedAt.getTime() + index * 60_000);
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "succeeded",
          sessionIdAfter: sessionId,
          finishedAt: createdAt,
          usageJson: { rawInputTokens: 10 },
          resultJson: { summary: `run ${index + 1} done` },
          createdAt,
          updatedAt: createdAt,
        });
      }
    };

    await seedRuns(7, new Date(now.getTime() - 60 * 60 * 1000));
    expect(await heartbeat.evaluateSessionReset({ agentId, sessionId, now })).toMatchObject({ rotate: false, reason: null });

    await seedRuns(1, new Date(now.getTime() - 10 * 60_000));
    const decision = await heartbeat.evaluateSessionReset({ agentId, sessionId, now });
    expect(decision).toMatchObject({
      rotate: true,
      reason: "the saved session had already been used for 8 runs on this task (the limit is 8)",
    });
    expect(decision.handoffMarkdown).toContain("Rotation reason: the saved session had already been used for 8 runs");
    expect(decision.handoffMarkdown).toContain("Last run summary: run 1 done");
  });

  it("resets a saved session that is older than the instance-wide limit even if it was used recently", async () => {
    const sessionId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    const now = new Date("2026-09-07T12:00:00.000Z");
    await instanceSettingsService(db).updateGeneral({ sessionResetAfterRuns: 8, sessionResetAfterHours: 24 });
    const { companyId, agentId } = await seedCompanyAndAgent({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    for (const hoursAgo of [30, 2]) {
      const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        sessionIdAfter: sessionId,
        finishedAt: createdAt,
        usageJson: { rawInputTokens: 10 },
        createdAt,
        updatedAt: createdAt,
      });
    }
    expect(await heartbeat.evaluateSessionReset({ agentId, sessionId, now })).toMatchObject({
      rotate: true,
      reason: "the saved session was 30 hours old (the limit is 24)",
    });

    // The operator can switch the age criterion off; the run criterion is not hit yet.
    await instanceSettingsService(db).updateGeneral({ sessionResetAfterHours: 0 });
    expect(await heartbeat.evaluateSessionReset({ agentId, sessionId, now })).toMatchObject({ rotate: false });
  });

  it("lets an agent's own session policy win over the instance setting", async () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const now = new Date("2026-09-07T12:00:00.000Z");
    await instanceSettingsService(db).updateGeneral({ sessionResetAfterRuns: 8, sessionResetAfterHours: 24 });
    const { companyId, agentId } = await seedCompanyAndAgent({
      runtimeConfig: { heartbeat: { wakeOnDemand: true, sessionCompaction: { maxSessionRuns: 2, maxSessionAgeHours: 0 } } },
    });
    for (let index = 0; index < 2; index += 1) {
      const createdAt = new Date(now.getTime() - (48 - index) * 60 * 60 * 1000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        sessionIdAfter: sessionId,
        finishedAt: createdAt,
        usageJson: { rawInputTokens: 10 },
        createdAt,
        updatedAt: createdAt,
      });
    }
    // Two runs: the agent's own limit of 2 trips before the instance-wide 8 would,
    // and its "never" on age wins over the instance-wide 24 hours.
    expect(await heartbeat.evaluateSessionReset({ agentId, sessionId, now })).toMatchObject({
      rotate: true,
      reason: "the saved session had already been used for 2 runs on this task (the limit is 2)",
    });
  });
});
