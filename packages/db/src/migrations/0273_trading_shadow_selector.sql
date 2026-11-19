-- DUR-5015: the shadow tournament and the strategy selector.
--
-- What this migration does (strictly additive; no existing row is touched):
--   * trading_selector_rules: the selector's rules, one immutable row per
--     version, written in advance. Instance-wide, no company_id (login-role list
--     of 0164 only), like the eligibility matrices of 0271.
--   * trading_shadow_cells: the trial registry. One row per company and
--     (template version x weather x coin); the row count is what the
--     false-discovery control has to pay for.
--   * trading_shadow_trades: simulated trades of the shadow runs. A shadow run
--     touches no paper balance, order, ledger entry or approval card. The
--     database refuses an insert that is born closed, keeps what a trade was
--     decided on fixed, and makes a closed or void trade final. At most ONE
--     trade per (company, template version, coin) is open, so a cell's trades
--     never overlap (that is what makes them independent).
--   * trading_selector_decisions: one immutable row per company per monthly
--     checkpoint, with the state it went in with and the output, plus digests
--     so the decision can be recomputed from stored trades and compared.
--     risk_caps_changed can only ever be false.
--   * trading_selector_confirmations: the fresh confirmation windows and
--     which cells hold paper cash. A failed or expired window is final.
--
-- Company-scoped (RLS policy and grants below, tables in both arrays of 0164)
-- except trading_selector_rules. Every statement is guarded so a re-run is a
-- no-op.
--
-- Rollback (safe: only this feature reads these objects; nothing else references
-- them, no paper balance, order or card was ever written by it. Dropping loses
-- the shadow trades and the selector's decision history, which cannot be
-- rebuilt because it is a record of what was seen at the time, so do not roll
-- back casually after a checkpoint has run):
--   DROP TABLE IF EXISTS "trading_selector_confirmations";
--   DROP TABLE IF EXISTS "trading_selector_decisions";
--   DROP TABLE IF EXISTS "trading_shadow_trades";
--   DROP TABLE IF EXISTS "trading_shadow_cells";
--   DROP TABLE IF EXISTS "trading_selector_rules";
--   DROP FUNCTION IF EXISTS trading_shadow_trades_insert_guard();
--   DROP FUNCTION IF EXISTS trading_shadow_trades_guard();
--   DROP FUNCTION IF EXISTS trading_selector_decisions_guard();
--   DROP FUNCTION IF EXISTS trading_selector_confirmations_guard();
--   DROP FUNCTION IF EXISTS trading_selector_rules_guard();
CREATE TABLE IF NOT EXISTS "trading_selector_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"opened_checkpoint_at" timestamp with time zone NOT NULL,
	"opened_decision_id" uuid NOT NULL,
	"ended_checkpoint_at" timestamp with time zone,
	"ended_decision_id" uuid,
	"promoted" boolean DEFAULT false NOT NULL,
	"promoted_at" timestamp with time zone,
	"demoted_at" timestamp with time zone,
	"window_trades" integer DEFAULT 0 NOT NULL,
	"window_mean_r" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_selector_confirmations_status_check" CHECK ("trading_selector_confirmations"."status" IN ('running', 'passed', 'failed', 'expired')),
	CONSTRAINT "trading_selector_confirmations_promoted_check" CHECK ("trading_selector_confirmations"."promoted" = false OR "trading_selector_confirmations"."status" = 'passed')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_selector_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"checkpoint_at" timestamp with time zone NOT NULL,
	"rules_version" integer NOT NULL,
	"rules_digest" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"state_before" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"output_digest" text NOT NULL,
	"choice" text NOT NULL,
	"trials" integer NOT NULL,
	"tested" integer NOT NULL,
	"discoveries" integer NOT NULL,
	"reason" text NOT NULL,
	"risk_caps_changed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_selector_decisions_choice_check" CHECK ("trading_selector_decisions"."choice" IN ('cash', 'cells')),
	CONSTRAINT "trading_selector_decisions_risk_check" CHECK ("trading_selector_decisions"."risk_caps_changed" = false),
	CONSTRAINT "trading_selector_decisions_digest_check" CHECK ("trading_selector_decisions"."rules_digest" ~ '^[0-9a-f]{64}$' AND "trading_selector_decisions"."input_digest" ~ '^[0-9a-f]{64}$' AND "trading_selector_decisions"."output_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_selector_decisions_counts_check" CHECK ("trading_selector_decisions"."trials" >= 0 AND "trading_selector_decisions"."tested" >= 0 AND "trading_selector_decisions"."tested" <= "trading_selector_decisions"."trials" AND "trading_selector_decisions"."discoveries" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_selector_rules" (
	"version" integer PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"digest" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_selector_rules_version_check" CHECK ("trading_selector_rules"."version" >= 1),
	CONSTRAINT "trading_selector_rules_digest_check" CHECK ("trading_selector_rules"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_shadow_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"family" text NOT NULL,
	"weather" text NOT NULL,
	"asset" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_shadow_cells_weather_check" CHECK ("trading_shadow_cells"."weather" IN ('up', 'range', 'down', 'squeeze', 'high_volatility')),
	CONSTRAINT "trading_shadow_cells_version_check" CHECK ("trading_shadow_cells"."template_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_shadow_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"asset" text NOT NULL,
	"timeframe" text NOT NULL,
	"weather" text NOT NULL,
	"signal_bar_close_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weather_label" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_checked_bar_at" timestamp with time zone,
	"entry_at" timestamp with time zone,
	"exit_at" timestamp with time zone,
	"entry_price" double precision,
	"exit_price" double precision,
	"exit_reason" text,
	"bars_held" integer,
	"r_1x" double precision,
	"r_2x" double precision,
	"net_return_1x" double precision,
	"net_return_2x" double precision,
	"void_reason" text,
	"resolved_at" timestamp with time zone,
	"engine_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_shadow_trades_status_check" CHECK ("trading_shadow_trades"."status" IN ('open', 'closed', 'void')),
	CONSTRAINT "trading_shadow_trades_weather_check" CHECK ("trading_shadow_trades"."weather" IN ('up', 'range', 'down', 'squeeze', 'high_volatility')),
	CONSTRAINT "trading_shadow_trades_closed_check" CHECK (("trading_shadow_trades"."status" = 'closed' AND "trading_shadow_trades"."entry_at" IS NOT NULL AND "trading_shadow_trades"."exit_at" IS NOT NULL AND "trading_shadow_trades"."entry_price" IS NOT NULL AND "trading_shadow_trades"."exit_price" IS NOT NULL AND "trading_shadow_trades"."exit_reason" IS NOT NULL AND "trading_shadow_trades"."net_return_1x" IS NOT NULL AND "trading_shadow_trades"."net_return_2x" IS NOT NULL AND "trading_shadow_trades"."resolved_at" IS NOT NULL AND "trading_shadow_trades"."exit_at" >= "trading_shadow_trades"."entry_at" AND "trading_shadow_trades"."entry_at" >= "trading_shadow_trades"."signal_bar_close_at")
        OR ("trading_shadow_trades"."status" = 'void' AND "trading_shadow_trades"."void_reason" IS NOT NULL AND "trading_shadow_trades"."resolved_at" IS NOT NULL AND "trading_shadow_trades"."entry_at" IS NULL AND "trading_shadow_trades"."exit_at" IS NULL AND "trading_shadow_trades"."r_1x" IS NULL AND "trading_shadow_trades"."r_2x" IS NULL)
        OR ("trading_shadow_trades"."status" = 'open' AND "trading_shadow_trades"."entry_at" IS NULL AND "trading_shadow_trades"."exit_at" IS NULL AND "trading_shadow_trades"."resolved_at" IS NULL AND "trading_shadow_trades"."r_1x" IS NULL AND "trading_shadow_trades"."r_2x" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_selector_confirmations_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_selector_confirmations" ADD CONSTRAINT "trading_selector_confirmations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_selector_confirmations_cell_id_trading_shadow_cells_id_fk') THEN
    ALTER TABLE "trading_selector_confirmations" ADD CONSTRAINT "trading_selector_confirmations_cell_id_trading_shadow_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."trading_shadow_cells"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_selector_confirmations_opened_decision_id_trading_selector_decisions_id_fk') THEN
    ALTER TABLE "trading_selector_confirmations" ADD CONSTRAINT "trading_selector_confirmations_opened_decision_id_trading_selector_decisions_id_fk" FOREIGN KEY ("opened_decision_id") REFERENCES "public"."trading_selector_decisions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_selector_confirmations_ended_decision_id_trading_selector_decisions_id_fk') THEN
    ALTER TABLE "trading_selector_confirmations" ADD CONSTRAINT "trading_selector_confirmations_ended_decision_id_trading_selector_decisions_id_fk" FOREIGN KEY ("ended_decision_id") REFERENCES "public"."trading_selector_decisions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_selector_decisions_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_selector_decisions" ADD CONSTRAINT "trading_selector_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_selector_decisions_rules_version_trading_selector_rules_version_fk') THEN
    ALTER TABLE "trading_selector_decisions" ADD CONSTRAINT "trading_selector_decisions_rules_version_trading_selector_rules_version_fk" FOREIGN KEY ("rules_version") REFERENCES "public"."trading_selector_rules"("version") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_shadow_cells_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_shadow_cells" ADD CONSTRAINT "trading_shadow_cells_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_shadow_trades_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_shadow_trades" ADD CONSTRAINT "trading_shadow_trades_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_shadow_trades_cell_id_trading_shadow_cells_id_fk') THEN
    ALTER TABLE "trading_shadow_trades" ADD CONSTRAINT "trading_shadow_trades_cell_id_trading_shadow_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."trading_shadow_cells"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_selector_confirmations_one_live_uq" ON "trading_selector_confirmations" USING btree ("cell_id") WHERE "trading_selector_confirmations"."status" IN ('running', 'passed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_selector_confirmations_company_idx" ON "trading_selector_confirmations" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_selector_decisions_checkpoint_uq" ON "trading_selector_decisions" USING btree ("company_id","checkpoint_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_selector_decisions_company_idx" ON "trading_selector_decisions" USING btree ("company_id","checkpoint_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_shadow_cells_cell_uq" ON "trading_shadow_cells" USING btree ("company_id","template_key","template_version","weather","asset");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_shadow_cells_company_idx" ON "trading_shadow_cells" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_shadow_trades_one_per_bar_uq" ON "trading_shadow_trades" USING btree ("company_id","template_key","template_version","asset","signal_bar_close_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_shadow_trades_one_open_uq" ON "trading_shadow_trades" USING btree ("company_id","template_key","template_version","asset") WHERE "trading_shadow_trades"."status" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_shadow_trades_cell_idx" ON "trading_shadow_trades" USING btree ("cell_id","exit_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_shadow_trades_open_idx" ON "trading_shadow_trades" USING btree ("asset","timeframe") WHERE "trading_shadow_trades"."status" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_shadow_trades_company_idx" ON "trading_shadow_trades" USING btree ("company_id","signal_bar_close_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_shadow_trades_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'trading_shadow_trades: a shadow trade starts open; its result is written when it closes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.signal_bar_close_at > now() THEN
    RAISE EXCEPTION 'trading_shadow_trades: the signal bar has not closed yet'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_shadow_trades_insert_guard ON "trading_shadow_trades";
--> statement-breakpoint
CREATE TRIGGER trading_shadow_trades_insert_guard
  BEFORE INSERT ON "trading_shadow_trades"
  FOR EACH ROW EXECUTE FUNCTION trading_shadow_trades_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_shadow_trades_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('closed', 'void') THEN
    RAISE EXCEPTION 'trading_shadow_trades: a closed shadow trade is final'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.cell_id IS DISTINCT FROM OLD.cell_id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
     OR NEW.weather IS DISTINCT FROM OLD.weather
     OR NEW.signal_bar_close_at IS DISTINCT FROM OLD.signal_bar_close_at
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.weather_label IS DISTINCT FROM OLD.weather_label
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trading_shadow_trades: what a shadow trade was decided on never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'open' AND NEW.last_checked_bar_at IS NOT NULL AND OLD.last_checked_bar_at IS NOT NULL AND NEW.last_checked_bar_at < OLD.last_checked_bar_at THEN
    RAISE EXCEPTION 'trading_shadow_trades: the resolver only moves forward'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_shadow_trades_guard ON "trading_shadow_trades";
--> statement-breakpoint
CREATE TRIGGER trading_shadow_trades_guard
  BEFORE UPDATE ON "trading_shadow_trades"
  FOR EACH ROW EXECUTE FUNCTION trading_shadow_trades_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_selector_decisions_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trading_selector_decisions: a decision is a record and never changes'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_selector_decisions_guard ON "trading_selector_decisions";
--> statement-breakpoint
CREATE TRIGGER trading_selector_decisions_guard
  BEFORE UPDATE ON "trading_selector_decisions"
  FOR EACH ROW EXECUTE FUNCTION trading_selector_decisions_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_selector_rules_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trading_selector_rules: a rules version is final; write a new version instead'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_selector_rules_guard ON "trading_selector_rules";
--> statement-breakpoint
CREATE TRIGGER trading_selector_rules_guard
  BEFORE UPDATE ON "trading_selector_rules"
  FOR EACH ROW EXECUTE FUNCTION trading_selector_rules_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_selector_confirmations_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('failed', 'expired') THEN
    RAISE EXCEPTION 'trading_selector_confirmations: a failed or expired window is final; a cell earns a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.cell_id IS DISTINCT FROM OLD.cell_id
     OR NEW.opened_checkpoint_at IS DISTINCT FROM OLD.opened_checkpoint_at
     OR NEW.opened_decision_id IS DISTINCT FROM OLD.opened_decision_id THEN
    RAISE EXCEPTION 'trading_selector_confirmations: what a window was opened on never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'running' AND NEW.status IN ('passed', 'failed', 'expired')) OR (OLD.status = 'passed' AND NEW.status = 'failed')) THEN
    RAISE EXCEPTION 'trading_selector_confirmations: a window cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_selector_confirmations_guard ON "trading_selector_confirmations";
--> statement-breakpoint
CREATE TRIGGER trading_selector_confirmations_guard
  BEFORE UPDATE ON "trading_selector_confirmations"
  FOR EACH ROW EXECUTE FUNCTION trading_selector_confirmations_guard();
--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0272 used. Safe where
-- the 0149/0164 roles are absent. Company isolation does NOT rest on this:
-- every query in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trading_shadow_cells', 'trading_shadow_trades', 'trading_selector_decisions', 'trading_selector_confirmations'] LOOP
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
  END LOOP;
  -- The rules are instance-wide: the scoped role may only read; only the bypass login writes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT ON TABLE trading_selector_rules TO paperclip_app_scoped;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trading_selector_rules TO paperclip_app_bypass_login;
  END IF;
END $$;
