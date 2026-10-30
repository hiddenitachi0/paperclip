-- DUR-5002: strategy rule book v2. One immutable row per version of a
-- strategy's rules (draft -> approved -> superseded), and one source of truth
-- for the tick: trading_strategies.active_version_id. See
-- packages/db/src/schema/trading.ts and packages/shared/src/trading-spec.ts.
--
-- What this migration does (strictly additive; no existing row is rewritten):
--   * trading_strategy_versions: the versions table, company-scoped (RLS in
--     both lists of 0164, policy and grants below, same shape as 0251/0252).
--   * A trigger that makes a version row immutable. spec, guidelines,
--     spec_digest, version, owner and proposer can never change on any row;
--     status may only move draft -> approved, draft -> superseded and
--     approved -> superseded; once a row has left 'draft' its approval fields
--     are frozen too. Rows are only ever removed by the cascade from the
--     strategy or company.
--   * A trigger on trading_strategies that refuses an active_version_id that
--     is not an approved version of that same strategy.
--   * trading_strategies.active_version_id and .position_levels (nullable).
--   * trading_orders.strategy_version_id and trading_ledger_entries
--     .strategy_version_id (nullable): every order and ledger row is stamped
--     with the version that produced it. Rows written before this migration
--     keep NULL.
--
-- Existing sma_crossover@1 strategies are NOT converted here. The server
-- converts each one into an approved, grandfathered version 1 at boot (and
-- again on first use), because the version's digest is a SHA-256 over a
-- canonical text that only application code produces. Until then a strategy
-- has active_version_id NULL and keeps working from rule_config/risk_config.
--
-- rule_config and risk_config stay NOT NULL and keep their current meaning
-- for old code; from now on they are a cache written only in the activation
-- transaction.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only this feature reads the new objects; old code ignores
-- the new columns and keeps trading from rule_config/risk_config, which the
-- cache keeps equal to the last active version):
--   DROP TRIGGER IF EXISTS trading_strategies_active_version_guard ON "trading_strategies";
--   DROP FUNCTION IF EXISTS trading_strategies_active_version_guard();
--   ALTER TABLE "trading_strategies" DROP COLUMN IF EXISTS "active_version_id", DROP COLUMN IF EXISTS "position_levels";
--   ALTER TABLE "trading_orders" DROP COLUMN IF EXISTS "strategy_version_id";
--   ALTER TABLE "trading_ledger_entries" DROP COLUMN IF EXISTS "strategy_version_id";
--   DROP TABLE IF EXISTS "trading_strategy_versions";
--   DROP FUNCTION IF EXISTS trading_strategy_versions_immutable();
-- Dropping the table loses only the version history, not any order, ledger
-- row or strategy.
CREATE TABLE IF NOT EXISTS "trading_strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"guidelines" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"spec_digest" text NOT NULL,
	"grandfathered" boolean DEFAULT false NOT NULL,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_strategy_versions_status_check" CHECK ("trading_strategy_versions"."status" IN ('draft', 'approved', 'superseded')),
	CONSTRAINT "trading_strategy_versions_proposer_check" CHECK ("trading_strategy_versions"."proposed_by_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "trading_strategy_versions_version_check" CHECK ("trading_strategy_versions"."version" >= 1),
	CONSTRAINT "trading_strategy_versions_digest_check" CHECK ("trading_strategy_versions"."spec_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_strategy_versions_approval_pair_check" CHECK ("trading_strategy_versions"."status" <> 'approved' OR ("trading_strategy_versions"."approved_at" IS NOT NULL AND ("trading_strategy_versions"."approved_by_user_id" IS NOT NULL OR "trading_strategy_versions"."grandfathered")))
);
--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD COLUMN IF NOT EXISTS "strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_orders" ADD COLUMN IF NOT EXISTS "strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "active_version_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "position_levels" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategy_versions_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_strategy_versions" ADD CONSTRAINT "trading_strategy_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategy_versions_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_strategy_versions" ADD CONSTRAINT "trading_strategy_versions_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategy_versions_approval_id_approvals_id_fk') THEN
    ALTER TABLE "trading_strategy_versions" ADD CONSTRAINT "trading_strategy_versions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_strategy_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_strategy_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_strategy_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_strategy_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_active_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_active_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_strategy_versions_strategy_version_uq" ON "trading_strategy_versions" USING btree ("strategy_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_strategy_versions_one_approved_uq" ON "trading_strategy_versions" USING btree ("strategy_id") WHERE "trading_strategy_versions"."status" = 'approved';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_strategy_versions_company_idx" ON "trading_strategy_versions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_strategy_versions_approval_idx" ON "trading_strategy_versions" USING btree ("approval_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_strategy_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.spec IS DISTINCT FROM OLD.spec
     OR NEW.guidelines IS DISTINCT FROM OLD.guidelines
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.proposed_by_type IS DISTINCT FROM OLD.proposed_by_type
     OR NEW.proposed_by_id IS DISTINCT FROM OLD.proposed_by_id
     OR NEW.grandfathered IS DISTINCT FROM OLD.grandfathered
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trading_strategy_versions: a version''s rules, guidelines, digest and origin never change; propose a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft' AND NEW.status IN ('approved', 'superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'trading_strategy_versions: a version cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- The card link is set once while the version is a draft (and can only be cleared afterwards, by the card's own deletion).
  IF NEW.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id AND (OLD.approval_id IS NOT NULL OR OLD.status <> 'draft') THEN
    RAISE EXCEPTION 'trading_strategy_versions: the approval card of a version is fixed once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'trading_strategy_versions: who approved a version, and when, never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'trading_strategy_versions: a superseded version is final'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_strategy_versions_immutable ON "trading_strategy_versions";
--> statement-breakpoint
CREATE TRIGGER trading_strategy_versions_immutable
  BEFORE UPDATE ON "trading_strategy_versions"
  FOR EACH ROW EXECUTE FUNCTION trading_strategy_versions_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_strategies_active_version_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.active_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trading_strategy_versions v
    WHERE v.id = NEW.active_version_id AND v.strategy_id = NEW.id AND v.company_id = NEW.company_id AND v.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'trading_strategies: the active version must be an approved version of this same strategy'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_strategies_active_version_guard ON "trading_strategies";
--> statement-breakpoint
CREATE TRIGGER trading_strategies_active_version_guard
  BEFORE INSERT OR UPDATE OF active_version_id ON "trading_strategies"
  FOR EACH ROW EXECUTE FUNCTION trading_strategies_active_version_guard();
--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0251 and 0252 used.
-- Safe where the 0149/0164 roles are absent. Company isolation does NOT rest
-- on this: every query in the code filters on the caller's company. The table
-- is also listed in both arrays of 0164.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['trading_strategy_versions'] LOOP
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
    FOREACH t IN ARRAY ARRAY['trading_strategy_versions'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
