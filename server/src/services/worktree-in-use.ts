import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";

/**
 * DUR-5184 / DUR-5237: locks are per task, not per folder. Before a start-of-run
 * branch switch, check that no other live run (any task) is working in this folder.
 *
 * A run is "working in this folder" when it has saved the folder in its context
 * (running), or it is queued / still setting up and is bound to the folder through
 * its own execution-workspace id or through its issue's saved folder -- a run that
 * has not saved its folder yet is invisible to the context check alone.
 */
export async function isWorktreeInUseByAnotherRun(
  db: Db,
  input: { companyId: string; runId: string; worktreePath: string },
): Promise<boolean> {
  const { companyId, runId, worktreePath } = input;
  const live = ["queued", "running"];

  const savedFolder = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "running"),
        ne(heartbeatRuns.id, runId),
        or(
          sql`${heartbeatRuns.contextSnapshot} -> 'paperclipWorkspace' ->> 'cwd' = ${worktreePath}`,
          sql`${heartbeatRuns.contextSnapshot} -> 'paperclipWorkspace' ->> 'worktreePath' = ${worktreePath}`,
        ),
      ),
    )
    .limit(1);
  if (savedFolder.length > 0) return true;

  const boundWorkspaces = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, companyId),
        or(eq(executionWorkspaces.cwd, worktreePath), eq(executionWorkspaces.providerRef, worktreePath)),
      ),
    );
  if (boundWorkspaces.length === 0) return false;
  const workspaceIds = boundWorkspaces.map((w) => w.id);

  const boundDirectly = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, live),
        ne(heartbeatRuns.id, runId),
        or(
          ...workspaceIds.map(
            (id) => sql`${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId' = ${id}`,
          ),
        ),
      ),
    )
    .limit(1);
  if (boundDirectly.length > 0) return true;

  const boundViaIssue = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(issues, sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'`)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, live),
        ne(heartbeatRuns.id, runId),
        eq(issues.companyId, companyId),
        inArray(issues.executionWorkspaceId, workspaceIds),
      ),
    )
    .limit(1);
  return boundViaIssue.length > 0;
}
