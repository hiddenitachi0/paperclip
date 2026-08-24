import { asc, eq, isNull } from "drizzle-orm";
import { companies, untrackedWriteIncidents, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

// DUR-130: `untracked_write_incidents` is populated at the database level by
// the `fn_flag_untracked_write` trigger (migration 0139) whenever a write to
// a DUR-128-relevant table doesn't carry a known-legitimate
// `application_name`. This just has to surface each new row through the
// existing activity-log/plugin-event pipeline (mirrors agent-error-alerts.ts)
// so it doesn't stay a quiet row nobody watches.
export function untrackedWriteAlertsService(db: Db) {
  async function companyIdsForIncident(incident: typeof untrackedWriteIncidents.$inferSelect): Promise<string[]> {
    if (incident.tableName === "companies" && incident.rowId) return [incident.rowId];
    if (incident.companyId) return [incident.companyId];

    // Tables with no tenant boundary of their own (e.g. instance_settings)
    // affect every company, so the alert has to fan out rather than be
    // silently dropped for lack of a companyId to hang it on.
    const rows = await db.select({ id: companies.id }).from(companies);
    return rows.map((row) => row.id);
  }

  async function tick(now = new Date()) {
    const pending = await db
      .select()
      .from(untrackedWriteIncidents)
      .where(isNull(untrackedWriteIncidents.alertedAt))
      .orderBy(asc(untrackedWriteIncidents.occurredAt));

    for (const incident of pending) {
      const companyIds = await companyIdsForIncident(incident);
      for (const companyId of companyIds) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "untracked-write-alerts",
          action: "db.untracked_write_detected",
          entityType: incident.tableName,
          entityId: incident.rowId ?? incident.id,
          details: {
            operation: incident.operation,
            applicationName: incident.applicationName,
            sessionUserName: incident.sessionUserName,
            occurredAt: incident.occurredAt.toISOString(),
          },
        });
      }
      await db
        .update(untrackedWriteIncidents)
        .set({ alertedAt: now })
        .where(eq(untrackedWriteIncidents.id, incident.id));
    }

    return { checked: pending.length, alerted: pending.length };
  }

  return { tick };
}
