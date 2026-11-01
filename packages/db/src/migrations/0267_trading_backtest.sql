-- DUR-5008: the past-data test (walk-forward backtest) and the start gate.
--
-- What this migration does (strictly additive; no existing row is touched):
--   * trading_backtest_runs: one row per requested test of one strategy
--     version. company-scoped. The worker writes the report, the gate verdict
--     and the result digest once. A trigger makes a finished row final and
--     keeps the identity of a run fixed; an insert trigger refuses a run that
--     is born finished or already passed. gate_passed = true is what the start
--     gate in setStatus reads.
--   * trading_backtest_trials: the trial registry. One row per distinct variant
--     ever tried for a strategy (SHA-256 of its spec), so "how many variants
--     did we try" and the Deflated Sharpe ratio rest on rows that cannot be
--     edited (an UPDATE trigger refuses every change).
--   * trading_backtest_holdout_reads: one row per read of the holdout, with the
--     strategy and the template it came from. Append-only.
--   * trading_start_gate_overrides: an owner's written reason (at least 10
--     characters) for starting a version that has not passed. Append-only.
--
-- All four tables are company-scoped: RLS policy and grants below, and all four
-- are in both arrays of 0164, the same shape as 0251/0252/0266.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only this feature reads these objects. A strategy that was
-- started because a run passed or an owner overrode the gate keeps running;
-- after the rollback the gate simply no longer exists, so nothing is blocked):
--   DROP TABLE IF EXISTS "trading_start_gate_overrides";
--   DROP TABLE IF EXISTS "trading_backtest_holdout_reads";
--   DROP TABLE IF EXISTS "trading_backtest_trials";
--   DROP TABLE IF EXISTS "trading_backtest_runs";
--   DROP FUNCTION IF EXISTS trading_backtest_runs_guard();
--   DROP FUNCTION IF EXISTS trading_backtest_runs_insert_guard();
--   DROP FUNCTION IF EXISTS trading_backtest_append_only();
-- Dropping the tables loses only test results, the trial count, the holdout
-- read counts and the override records; no strategy, version, order or ledger
-- row refers to them. Losing the holdout read counts means a later read would
-- look clean again, so do not roll back casually after a holdout was read.
CREATE TABLE IF NOT EXISTS "trading_backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"spec_digest" text NOT NULL,
	"template_key" text,
	"params" jsonb NOT NULL,
	"report" jsonb,
	"gate" jsonb,
	"gate_passed" boolean,
	"result_digest" text,
	"variants_tried" integer DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_backtest_runs_purpose_check" CHECK ("trading_backtest_runs"."purpose" IN ('explore', 'gate')),
	CONSTRAINT "trading_backtest_runs_status_check" CHECK ("trading_backtest_runs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "trading_backtest_runs_requester_check" CHECK ("trading_backtest_runs"."requested_by_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "trading_backtest_runs_digest_check" CHECK ("trading_backtest_runs"."spec_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_backtest_runs_gate_passed_check" CHECK ("trading_backtest_runs"."gate_passed" IS NULL OR ("trading_backtest_runs"."purpose" = 'gate' AND "trading_backtest_runs"."status" = 'succeeded'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_backtest_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"template_key" text,
	"run_id" uuid NOT NULL,
	"variant_digest" text NOT NULL,
	"variant_label" text NOT NULL,
	"oos_sharpe" double precision,
	"oos_observations" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_backtest_trials_digest_check" CHECK ("trading_backtest_trials"."variant_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_backtest_holdout_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"template_key" text,
	"run_id" uuid NOT NULL,
	"holdout_start" timestamp with time zone NOT NULL,
	"holdout_end" timestamp with time zone NOT NULL,
	"seen_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_backtest_holdout_reads_range_check" CHECK ("trading_backtest_holdout_reads"."holdout_end" > "trading_backtest_holdout_reads"."holdout_start" AND "trading_backtest_holdout_reads"."seen_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_start_gate_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"overridden_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_start_gate_overrides_reason_check" CHECK (char_length(btrim("trading_start_gate_overrides"."reason")) >= 10)
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_runs_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_backtest_runs" ADD CONSTRAINT "trading_backtest_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_runs_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_backtest_runs" ADD CONSTRAINT "trading_backtest_runs_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_runs_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_backtest_runs" ADD CONSTRAINT "trading_backtest_runs_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_trials_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_backtest_trials" ADD CONSTRAINT "trading_backtest_trials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_trials_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_backtest_trials" ADD CONSTRAINT "trading_backtest_trials_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_trials_run_id_trading_backtest_runs_id_fk') THEN
    ALTER TABLE "trading_backtest_trials" ADD CONSTRAINT "trading_backtest_trials_run_id_trading_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trading_backtest_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_holdout_reads_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_backtest_holdout_reads" ADD CONSTRAINT "trading_backtest_holdout_reads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_holdout_reads_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_backtest_holdout_reads" ADD CONSTRAINT "trading_backtest_holdout_reads_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_holdout_reads_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_backtest_holdout_reads" ADD CONSTRAINT "trading_backtest_holdout_reads_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_backtest_holdout_reads_run_id_trading_backtest_runs_id_fk') THEN
    ALTER TABLE "trading_backtest_holdout_reads" ADD CONSTRAINT "trading_backtest_holdout_reads_run_id_trading_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trading_backtest_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_start_gate_overrides_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_start_gate_overrides" ADD CONSTRAINT "trading_start_gate_overrides_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_start_gate_overrides_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_start_gate_overrides" ADD CONSTRAINT "trading_start_gate_overrides_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_start_gate_overrides_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_start_gate_overrides" ADD CONSTRAINT "trading_start_gate_overrides_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_runs_company_idx" ON "trading_backtest_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_runs_strategy_idx" ON "trading_backtest_runs" USING btree ("strategy_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_runs_version_gate_idx" ON "trading_backtest_runs" USING btree ("version_id") WHERE "trading_backtest_runs"."gate_passed" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_runs_queue_idx" ON "trading_backtest_runs" USING btree ("status","created_at") WHERE "trading_backtest_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_backtest_runs_one_active_per_version_uq" ON "trading_backtest_runs" USING btree ("version_id","purpose") WHERE "trading_backtest_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_backtest_trials_variant_uq" ON "trading_backtest_trials" USING btree ("company_id","strategy_id","variant_digest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_trials_run_idx" ON "trading_backtest_trials" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_trials_template_idx" ON "trading_backtest_trials" USING btree ("company_id","template_key") WHERE "trading_backtest_trials"."template_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_backtest_holdout_reads_run_uq" ON "trading_backtest_holdout_reads" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_holdout_reads_strategy_idx" ON "trading_backtest_holdout_reads" USING btree ("company_id","strategy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_backtest_holdout_reads_template_idx" ON "trading_backtest_holdout_reads" USING btree ("company_id","template_key") WHERE "trading_backtest_holdout_reads"."template_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_start_gate_overrides_version_uq" ON "trading_start_gate_overrides" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_start_gate_overrides_company_idx" ON "trading_start_gate_overrides" USING btree ("company_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_backtest_runs_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'queued' OR NEW.gate_passed IS NOT NULL OR NEW.report IS NOT NULL OR NEW.gate IS NOT NULL OR NEW.result_digest IS NOT NULL OR NEW.variants_tried <> 0 THEN
    RAISE EXCEPTION 'trading_backtest_runs: a run starts queued and empty; its result is written by the worker'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_backtest_runs_insert_guard ON "trading_backtest_runs";
--> statement-breakpoint
CREATE TRIGGER trading_backtest_runs_insert_guard
  BEFORE INSERT ON "trading_backtest_runs"
  FOR EACH ROW EXECUTE FUNCTION trading_backtest_runs_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_backtest_runs_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'trading_backtest_runs: a finished run is final; queue a new run instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.requested_by_type IS DISTINCT FROM OLD.requested_by_type
     OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trading_backtest_runs: what a run tests and how it was asked for never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled')) OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'trading_backtest_runs: a run cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_backtest_runs_guard ON "trading_backtest_runs";
--> statement-breakpoint
CREATE TRIGGER trading_backtest_runs_guard
  BEFORE UPDATE ON "trading_backtest_runs"
  FOR EACH ROW EXECUTE FUNCTION trading_backtest_runs_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_backtest_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: rows are append-only; this record is never edited', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_backtest_trials_append_only ON "trading_backtest_trials";
--> statement-breakpoint
CREATE TRIGGER trading_backtest_trials_append_only
  BEFORE UPDATE ON "trading_backtest_trials"
  FOR EACH ROW EXECUTE FUNCTION trading_backtest_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_backtest_holdout_reads_append_only ON "trading_backtest_holdout_reads";
--> statement-breakpoint
CREATE TRIGGER trading_backtest_holdout_reads_append_only
  BEFORE UPDATE ON "trading_backtest_holdout_reads"
  FOR EACH ROW EXECUTE FUNCTION trading_backtest_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_start_gate_overrides_append_only ON "trading_start_gate_overrides";
--> statement-breakpoint
CREATE TRIGGER trading_start_gate_overrides_append_only
  BEFORE UPDATE ON "trading_start_gate_overrides"
  FOR EACH ROW EXECUTE FUNCTION trading_backtest_append_only();
--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0251, 0252 and 0266
-- used. Safe where the 0149/0164 roles are absent. Company isolation does NOT
-- rest on this: every query in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['trading_backtest_runs', 'trading_backtest_trials', 'trading_backtest_holdout_reads', 'trading_start_gate_overrides'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format(
          'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
          t
        );
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    FOREACH t IN ARRAY ARRAY['trading_backtest_runs', 'trading_backtest_trials', 'trading_backtest_holdout_reads', 'trading_start_gate_overrides'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
