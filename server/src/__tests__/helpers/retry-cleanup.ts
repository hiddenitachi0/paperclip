// DUR-392: the heartbeat integration test suites' afterEach cleanup polls
// heartbeatRuns.status until idle, then runs a hand-ordered cascade of
// db.delete()s. That poll only tracks run status -- it doesn't track every
// async write a run can still have in flight (e.g. an enqueueWakeup() a run
// kicks off as its last act, or a successful-run-handoff comment). Wrapping
// company-scoped writes in withCompanyScope (DUR-392's db.transaction ->
// withCompanyScope migration) adds one extra round trip per write for the
// session claim, which was enough to widen this pre-existing race: an
// in-flight insert can now land after the poll loop calls the DB idle but
// before the delete cascade reaches that table, so a child row briefly
// outlives the poll and the cascade's own delete of it, and a later delete
// of its parent 23503s.
//
// Retrying the whole (idempotent -- deleting an empty table is a no-op)
// cascade on a foreign-key-violation is a targeted fix for that race,
// without trying to make the idle poll enumerate every table a run might
// still be writing to.
export async function runCleanupCascadeWithRetry(
  cascade: () => Promise<void>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 100;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cascade();
      return;
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code
        ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== "23503" || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
