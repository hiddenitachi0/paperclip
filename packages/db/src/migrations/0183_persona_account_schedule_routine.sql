-- DUR-4016 (DUR-134 item 4, review follow-up): the operator-set cadence a
-- persona account writes on, wired through the existing routines /
-- routine_triggers primitive rather than a bare cron column.
--
-- After this migration:
--   * persona_accounts.schedule_routine_id (uuid, nullable, FK ->
--     routines.id ON DELETE SET NULL) points at the routine whose schedule
--     trigger briefs the persona's agent to write and queue a post for this
--     account. Null means no schedule is configured yet -- unchanged
--     behaviour, the account can still be posted to manually or by the
--     persona's own agent at any time.
--
-- Strictly additive: one nullable column, no row written, no existing
-- constraint touched. Every statement is guarded so a re-run is a no-op.
ALTER TABLE "persona_accounts" ADD COLUMN IF NOT EXISTS "schedule_routine_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'persona_accounts_schedule_routine_id_routines_id_fk') THEN
    ALTER TABLE "persona_accounts" ADD CONSTRAINT "persona_accounts_schedule_routine_id_routines_id_fk" FOREIGN KEY ("schedule_routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
