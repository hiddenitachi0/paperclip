-- DUR-5002: the versioned strategy rule book (StrategySpec v2).
--
-- One new table and four additive columns:
--   * trading_strategy_versions: one immutable row per proposed version of a
--     strategy's rules (draft -> approved -> superseded), with who proposed it
--     (user / agent / system), who approved it, the spec as jsonb, the free-text
--     guidelines and a SHA-256 digest of both. grandfathered marks the legacy
--     version made from a pre-existing sma_crossover@1 strategy.
--   * trading_strategies.active_version_id: the one version the tick reads. A
--     composite foreign key keeps it on the same strategy and company.
--   * trading_orders.strategy_version_id and trading_ledger_entries.
--     strategy_version_id: every order and ledger row is stamped with the
--     version in force. Nullable: old rows are stamped by the server's boot-time
--     legacy conversion (it also writes the legacy versions, because their
--     digest is the SHA-256 of the canonical JSON, which only the app computes).
--   * Two triggers. trading_strategy_versions_guard refuses any change to a
--     stored version's content and any status move other than draft ->
--     approved, draft -> superseded, approved -> superseded. trading_strategies_
--     cache_guard refuses a write to rule_config / risk_config unless
--     active_version_id changes in the same statement (so the cache is only
--     written in the activation transaction), and an active version must be
--     approved.
-- Row-level security and grants follow 0251: company-scoped, so the new table
-- is in both lists of 0164_rls_login_roles.sql.
--
-- No existing row is rewritten. Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only this feature reads these objects; the old code ignores
-- them and keeps using rule_config / risk_config, which stay filled):
--   DROP TRIGGER IF EXISTS trading_strategies_cache_guard ON trading_strategies;
--   DROP TRIGGER IF EXISTS trading_strategy_versions_guard ON trading_strategy_versions;
--   DROP FUNCTION IF EXISTS trading_strategies_cache_guard();
--   DROP FUNCTION IF EXISTS trading_strategy_versions_guard();
--   ALTER TABLE trading_strategies DROP CONSTRAINT IF EXISTS trading_strategies_active_version_fk,
--     DROP COLUMN IF EXISTS active_version_id;
--   ALTER TABLE trading_orders DROP COLUMN IF EXISTS strategy_version_id;
--   ALTER TABLE trading_ledger_entries DROP COLUMN IF EXISTS strategy_version_id;
--   DROP TABLE IF EXISTS trading_strategy_versions;
-- Dropping the table loses the version history (specs, who approved what), so
-- take a dump of it first if any real version has been approved.
CREATE TABLE IF NOT EXISTS "trading_strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"guidelines" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"approval_id" uuid,
	"spec_digest" text NOT NULL,
	"grandfathered" boolean DEFAULT false NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_strategy_versions_status_check" CHECK ("trading_strategy_versions"."status" IN ('draft', 'approved', 'superseded')),
	CONSTRAINT "trading_strategy_versions_proposer_type_check" CHECK ("trading_strategy_versions"."proposed_by_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "trading_strategy_versions_proposer_id_check" CHECK ("trading_strategy_versions"."proposed_by_type" = 'system' OR "trading_strategy_versions"."proposed_by_id" IS NOT NULL),
	CONSTRAINT "trading_strategy_versions_version_check" CHECK ("trading_strategy_versions"."version" > 0),
	CONSTRAINT "trading_strategy_versions_digest_check" CHECK ("trading_strategy_versions"."spec_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trading_strategy_versions_approval_pair_check" CHECK ("trading_strategy_versions"."status" <> 'approved' OR "trading_strategy_versions"."grandfathered" OR ("trading_strategy_versions"."approved_by_user_id" IS NOT NULL AND "trading_strategy_versions"."approved_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD COLUMN IF NOT EXISTS "strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_orders" ADD COLUMN IF NOT EXISTS "strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "active_version_id" uuid;--> statement-breakpoint
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
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_strategy_versions_strategy_version_uq" ON "trading_strategy_versions" USING btree ("strategy_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_strategy_versions_owner_uq" ON "trading_strategy_versions" USING btree ("id","strategy_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_strategy_versions_one_draft_uq" ON "trading_strategy_versions" USING btree ("strategy_id") WHERE "trading_strategy_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_strategy_versions_approval_uq" ON "trading_strategy_versions" USING btree ("approval_id") WHERE "trading_strategy_versions"."approval_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_strategy_versions_company_idx" ON "trading_strategy_versions" USING btree ("company_id","strategy_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_strategy_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_strategy_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_strategy_version_id_trading_strategy_versions_id_fk') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_strategy_version_id_trading_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."trading_strategy_versions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_active_version_fk') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_active_version_fk" FOREIGN KEY ("active_version_id","id","company_id") REFERENCES "public"."trading_strategy_versions"("id","strategy_id","company_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_ledger_entries_version_idx" ON "trading_ledger_entries" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_orders_version_idx" ON "trading_orders" USING btree ("strategy_version_id");--> statement-breakpoint
-- A stored version is immutable: its content never changes, and its status only moves forward.
CREATE OR REPLACE FUNCTION trading_strategy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
    RAISE EXCEPTION 'trading_strategy_versions: the content of a stored version never changes; propose a new version instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('approved', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'trading_strategy_versions: a % version cannot become %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR (NEW.approval_id IS DISTINCT FROM OLD.approval_id AND NEW.approval_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'trading_strategy_versions: who approved a version, and its card, never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_strategy_versions_guard ON trading_strategy_versions;--> statement-breakpoint
CREATE TRIGGER trading_strategy_versions_guard BEFORE UPDATE ON trading_strategy_versions FOR EACH ROW EXECUTE FUNCTION trading_strategy_versions_guard();--> statement-breakpoint
-- rule_config / risk_config are a cache of the active version: written only together with a change of active_version_id (the activation transaction), and the active version must be approved.
CREATE OR REPLACE FUNCTION trading_strategies_cache_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.rule_config IS DISTINCT FROM OLD.rule_config OR NEW.risk_config IS DISTINCT FROM OLD.risk_config)
    AND NEW.active_version_id IS NOT DISTINCT FROM OLD.active_version_id THEN
    RAISE EXCEPTION 'trading_strategies: rule_config and risk_config are a cache of the active version and can only change when it is activated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.active_version_id IS NOT NULL AND NEW.active_version_id IS DISTINCT FROM OLD.active_version_id THEN
    IF NOT EXISTS (SELECT 1 FROM trading_strategy_versions v WHERE v.id = NEW.active_version_id AND v.status = 'approved') THEN
      RAISE EXCEPTION 'trading_strategies: only an approved version can be the active version' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_strategies_cache_guard ON trading_strategies;--> statement-breakpoint
CREATE TRIGGER trading_strategies_cache_guard BEFORE UPDATE OF rule_config, risk_config, active_version_id ON trading_strategies FOR EACH ROW EXECUTE FUNCTION trading_strategies_cache_guard();--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0251 used. Safe where the 0149/0164 roles are absent. Company isolation does NOT rest on this: every query in the code filters on the caller's company.
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
