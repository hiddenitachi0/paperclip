-- DUR-4046 (Maja browser step 6: purchases). Purely additive, no row
-- rewritten, no existing column touched.
--
-- After this migration:
--   * company_payment_settings gets a second company-wide switch,
--     purchases_enabled, alongside the existing booking_enabled -- a
--     company may want the (always-Filip-approved) booking flow on without
--     ever letting an agent spend from a card, or vice versa, so the two
--     are independent, both defaulting to false. No new row is written by
--     this migration; get()/setPurchasesEnabled() in
--     server/src/services/company-payment-settings.ts create a row lazily
--     the first time a board owner/admin touches either switch, exactly
--     like booking_enabled already does.
--   * payment_notices' kind check constraint gains 'purchase_receipt'
--     (alongside the existing 'booking_receipt' and 'hand_over') --
--     step 6's purchase-flow receipt notice. The constraint is dropped and
--     re-added rather than altered in place (Postgres has no
--     ALTER CONSTRAINT for a CHECK's expression); both statements are
--     guarded so a re-run, or a database that already has the new
--     constraint from a previous partial run, is a no-op.
--
-- Rollback: DROP COLUMN "purchases_enabled" from company_payment_settings
-- (loses only the switch's current position, which is "off" for every
-- company that never touched it -- the same safe default this ships with);
-- drop the new check constraint and re-add the old one restricted to
-- ('booking_receipt', 'hand_over') -- safe only if no 'purchase_receipt' row
-- exists yet, true for any instance that has not turned purchases on.
--
-- No table is discovered by column shape anywhere in this file; the only
-- tables named are ones this codebase owns and declares in
-- packages/db/src/schema.
ALTER TABLE "company_payment_settings" ADD COLUMN IF NOT EXISTS "purchases_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_kind_check') THEN
    ALTER TABLE "payment_notices" DROP CONSTRAINT "payment_notices_kind_check";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_kind_check') THEN
    ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_kind_check" CHECK ("kind" IN ('booking_receipt', 'purchase_receipt', 'hand_over'));
  END IF;
END $$;
