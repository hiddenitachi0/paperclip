-- DUR-5026: trading wallets held by code. Decision #2 (Filip, 28 Oct 2026):
-- a trading wallet belongs to the trading routine, not to any agent. Its key
-- is generated on the server and stored as a crypto_wallet_key secret like
-- every other wallet key; no agent can use the wallet or read the key.
-- Design: packages/shared/src/crypto-wallets.ts ("Trading-routine wallets").
--
-- Additive changes only, no existing row is rewritten (every new column is
-- nullable or has a default that describes today's rows):
--   * crypto_wallets.holder ('agent' | 'trading_routine', default 'agent').
--     CHECK: a trading_routine wallet has no agent, is on the test network
--     and carries max_balance + daily_loss_stop. The database itself refuses
--     a code-held wallet on a main network (relax in a later migration).
--   * crypto_wallets limits/flow columns (max_balance, daily_loss_stop,
--     sweep_threshold, top_up_floor, top_up_target), the approved sweep
--     address and the pending one with its approval card, the open top-up
--     card, and the daily-loss bookkeeping (loss_day, loss_day_peak).
--   * crypto_wallet_transactions.initiated_by also allows 'routine';
--     new nullable routine_action ('sweep' | 'trade').
--   * company_crypto_settings.trader_agent_id (nullable, set null on delete).
--   * trading_alerts: the outbox the Telegram bridge polls (RLS like the
--     other crypto tables).
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DELETE FROM "crypto_wallet_transactions" WHERE "initiated_by" = 'routine';
-- DELETE FROM "crypto_wallets" WHERE "holder" = 'trading_routine' (the
-- crypto_wallet_key secrets stay in company_secrets; delete them only after
-- any test coins have been moved out); DROP TABLE "trading_alerts"; then
-- DROP CONSTRAINT crypto_wallets_holder_check, crypto_wallets_routine_shape_check,
-- crypto_wallets_routine_amounts_check and
-- crypto_wallet_transactions_routine_action_check; restore
-- crypto_wallet_transactions_initiated_by_check as IN ('agent', 'owner');
-- drop the new columns listed above. Agent wallets are untouched by all of it.
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "holder" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "max_balance" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "daily_loss_stop" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "sweep_threshold" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "top_up_floor" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "top_up_target" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "sweep_address" text;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "sweep_address_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "pending_sweep_address" text;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "pending_sweep_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "top_up_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "loss_day" date;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "loss_day_peak" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "crypto_wallet_transactions" ADD COLUMN IF NOT EXISTS "routine_action" text;--> statement-breakpoint
ALTER TABLE "company_crypto_settings" ADD COLUMN IF NOT EXISTS "trader_agent_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"wallet_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"text" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_crypto_settings_trader_agent_id_agents_id_fk') THEN
    ALTER TABLE "company_crypto_settings" ADD CONSTRAINT "company_crypto_settings_trader_agent_id_agents_id_fk" FOREIGN KEY ("trader_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_alerts_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_alerts" ADD CONSTRAINT "trading_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_alerts_wallet_id_crypto_wallets_id_fk') THEN
    ALTER TABLE "trading_alerts" ADD CONSTRAINT "trading_alerts_wallet_id_crypto_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."crypto_wallets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_alerts_status_check') THEN
    ALTER TABLE "trading_alerts" ADD CONSTRAINT "trading_alerts_status_check" CHECK ("status" IN ('ready', 'delivered', 'failed', 'expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_holder_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_holder_check" CHECK ("holder" IN ('agent', 'trading_routine'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_routine_shape_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_routine_shape_check" CHECK ("holder" = 'agent' OR ("agent_id" IS NULL AND "network" = 'testnet' AND "max_balance" IS NOT NULL AND "daily_loss_stop" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_routine_amounts_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_routine_amounts_check" CHECK (("max_balance" IS NULL OR "max_balance" >= 0) AND ("daily_loss_stop" IS NULL OR "daily_loss_stop" >= 0) AND ("sweep_threshold" IS NULL OR "sweep_threshold" >= 0) AND ("top_up_floor" IS NULL OR "top_up_floor" >= 0) AND ("top_up_target" IS NULL OR "top_up_target" >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_routine_action_check') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_routine_action_check" CHECK ("routine_action" IS NULL OR "routine_action" IN ('sweep', 'trade'));
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "crypto_wallet_transactions" DROP CONSTRAINT IF EXISTS "crypto_wallet_transactions_initiated_by_check";--> statement-breakpoint
ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_initiated_by_check" CHECK ("initiated_by" IN ('agent', 'owner', 'routine'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_alerts_company_status_idx" ON "trading_alerts" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0251 used.
DO $$
DECLARE
  t text := 'trading_alerts';
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
