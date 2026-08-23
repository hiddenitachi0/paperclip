import { and, eq, isNull, lte } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

// DUR-128: five and a half hours passed with an agent sitting in "error"
// before anyone noticed -- the fix that actually could have shortened that
// is making the stall itself loud, not just making it reachable once found.
// Thirty minutes gives normal transient failures (a flaky adapter, a slow
// retry) room to self-resolve without paging anyone.
export const DEFAULT_AGENT_ERROR_STALL_THRESHOLD_MS = 30 * 60 * 1000;

export function agentErrorAlertsService(db: Db, options: { thresholdMs?: number } = {}) {
  const thresholdMs = options.thresholdMs ?? DEFAULT_AGENT_ERROR_STALL_THRESHOLD_MS;

  async function tick(now = new Date()) {
    const cutoff = new Date(now.getTime() - thresholdMs);
    // agents.errorAt is null for anything that entered error before this
    // column existed (or via a path that predates it) -- lte() against a
    // null column is unknown, not true, in SQL, so those rows are correctly
    // skipped rather than alerted on with a fabricated stall duration.
    const stalled = await db
      .select()
      .from(agents)
      .where(and(
        eq(agents.status, "error"),
        isNull(agents.errorAlertedAt),
        lte(agents.errorAt, cutoff),
      ));

    for (const agent of stalled) {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "system",
        actorId: "agent-error-alerts",
        action: "agent.error_stalled",
        entityType: "agent",
        entityId: agent.id,
        agentId: agent.id,
        details: {
          agentName: agent.name,
          errorReason: agent.errorReason,
          errorAt: agent.errorAt?.toISOString() ?? null,
          stalledForMs: agent.errorAt ? now.getTime() - agent.errorAt.getTime() : null,
          thresholdMs,
        },
      });
      await db.update(agents).set({ errorAlertedAt: now }).where(eq(agents.id, agent.id));
    }

    return { checked: stalled.length, alerted: stalled.length };
  }

  return { tick };
}
