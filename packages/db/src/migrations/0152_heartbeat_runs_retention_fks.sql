-- DUR-319 (DUR-292 item 4): heartbeat_runs is 273 MB and growing unbounded,
-- and every row is a candidate for a leaked secret (NOR-316: 706 rows carried
-- a leaked GitHub PAT in stdout/stderr excerpts). Retention needs to actually
-- DELETE old rows, but five FK constraints into heartbeat_runs.id were left
-- at the drizzle-kit default (ON DELETE NO ACTION), which makes a real
-- DELETE fail with a foreign-key violation the moment any of those child
-- tables still references the row:
--
--   heartbeat_run_events.run_id      NOT NULL -- per-run event log, same
--                                              -- "may contain secrets" class
--                                              -- as heartbeat_runs itself ->
--                                              -- switched to ON DELETE CASCADE
--                                              -- so pruning a run prunes its
--                                              -- event log with it.
--   activity_log.run_id              nullable -- audit trail entry outlives
--   agent_task_sessions.last_run_id  nullable -- the run it points at ->
--   finance_events.heartbeat_run_id  nullable -- switched to ON DELETE SET
--   cost_events.heartbeat_run_id     nullable -- NULL so billing/audit
--                                              -- history is preserved.
--
-- Existing rows are untouched by this migration; only future deletes behave
-- differently. Rollback: re-add each constraint with ON DELETE NO ACTION
-- (safe at any time -- NO ACTION is strictly more restrictive, so rollback
-- can't orphan or cascade-delete anything the forward migration wouldn't
-- already have blocked).

ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "agent_task_sessions" DROP CONSTRAINT IF EXISTS "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_heartbeat_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_heartbeat_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
