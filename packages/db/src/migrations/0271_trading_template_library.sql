-- DUR-5014: strategy template library. The eligibility matrix (versioned), the
-- stored past-data report of each template and the variants it tried, plus the
-- template a strategy was created from. Design: packages/db/src/schema/
-- trading_templates.ts; the templates themselves are code in
-- packages/shared/src/trading-templates.ts.
--
-- Strictly additive; no existing row is rewritten:
--   * trading_eligibility_matrices: one immutable row per matrix version.
--   * trading_template_reports: one row per requested report of one template
--     version; a finished row is final (trigger).
--   * trading_template_trials: the variants a report tried.
--   * trading_strategies.template_key / template_version (nullable): the
--     template a strategy came from. Existing strategies keep NULL.
--
-- The three new tables hold library data with NO company_id, so they are in the
-- login-role list of 0164_rls_login_roles.sql and carry no RLS policy. The
-- scoped login role may only SELECT; only the bypass login role (boot seeding
-- and the report worker) may INSERT/UPDATE, and nobody may DELETE.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only this feature reads the new objects; old code ignores the
-- new columns; dropping loses only the stored reports and matrix versions,
-- which can be rebuilt by running the reports again):
--   ALTER TABLE "trading_strategies" DROP COLUMN IF EXISTS "template_key", DROP COLUMN IF EXISTS "template_version";
--   DROP TABLE IF EXISTS "trading_template_trials";
--   DROP TABLE IF EXISTS "trading_template_reports";
--   DROP TABLE IF EXISTS "trading_eligibility_matrices";
--   DROP FUNCTION IF EXISTS trading_template_reports_guard();
--   DROP FUNCTION IF EXISTS trading_eligibility_matrices_immutable();
CREATE TABLE IF NOT EXISTS "trading_eligibility_matrices" (
	"version" integer PRIMARY KEY NOT NULL,
	"matrix" jsonb NOT NULL,
	"digest" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_eligibility_matrices_version_check" CHECK ("trading_eligibility_matrices"."version" >= 1),
	CONSTRAINT "trading_eligibility_matrices_digest_check" CHECK ("trading_eligibility_matrices"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_template_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"spec_digest" text NOT NULL,
	"matrix_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"params" jsonb NOT NULL,
	"report" jsonb,
	"gate" jsonb,
	"gate_passed" boolean,
	"result_digest" text,
	"variants_tried" integer DEFAULT 0 NOT NULL,
	"error" text,
	"holdout_start" timestamp with time zone,
	"holdout_end" timestamp with time zone,
	"holdout_seen_count" integer,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_template_reports_status_check" CHECK ("trading_template_reports"."status" IN ('queued', 'running', 'succeeded', 'failed', 'not_testable')),
	CONSTRAINT "trading_template_reports_requester_check" CHECK ("trading_template_reports"."requested_by_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "trading_template_reports_digest_check" CHECK ("trading_template_reports"."spec_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_template_reports_gate_passed_check" CHECK ("trading_template_reports"."gate_passed" IS NULL OR "trading_template_reports"."status" = 'succeeded'),
	CONSTRAINT "trading_template_reports_holdout_check" CHECK (("trading_template_reports"."holdout_start" IS NULL AND "trading_template_reports"."holdout_end" IS NULL AND "trading_template_reports"."holdout_seen_count" IS NULL) OR ("trading_template_reports"."holdout_start" IS NOT NULL AND "trading_template_reports"."holdout_end" IS NOT NULL AND "trading_template_reports"."holdout_seen_count" IS NOT NULL AND "trading_template_reports"."holdout_end" > "trading_template_reports"."holdout_start" AND "trading_template_reports"."holdout_seen_count" >= 0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_template_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"report_id" uuid NOT NULL,
	"variant_digest" text NOT NULL,
	"variant_label" text NOT NULL,
	"oos_sharpe" double precision,
	"oos_observations" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_template_trials_digest_check" CHECK ("trading_template_trials"."variant_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "template_key" text;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "template_version" integer;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_template_reports_matrix_version_trading_eligibility_matrices_version_fk') THEN
    ALTER TABLE "trading_template_reports" ADD CONSTRAINT "trading_template_reports_matrix_version_trading_eligibility_matrices_version_fk" FOREIGN KEY ("matrix_version") REFERENCES "public"."trading_eligibility_matrices"("version") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_template_trials_report_id_trading_template_reports_id_fk') THEN
    ALTER TABLE "trading_template_trials" ADD CONSTRAINT "trading_template_trials_report_id_trading_template_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."trading_template_reports"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_template_reports_template_idx" ON "trading_template_reports" USING btree ("template_key","template_version","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_template_reports_one_active_uq" ON "trading_template_reports" USING btree ("template_key","template_version") WHERE "trading_template_reports"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_template_reports_holdout_idx" ON "trading_template_reports" USING btree ("template_key") WHERE "trading_template_reports"."holdout_start" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_template_trials_variant_uq" ON "trading_template_trials" USING btree ("template_key","variant_digest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_template_trials_report_idx" ON "trading_template_trials" USING btree ("report_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_eligibility_matrices_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trading_eligibility_matrices: a matrix version never changes; add a new version instead'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_eligibility_matrices_immutable ON "trading_eligibility_matrices";
--> statement-breakpoint
CREATE TRIGGER trading_eligibility_matrices_immutable
  BEFORE UPDATE OR DELETE ON "trading_eligibility_matrices"
  FOR EACH ROW EXECUTE FUNCTION trading_eligibility_matrices_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_template_reports_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed', 'not_testable') THEN
    RAISE EXCEPTION 'trading_template_reports: a finished report is final; queue a new report instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.matrix_version IS DISTINCT FROM OLD.matrix_version
     OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.requested_by_type IS DISTINCT FROM OLD.requested_by_type
     OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trading_template_reports: what a report tests and how it was asked for never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_template_reports_guard ON "trading_template_reports";
--> statement-breakpoint
CREATE TRIGGER trading_template_reports_guard
  BEFORE UPDATE ON "trading_template_reports"
  FOR EACH ROW EXECUTE FUNCTION trading_template_reports_guard();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT ON TABLE "trading_eligibility_matrices", "trading_template_reports", "trading_template_trials" TO paperclip_app_scoped;
    -- ALTER DEFAULT PRIVILEGES from 0164 already granted the full set to new tables; take the writes back.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "trading_eligibility_matrices", "trading_template_reports", "trading_template_trials" FROM paperclip_app_scoped;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT ON TABLE "trading_eligibility_matrices", "trading_template_trials" TO paperclip_app_bypass_login;
    GRANT SELECT, INSERT, UPDATE ON TABLE "trading_template_reports" TO paperclip_app_bypass_login;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "trading_eligibility_matrices", "trading_template_trials" FROM paperclip_app_bypass_login;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "trading_template_reports" FROM paperclip_app_bypass_login;
  END IF;
END $$;
