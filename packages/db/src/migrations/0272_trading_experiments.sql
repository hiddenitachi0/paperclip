-- DUR-5018: the experiment runner.
--
-- What this migration does (strictly additive; no existing row is touched):
--   * trading_experiments: one row per experiment, a small capped parameter
--     grid on ONE strategy version, run walk-forward on past data (it never
--     reads the holdout). company-scoped. The worker writes the report, the
--     trial count, the Deflated Sharpe probability, the plateau check, the
--     number of holdout reads already made in the lineage and the result (a
--     recommended variant or "no change") once. A trigger makes a finished row
--     final, keeps what an experiment tests fixed, and an insert trigger
--     refuses a row that is born finished or already carrying a result. The
--     result is never applied by anything; the Trader's proposal route reads
--     it and refuses a proposal that does not cite a finished experiment that
--     recommended exactly those rules.
--   * trials (jsonb on the row) feeds the lineage trial registry, so the
--     Deflated Sharpe ratio of every later test counts the variants tried here.
--
-- Company-scoped: RLS policy and grants below, and the table is in both
-- arrays of 0164, the same shape as 0251/0252/0266/0268.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only this feature reads these objects. Rule changes that were
-- proposed and approved on the strength of an experiment stay approved; they
-- keep their own version rows and cards. After the rollback the Trader's
-- proposal route no longer finds experiments, and the deployed code would
-- refuse every proposal until it is rolled back as well):
--   DROP TABLE IF EXISTS "trading_experiments";
--   DROP FUNCTION IF EXISTS trading_experiments_guard();
--   DROP FUNCTION IF EXISTS trading_experiments_insert_guard();
-- Dropping the table loses only experiment results and the variants they
-- added to the trial count. Losing the trial count makes a later Deflated
-- Sharpe ratio look kinder than it should, so do not roll back casually after
-- experiments were run.
CREATE TABLE IF NOT EXISTS "trading_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"spec_digest" text NOT NULL,
	"template_key" text,
	"params" jsonb NOT NULL,
	"report" jsonb,
	"trials" jsonb,
	"trial_count" integer DEFAULT 0 NOT NULL,
	"registry_trial_count" integer,
	"deflated_sharpe" double precision,
	"plateau" jsonb,
	"holdout_reads_lineage" integer,
	"recommendation" jsonb,
	"recommended_variant_digest" text,
	"recommended_spec" jsonb,
	"result_digest" text,
	"error" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_experiments_status_check" CHECK ("trading_experiments"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "trading_experiments_requester_check" CHECK ("trading_experiments"."requested_by_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "trading_experiments_digest_check" CHECK ("trading_experiments"."spec_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_experiments_recommended_digest_check" CHECK ("trading_experiments"."recommended_variant_digest" IS NULL OR "trading_experiments"."recommended_variant_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_experiments_recommended_check" CHECK (("trading_experiments"."recommended_variant_digest" IS NULL AND "trading_experiments"."recommended_spec" IS NULL) OR ("trading_experiments"."status" = 'succeeded' AND "trading_experiments"."recommended_variant_digest" IS NOT NULL AND "trading_experiments"."recommended_spec" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_experiments_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_experiments" ADD CONSTRAINT "trading_experiments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_experiments_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_experiments" ADD CONSTRAINT "trading_experiments_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_experiments_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_experiments" ADD CONSTRAINT "trading_experiments_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_experiments_company_idx" ON "trading_experiments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_experiments_strategy_idx" ON "trading_experiments" USING btree ("strategy_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_experiments_queue_idx" ON "trading_experiments" USING btree ("status","created_at") WHERE "trading_experiments"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_experiments_one_active_per_version_uq" ON "trading_experiments" USING btree ("version_id") WHERE "trading_experiments"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_experiments_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'queued' OR NEW.report IS NOT NULL OR NEW.trials IS NOT NULL OR NEW.recommendation IS NOT NULL
     OR NEW.recommended_variant_digest IS NOT NULL OR NEW.recommended_spec IS NOT NULL OR NEW.result_digest IS NOT NULL
     OR NEW.trial_count <> 0 OR NEW.registry_trial_count IS NOT NULL OR NEW.deflated_sharpe IS NOT NULL
     OR NEW.plateau IS NOT NULL OR NEW.holdout_reads_lineage IS NOT NULL THEN
    RAISE EXCEPTION 'trading_experiments: an experiment starts queued and empty; its result is written by the worker'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_experiments_insert_guard ON "trading_experiments";
--> statement-breakpoint
CREATE TRIGGER trading_experiments_insert_guard
  BEFORE INSERT ON "trading_experiments"
  FOR EACH ROW EXECUTE FUNCTION trading_experiments_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_experiments_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'trading_experiments: a finished experiment is final; queue a new experiment instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.requested_by_type IS DISTINCT FROM OLD.requested_by_type
     OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trading_experiments: what an experiment tests and how it was asked for never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled')) OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'trading_experiments: an experiment cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_experiments_guard ON "trading_experiments";
--> statement-breakpoint
CREATE TRIGGER trading_experiments_guard
  BEFORE UPDATE ON "trading_experiments"
  FOR EACH ROW EXECUTE FUNCTION trading_experiments_guard();
--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0268 used. Safe where
-- the 0149/0164 roles are absent. Company isolation does NOT rest on this:
-- every query in the code filters on the caller's company.
DO $$
DECLARE
  t text := 'trading_experiments';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
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
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
  END IF;
END $$;
