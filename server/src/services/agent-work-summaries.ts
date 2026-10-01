import { and, desc, eq, ilike } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWorkSummaries } from "@paperclipai/db";

/**
 * DUR-4197: work-history storage for full agents. heartbeat.ts saves one
 * short, already-redacted summary per successful run; a later run of the
 * same agent can search what it did before instead of starting cold.
 *
 * Every read and write here is scoped to companyId + agentId -- there is no
 * cross-agent or cross-company query in this file. Routes layer on top of
 * this must resolve agentId from the authenticated actor, never from
 * caller-supplied input, so an agent can only ever see its own history.
 */

export const AGENT_WORK_SUMMARY_MAX_LENGTH = 2000;
export const AGENT_WORK_SUMMARY_DEFAULT_SEARCH_LIMIT = 20;
export const AGENT_WORK_SUMMARY_MAX_SEARCH_LIMIT = 100;

export type AgentWorkSummaryRow = typeof agentWorkSummaries.$inferSelect;

export interface SaveAgentWorkSummaryInput {
  companyId: string;
  agentId: string;
  issueId?: string | null;
  runId: string;
  summary: string;
}

export interface SearchAgentWorkSummariesInput {
  companyId: string;
  agentId: string;
  query?: string | null;
  limit?: number;
}

/**
 * Idempotent on runId (unique index): a retried finalize of the same run is
 * a no-op, never a duplicate row.
 */
export async function saveAgentWorkSummary(
  db: Db,
  input: SaveAgentWorkSummaryInput,
): Promise<AgentWorkSummaryRow | null> {
  const summary = input.summary.trim().slice(0, AGENT_WORK_SUMMARY_MAX_LENGTH);
  if (!summary) return null;

  const [row] = await db
    .insert(agentWorkSummaries)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId ?? null,
      runId: input.runId,
      summary,
    })
    .onConflictDoNothing({ target: agentWorkSummaries.runId })
    .returning();
  return row ?? null;
}

export async function searchAgentWorkSummaries(
  db: Db,
  input: SearchAgentWorkSummariesInput,
): Promise<AgentWorkSummaryRow[]> {
  const limit = Math.min(
    Math.max(input.limit ?? AGENT_WORK_SUMMARY_DEFAULT_SEARCH_LIMIT, 1),
    AGENT_WORK_SUMMARY_MAX_SEARCH_LIMIT,
  );
  const trimmedQuery = input.query?.trim();

  const conditions = [
    eq(agentWorkSummaries.companyId, input.companyId),
    eq(agentWorkSummaries.agentId, input.agentId),
  ];
  if (trimmedQuery) {
    conditions.push(ilike(agentWorkSummaries.summary, `%${trimmedQuery}%`));
  }

  return db
    .select()
    .from(agentWorkSummaries)
    .where(and(...conditions))
    .orderBy(desc(agentWorkSummaries.createdAt))
    .limit(limit);
}
