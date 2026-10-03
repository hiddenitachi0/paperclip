import type { MorningReportOutboxItem } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Morning report outbox reads, board-only (same as the routes themselves —
 * see server/src/routes/morning-report.ts).
 */
export const morningReportsApi = {
  /**
   * One report by id, for the full briefing page. Depends on a single-item
   * outbox route (GET /companies/:companyId/morning-report-outbox/:reportId)
   * that does not exist on the server yet — see DUR-4075 for tracking. The
   * list route (`GET .../morning-report-outbox`) only returns `ready`
   * reports from the last 24h, so it cannot back a permalink.
   */
  get: (companyId: string, reportId: string) =>
    api.get<MorningReportOutboxItem>(`/companies/${companyId}/morning-report-outbox/${reportId}`),
  /** "Send a test report now" — composes and returns a report immediately, without consuming the day's scheduled slot. */
  sendTestNow: (companyId: string, agentId: string) =>
    api.post<MorningReportOutboxItem>(`/companies/${companyId}/agents/${agentId}/morning-report/test`, {}),
  /**
   * Past reports for one agent. Backed by the company-wide list route, which
   * today only returns reports still `status: "ready"` from the last 24h
   * (built for the Telegram bridge's polling, not a history view) — filtered
   * to this agent client-side. A real per-agent history route is tracked on
   * DUR-4080; until it lands this list only shows very recent, not-yet-
   * delivered reports, which the page says plainly.
   */
  listRecent: async (companyId: string, agentId: string) => {
    const { reports } = await api.get<{ reports: MorningReportOutboxItem[] }>(
      `/companies/${companyId}/morning-report-outbox`,
    );
    return reports.filter((r) => r.agentId === agentId);
  },
};
