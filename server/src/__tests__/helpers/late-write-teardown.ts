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

export interface LateWriteDrainOptions {
  /** Maximum number of drain+delete attempts before rethrowing. */
  attempts?: number;
  /** Delay between attempts, in milliseconds. */
  delayMs?: number;
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
