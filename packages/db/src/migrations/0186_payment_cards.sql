-- DUR-4040 (Maja browser step 5): the payment_cards table -- metadata only
-- for a card an agent may spend from via the browser worker. The card's
-- actual PAN/CVC never live here, only in the encrypted
-- `payment_card_single_use` secret (added by DUR-4019) that `secret_id`
-- points at; paymentCardService's resolveForFill is the only code path that
-- ever resolves that secret's value.
--
-- After this migration:
--   * companies.payments_enabled (boolean, not null, default false) -- one of
--     the three off-switches this feature ships behind, alongside an agent's
--     own browser_access level (0184) and the PAPERCLIP_BROWSER_DISABLED
--     instance env var. Every existing company gets false, i.e. no visible
--     behavior change.
--   * payment_cards -- one row per card. status is a closed lifecycle
--     ('available' | 'reserved' | 'used' | 'used_unverified' | 'expired' |
--     'disabled', CHECK-enforced since -- unlike a secret's free-text kind --
--     nothing outside this table's own service ever needs a new value
--     storable without a migration). allowed_agent_ids defaults to an empty
--     array, i.e. no agent may have this card resolved for it until a board
--     user says otherwise.
--
-- Strictly additive: one new nullable-default column, one new table, no row
-- written to any existing table. Every statement is guarded so a re-run is a
-- no-op. Ships with zero rows (nothing creates one yet -- the create path is
-- a `paymentCardService` method for a later UI child to call) and zero
-- production behavior change until an operator turns payments_enabled on for
-- a company, sets an agent's browser_access to 'book_and_buy', and adds a
-- card.
--
-- Rollback: DROP TABLE "payment_cards" (no other table references it -- it
-- is only ever referenced FROM, via secret_id -- so dropping it loses only
-- the cards themselves, not company_secrets or companies) and DROP COLUMN
-- "payments_enabled" FROM "companies". Safe either way: nothing outside this
-- feature reads either.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "payments_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"label" text NOT NULL,
	"brand" text,
	"last4" text NOT NULL,
	"currency" text NOT NULL,
	"loaded_amount_cents" integer DEFAULT 0 NOT NULL,
	"remaining_amount_cents" integer DEFAULT 0 NOT NULL,
	"single_use" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"expires_on" date,
	"allowed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reserved_for_clearance_id" text,
	"reserved_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"used_by_purchase_id" text,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_cards_company_id_companies_id_fk') THEN
    ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_cards_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_cards_status_check') THEN
    ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_status_check" CHECK ("status" IN ('available', 'reserved', 'used', 'used_unverified', 'expired', 'disabled'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_cards_company_idx" ON "payment_cards" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_cards_company_status_idx" ON "payment_cards" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_cards_secret_idx" ON "payment_cards" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_cards_expires_on_idx" ON "payment_cards" USING btree ("expires_on");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0181/0185 used, so
-- this table stays in line with the rest of the tenant tables on a database
-- where those roles exist. Company isolation does NOT rest on this: every
-- query in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_cards'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format('CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))', t);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END IF;
  END LOOP;
END $$;
