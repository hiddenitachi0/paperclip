-- DUR-4153/DUR-4171: the trading agent, paper-trading mode only. "Code
-- trades, the AI explains" -- no LLM call sits on the order path, so unlike
-- watchers (0181) or the mail secretary (0195) there is no agent_id/persona
-- column anywhere in this migration. mode only ever accepts 'paper' right
-- now; see packages/shared/src/trading.ts and packages/db/src/schema/trading.ts
-- for the full design rationale.
--
-- Five new tables, all company-scoped:
--   * trading_strategies: one row per configured strategy (rule + risk
--     config as JSON, a watchers-style claim-lock due/lease pair, and its
--     live paper cash/position balances). Created status='paused'; nothing
--     in the service layer auto-resumes a strategy.
--   * trading_orders: one row per order attempt (filled, rejected by the
--     risk gate, or awaiting/missed a trade-approval card).
--   * trading_fifo_lots: open buy lots, consumed oldest-first on a sell --
--     the FIFO NOK cost basis the Norwegian tax ledger needs.
--   * trading_ledger_entries: append-only decision/event log (signal, fill,
--     risk block, circuit breaker, kill switch, reconciliation).
--   * trading_daily_stats: one row per strategy per UTC day, for the
--     dashboard without re-summing the full ledger on every request.
--
-- Strictly additive: no row written, no existing row touched. Every
-- statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "trading_daily_stats", "trading_ledger_entries",
-- "trading_fifo_lots", "trading_orders", then "trading_strategies" (children
-- before the parent they reference). Safe -- nothing outside this migration
-- references any of the five tables, so a rollback loses only this
-- feature's own strategies, orders and ledger history. Undo the 0164
-- table-name additions in the same change if rolling back before a fresh
-- database is ever created from this state.
CREATE TABLE IF NOT EXISTS "trading_strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset" text NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"pause_reason" text,
	"check_every_minutes" integer DEFAULT 15 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_lease_until" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_tick_at" timestamp with time zone,
	"last_tick_error" text,
	"rule_config" jsonb NOT NULL,
	"risk_config" jsonb NOT NULL,
	"starting_cash_nok" integer NOT NULL,
	"starting_quote_nok" double precision,
	"cash_nok" double precision NOT NULL,
	"position_quantity" double precision DEFAULT 0 NOT NULL,
	"position_cost_nok" double precision DEFAULT 0 NOT NULL,
	"peak_equity_nok" double precision NOT NULL,
	"orders_today_date" text,
	"orders_today" integer DEFAULT 0 NOT NULL,
	"realized_pnl_today_date" text,
	"realized_pnl_today_nok" double precision DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"side" text NOT NULL,
	"status" text NOT NULL,
	"rule_version" text NOT NULL,
	"signal_price_nok" double precision NOT NULL,
	"requested_quantity" double precision NOT NULL,
	"filled_quantity" double precision,
	"filled_price_nok" double precision,
	"fee_nok" double precision,
	"realized_pnl_nok" double precision,
	"rejection_reason" text,
	"approval_id" uuid,
	"approval_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_fifo_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"source_order_id" uuid NOT NULL,
	"quantity_remaining" double precision NOT NULL,
	"cost_nok_per_unit" double precision NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"order_id" uuid,
	"event_type" text NOT NULL,
	"nok_value" double precision,
	"fee_nok" double precision,
	"fifo_cost_nok" double precision,
	"realized_pnl_nok" double precision,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_daily_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"stat_date" text NOT NULL,
	"realized_pnl_nok" double precision DEFAULT 0 NOT NULL,
	"fees_nok" double precision DEFAULT 0 NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"equity_nok" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_mode_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_mode_check" CHECK ("mode" IN ('paper'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_status_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_status_check" CHECK ("status" IN ('paused', 'running', 'halted_risk'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_pause_reason_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_pause_reason_check" CHECK ("pause_reason" IS NULL OR "pause_reason" IN ('manual', 'restart', 'daily_loss_limit', 'drawdown_limit', 'circuit_breaker', 'reconciliation_mismatch'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_asset_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_asset_check" CHECK ("asset" IN ('BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'TRX', 'AVAX', 'DOT', 'LINK', 'LTC'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_check_every_minutes_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_check_every_minutes_check" CHECK ("check_every_minutes" >= 5 AND "check_every_minutes" <= 240);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_starting_cash_nok_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_starting_cash_nok_check" CHECK ("starting_cash_nok" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_position_quantity_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_position_quantity_check" CHECK ("position_quantity" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_side_check') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_side_check" CHECK ("side" IN ('buy', 'sell'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_status_check') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_status_check" CHECK ("status" IN ('filled', 'rejected', 'pending_approval', 'expired_approval'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_orders_requested_quantity_check') THEN
    ALTER TABLE "trading_orders" ADD CONSTRAINT "trading_orders_requested_quantity_check" CHECK ("requested_quantity" > 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_fifo_lots_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_fifo_lots" ADD CONSTRAINT "trading_fifo_lots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_fifo_lots_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_fifo_lots" ADD CONSTRAINT "trading_fifo_lots_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_fifo_lots_source_order_id_trading_orders_id_fk') THEN
    ALTER TABLE "trading_fifo_lots" ADD CONSTRAINT "trading_fifo_lots_source_order_id_trading_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."trading_orders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_fifo_lots_quantity_remaining_check') THEN
    ALTER TABLE "trading_fifo_lots" ADD CONSTRAINT "trading_fifo_lots_quantity_remaining_check" CHECK ("quantity_remaining" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_order_id_trading_orders_id_fk') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_order_id_trading_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."trading_orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_ledger_entries_event_type_check') THEN
    ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_event_type_check" CHECK ("event_type" IN ('signal', 'order_filled', 'order_rejected', 'risk_block', 'circuit_breaker', 'kill_switch', 'reconciliation'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_daily_stats_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_daily_stats" ADD CONSTRAINT "trading_daily_stats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_daily_stats_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_daily_stats" ADD CONSTRAINT "trading_daily_stats_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_strategies_company_idx" ON "trading_strategies" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_strategies_due_idx" ON "trading_strategies" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_orders_strategy_idx" ON "trading_orders" USING btree ("strategy_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_orders_pending_approval_idx" ON "trading_orders" USING btree ("status","approval_expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_fifo_lots_fifo_queue_idx" ON "trading_fifo_lots" USING btree ("strategy_id","acquired_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_ledger_entries_strategy_idx" ON "trading_ledger_entries" USING btree ("strategy_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_daily_stats_strategy_date_uq" ON "trading_daily_stats" USING btree ("strategy_id","stat_date");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0181_watchers/0195_mail_secretary
-- used, so these tables stay in line with the rest of the tenant tables on a
-- database where those roles exist. Safe where the 0149/0164 roles are
-- absent. Company isolation does NOT rest on this: every query in the code
-- filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['trading_strategies', 'trading_orders', 'trading_fifo_lots', 'trading_ledger_entries', 'trading_daily_stats'] LOOP
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
    FOREACH t IN ARRAY ARRAY['trading_strategies', 'trading_orders', 'trading_fifo_lots', 'trading_ledger_entries', 'trading_daily_stats'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
