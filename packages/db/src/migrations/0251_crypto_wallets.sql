-- Crypto wallets for agents (approved by Filip, 17 Oct 2026). Design and
-- safety rules: packages/shared/src/crypto-wallets.ts and
-- packages/db/src/schema/crypto_wallets.ts.
--
-- No key material is stored in any table here: crypto_wallets.secret_id
-- points at a 'crypto_wallet_key' secret in the encrypted secrets store.
-- Every company starts on test networks (company_crypto_settings.mainnet_enabled
-- defaults to false, and a company without a row is treated the same).
--
-- Five new company-scoped tables:
--   * company_crypto_settings: real-money switch, company kill switch,
--     the company's own network endpoints.
--   * crypto_wallets: one row per wallet (chain, network, address, agent,
--     limits, kill switch).
--   * crypto_wallet_destinations: the per-wallet allow-list of addresses.
--   * crypto_agent_limits: per-agent dollar limits.
--   * crypto_wallet_transactions: every payment/order attempt with tx hash
--     and status.
--
-- One change to an existing table, trading_ledger_entries (the trading
-- agent's append-only ledger), so wallet events land in the same ledger:
--   * strategy_id becomes nullable (wallet events have no strategy);
--   * new nullable columns wallet_id, wallet_transaction_id, tx_hash,
--     tx_status;
--   * the event_type check gains the wallet_* event types;
--   * a new check requires strategy_id or wallet_id on every row (every
--     existing row has a strategy_id, so it holds for existing data).
-- No existing row is written or changed.
--
-- Every statement is guarded so a re-run is a no-op (the event_type check
-- is dropped and re-added with the wider list, which is also safe to repeat).
--
-- Rollback: DELETE FROM "trading_ledger_entries" WHERE "strategy_id" IS NULL;
-- then drop the owner check, restore the old event_type check, drop the four
-- new ledger columns, SET NOT NULL on strategy_id, and DROP TABLE
-- "crypto_wallet_transactions", "crypto_wallet_destinations",
-- "crypto_agent_limits", "crypto_wallets", "company_crypto_settings" (that
-- order). The crypto_wallet_key secrets stay in company_secrets; delete them
-- only after any funds have been moved out.
CREATE TABLE IF NOT EXISTS "company_crypto_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"mainnet_enabled" boolean DEFAULT false NOT NULL,
	"mainnet_enabled_at" timestamp with time zone,
	"mainnet_enabled_by_user_id" text,
	"all_wallets_frozen" boolean DEFAULT false NOT NULL,
	"frozen_reason" text,
	"rpc_endpoints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crypto_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"chain" text NOT NULL,
	"network" text DEFAULT 'testnet' NOT NULL,
	"address" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"key_origin" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"frozen_reason" text,
	"frozen_at" timestamp with time zone,
	"per_transaction_limit" numeric(78, 0) NOT NULL,
	"daily_limit" numeric(78, 0) NOT NULL,
	"total_limit" numeric(78, 0) NOT NULL,
	"approval_above" numeric(78, 0),
	"max_leverage" integer DEFAULT 1 NOT NULL,
	"last_balance" numeric(78, 0),
	"last_balance_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crypto_wallet_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crypto_agent_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"per_transaction_usd" double precision NOT NULL,
	"daily_usd" double precision NOT NULL,
	"total_usd" double precision NOT NULL,
	"approval_above_usd" double precision,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crypto_wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"agent_id" uuid,
	"initiated_by" text NOT NULL,
	"initiated_by_user_id" text,
	"kind" text NOT NULL,
	"chain" text NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"destination" text,
	"amount" numeric(78, 0) NOT NULL,
	"amount_usd" double precision,
	"counts_toward_limits" boolean DEFAULT true NOT NULL,
	"fee_upper_bound" numeric(78, 0),
	"order_detail" jsonb,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"block_reason" text,
	"approval_id" uuid,
	"approval_expires_at" timestamp with time zone,
	"tx_hash" text,
	"error" text,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_crypto_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_crypto_settings" ADD CONSTRAINT "company_crypto_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_company_id_companies_id_fk') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_agent_id_agents_id_fk') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_chain_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_chain_check" CHECK ("chain" IN ('bitcoin', 'ethereum', 'solana', 'hyperliquid'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_network_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_network_check" CHECK ("network" IN ('testnet', 'mainnet'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_status_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_status_check" CHECK ("status" IN ('active', 'frozen', 'archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_key_origin_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_key_origin_check" CHECK ("key_origin" IN ('generated', 'imported'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_max_leverage_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_max_leverage_check" CHECK ("max_leverage" >= 1 AND "max_leverage" <= 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_limits_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_limits_check" CHECK ("per_transaction_limit" >= 0 AND "daily_limit" >= 0 AND "total_limit" >= 0 AND ("approval_above" IS NULL OR "approval_above" >= 0));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_destinations_company_id_companies_id_fk') THEN
    ALTER TABLE "crypto_wallet_destinations" ADD CONSTRAINT "crypto_wallet_destinations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_destinations_wallet_id_crypto_wallets_id_fk') THEN
    ALTER TABLE "crypto_wallet_destinations" ADD CONSTRAINT "crypto_wallet_destinations_wallet_id_crypto_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."crypto_wallets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_agent_limits_company_id_companies_id_fk') THEN
    ALTER TABLE "crypto_agent_limits" ADD CONSTRAINT "crypto_agent_limits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_agent_limits_agent_id_agents_id_fk') THEN
    ALTER TABLE "crypto_agent_limits" ADD CONSTRAINT "crypto_agent_limits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_agent_limits_positive_check') THEN
    ALTER TABLE "crypto_agent_limits" ADD CONSTRAINT "crypto_agent_limits_positive_check" CHECK ("per_transaction_usd" > 0 AND "daily_usd" > 0 AND "total_usd" > 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_company_id_companies_id_fk') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_wallet_id_crypto_wallets_id_fk') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_wallet_id_crypto_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."crypto_wallets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_agent_id_agents_id_fk') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_initiated_by_check') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_initiated_by_check" CHECK ("initiated_by" IN ('agent', 'owner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_kind_check') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_kind_check" CHECK ("kind" IN ('send', 'order'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_status_check') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_status_check" CHECK ("status" IN ('blocked', 'pending_approval', 'approved', 'submitted', 'confirmed', 'failed', 'rejected', 'expired_approval'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallet_transactions_amount_check') THEN
    ALTER TABLE "crypto_wallet_transactions" ADD CONSTRAINT "crypto_wallet_transactions_amount_check" CHECK ("amount" >= 0);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crypto_wallets_company_agent_idx" ON "crypto_wallets" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crypto_wallets_company_chain_network_address_uq" ON "crypto_wallets" USING btree ("company_id","chain","network","address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crypto_wallet_destinations_wallet_address_uq" ON "crypto_wallet_destinations" USING btree ("wallet_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crypto_agent_limits_agent_uq" ON "crypto_agent_limits" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crypto_wallet_transactions_wallet_idx" ON "crypto_wallet_transactions" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crypto_wallet_transactions_agent_idx" ON "crypto_wallet_transactions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crypto_wallet_transactions_status_idx" ON "crypto_wallet_transactions" USING btree ("status");--> statement-breakpoint
-- The trading ledger learns about wallets.
ALTER TABLE "trading_ledger_entries" ALTER COLUMN "strategy_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD COLUMN IF NOT EXISTS "wallet_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD COLUMN IF NOT EXISTS "wallet_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD COLUMN IF NOT EXISTS "tx_hash" text;--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD COLUMN IF NOT EXISTS "tx_status" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_wallet_id_crypto_wallets_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_wallet_id_crypto_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."crypto_wallets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_wallet_transaction_id_crypto_wallet_transactions_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_wallet_transaction_id_crypto_wallet_transactions_id_fk" FOREIGN KEY ("wallet_transaction_id") REFERENCES "public"."crypto_wallet_transactions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_owner_check') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_owner_check" CHECK ("strategy_id" IS NOT NULL OR "wallet_id" IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" DROP CONSTRAINT IF EXISTS "trading_ledger_entries_event_type_check";--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_event_type_check" CHECK ("event_type" IN ('signal', 'order_filled', 'order_rejected', 'risk_block', 'circuit_breaker', 'kill_switch', 'reconciliation', 'wallet_created', 'wallet_tx_requested', 'wallet_tx_blocked', 'wallet_tx_approval_requested', 'wallet_tx_submitted', 'wallet_tx_confirmed', 'wallet_tx_failed', 'wallet_tx_rejected', 'wallet_kill_switch', 'wallet_reconciliation', 'wallet_settings_changed'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_ledger_entries_wallet_idx" ON "trading_ledger_entries" USING btree ("wallet_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0197_trading_agent
-- used. Safe where the 0149/0164 roles are absent. Company isolation does NOT
-- rest on this: every query in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['company_crypto_settings', 'crypto_wallets', 'crypto_wallet_destinations', 'crypto_agent_limits', 'crypto_wallet_transactions'] LOOP
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
    FOREACH t IN ARRAY ARRAY['company_crypto_settings', 'crypto_wallets', 'crypto_wallet_destinations', 'crypto_agent_limits', 'crypto_wallet_transactions'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
