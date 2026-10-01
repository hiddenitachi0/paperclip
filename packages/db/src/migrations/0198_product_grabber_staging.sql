-- DUR-4187 (product grabber backend, child of DUR-4169/DUR-4151): the
-- staging side of the product grabber feature. Fetches product data +
-- images from a vendor site into a staging list a person approves before
-- anything is used -- this migration adds only the staging surface, no
-- storefront write path.
--
-- After this migration:
--   * company_product_grabber_settings -- one row per company, same
--     lazy-row-on-first-write shape as company_payment_settings (0186):
--     a company that never turns this on never gets a row, and absence
--     reads as "off" (server/src/services/product-grabber/settings.ts).
--     Ships with zero rows, i.e. no behavior change for any existing
--     company.
--   * product_grabber_staged_items -- one row per grabbed product.
--     raw_fields keeps the template's output as-extracted (not a
--     normalized projection) so a reviewer sees exactly what the
--     extractor parsed. status is a closed lifecycle
--     ('pending' | 'approved' | 'rejected'), CHECK-enforced. Nothing
--     writes a row here yet except the extractor service this PR adds,
--     and the feature is off by default per the settings table above.
--
-- Rollback: DROP TABLE "product_grabber_staged_items" and DROP TABLE
-- "company_product_grabber_settings" (neither is referenced FROM any other
-- table, only references TO companies, so dropping both loses only this
-- feature's own data).
CREATE TABLE IF NOT EXISTS "company_product_grabber_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_grabber_staged_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"source_url" text NOT NULL,
	"raw_fields" jsonb NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_product_grabber_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_product_grabber_settings" ADD CONSTRAINT "company_product_grabber_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_grabber_staged_items_company_id_companies_id_fk') THEN
    ALTER TABLE "product_grabber_staged_items" ADD CONSTRAINT "product_grabber_staged_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_grabber_staged_items_status_check') THEN
    ALTER TABLE "product_grabber_staged_items" ADD CONSTRAINT "product_grabber_staged_items_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_grabber_staged_items_company_status_idx" ON "product_grabber_staged_items" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_grabber_staged_items_company_source_url_idx" ON "product_grabber_staged_items" USING btree ("company_id","source_url");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape prior tenant tables
-- (e.g. 0186/0188) use, so this table stays in line on a database where
-- those roles exist. Company isolation does NOT rest on this: every query
-- in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_product_grabber_settings', 'product_grabber_staged_items'] LOOP
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
