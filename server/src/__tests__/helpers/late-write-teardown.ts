/**
 * Shared teardown guard for FK violations caused by late background writes.
 *
 * Several request paths dispatch work fire-and-forget on purpose so the HTTP
 * response is not held up on it -- executeRun() dispatch (DUR-927), the
 * post-response wakeup fan-out (DUR-932), queueTaskWatchdogEvaluation()
 * (DUR-417). Those continuations outlive the request the test awaited, so a
 * test whose `afterEach` hard-deletes rows can have a child row *re-inserted*
 * between the child delete and the parent delete:
 *
 *   await db.delete(activityLog);      // child table drained
 *   ...                                // <-- background continuation inserts
 *                                      //     a fresh activity_log / agent_runtime_state row
 *   await db.delete(agents);           // 23503: still referenced
 *
 * The delete *order* in those tests is already correct -- reordering fixes
 * nothing. The fix is to re-drain the child tables and retry the parent
 * delete until it succeeds, which converges as soon as the background writer
 * stops. This is the generalised form of the two hand-rolled loops that
 * already existed in low-trust-red-team-routes.test.ts.
 *
 * Test-only helper: never import this from `src/` production code.
 */

import type { PgTable } from "drizzle-orm/pg-core";

export interface LateWriteDrainOptions {
  /** Maximum number of drain+delete attempts before rethrowing. */
  attempts?: number;
  /** Delay between attempts, in milliseconds. */
  delayMs?: number;
}

/** Postgres SQLSTATE for `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = "23503";
/** Postgres SQLSTATE for `deadlock_detected`. */
const DEADLOCK_DETECTED = "40P01";

function findPostgresErrorCode(error: unknown): string | null {
  // drizzle wraps the driver error ("Failed query: ...") in a DrizzleQueryError
  // and keeps the real PostgresError -- with its `.code` -- on `.cause`. Walk a
  // bounded depth so a malformed cause chain can't loop forever.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * True for the two error classes a late background write can cause in a
 * teardown delete: a 23503 (the child row landed after the child drain) or a
 * 40P01 (the delete collided with the writer's own transaction). Anything
 * else -- connection ended, syntax error, a genuinely wrong delete order --
 * is not something a retry can fix and must surface immediately.
 */
export function isLateWriteTeardownError(error: unknown): boolean {
  const code = findPostgresErrorCode(error);
  return code === FOREIGN_KEY_VIOLATION || code === DEADLOCK_DETECTED;
}

/**
 * Runs `drainChildren()` then `deleteParents()`, retrying the pair until the
 * parent delete succeeds (or `attempts` is exhausted, in which case the last
 * error is rethrown so the test still fails loudly rather than silently
 * leaking rows into the next test).
 *
 * Costs nothing on the happy path: the first attempt is the same two
 * statements the test would have run anyway.
 */
export async function deleteAfterLateWritesDrain(
  drainChildren: () => Promise<unknown>,
  deleteParents: () => Promise<unknown>,
  { attempts = 20, delayMs = 25 }: LateWriteDrainOptions = {},
): Promise<void> {
  if (attempts < 1) throw new Error("deleteAfterLateWritesDrain: attempts must be >= 1");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await drainChildren();
      await deleteParents();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** The slice of a drizzle `Db` this helper needs -- keeps it usable with a stub in its own tests. */
export interface TeardownDeleter {
  delete(table: PgTable): PromiseLike<unknown>;
}

/**
 * DUR-3925: the whole-teardown form of deleteAfterLateWritesDrain.
 *
 * Deletes `tables` in the given order (children first, exactly the order the
 * suites already hand-roll). If deleting a table fails because a late
 * background write re-populated one of its children (23503) or collided with
 * the writer's transaction (40P01), every table *before* it in the list is
 * drained again and the delete is retried, until it succeeds or `attempts`
 * is exhausted -- the last error is then rethrown so the test still fails
 * loudly. Any other error is rethrown immediately: a retry cannot fix a wrong
 * order or a dead connection, and looping on it would only hide the cause.
 *
 * Costs nothing on the happy path: exactly one `delete` per table, the same
 * statements the suite ran before adopting it. This is the one place a new
 * `activity_log -> agents` / `issue_documents -> companies` race gets fixed
 * for every suite that uses it, instead of the third hand-rolled retry loop
 * in the third file (DUR-927, DUR-3917, DUR-3919, DUR-3925 were all this
 * same bug in different table pairs).
 *
 * Usage:
 *
 *   afterEach(async () => {
 *     await deleteTablesAfterLateWritesDrain(db, [
 *       activityLog, heartbeatRunEvents, heartbeatRuns, issues, agents, companies,
 *     ]);
 *   });
 */
export async function deleteTablesAfterLateWritesDrain(
  db: TeardownDeleter,
  tables: readonly PgTable[],
  { attempts = 20, delayMs = 25 }: LateWriteDrainOptions = {},
): Promise<void> {
  if (attempts < 1) throw new Error("deleteTablesAfterLateWritesDrain: attempts must be >= 1");
  for (let index = 0; index < tables.length; index += 1) {
    const table = tables[index]!;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (attempt > 0) {
          // Re-drain the children deleted before this table: the late write
          // that tripped the previous attempt landed in one of them.
          for (const child of tables.slice(0, index)) await db.delete(child);
        }
        await db.delete(table);
        lastError = null;
        break;
      } catch (error) {
        if (!isLateWriteTeardownError(error)) throw error;
        lastError = error;
        if (attempt === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (lastError) throw lastError;
  }
}
