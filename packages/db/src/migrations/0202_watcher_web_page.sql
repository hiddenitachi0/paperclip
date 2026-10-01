-- DUR-4168: a web-page watcher tracks a URL, not a market symbol. Adds the
-- "web_page" source and the last-seen snapshot table a web-page rule needs
-- to compare against (price/stock/new-products/text-change have no numeric
-- history to window over the way watcher_price_points gives the other
-- sources -- only "what did we see last time").
--
-- Hand written rather than `drizzle-kit generate`'d, for the same no-TTY
-- reason 0200's header documents.
ALTER TABLE "watchers" DROP CONSTRAINT "watchers_source_check";--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_source_check" CHECK ("watchers"."source" IN ('crypto', 'us_stock', 'oslo_stock', 'web_page'));--> statement-breakpoint
CREATE TABLE "watcher_web_page_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"watcher_id" uuid NOT NULL,
	"last_price" double precision,
	"last_in_stock" boolean,
	"last_item_keys" jsonb,
	"last_content_hash" text,
	"last_snippet" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watcher_web_page_snapshots_watcher_id_unique" UNIQUE("watcher_id")
);
--> statement-breakpoint
ALTER TABLE "watcher_web_page_snapshots" ADD CONSTRAINT "watcher_web_page_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_web_page_snapshots" ADD CONSTRAINT "watcher_web_page_snapshots_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watcher_web_page_snapshots_company_idx" ON "watcher_web_page_snapshots" USING btree ("company_id");--> statement-breakpoint
-- Row-level security and grants for the one new table, the same guarded
-- shape 0196/0200 used -- see those migrations' comments for the
-- convention. watcher_web_page_snapshots is also added to migration 0164's
-- paperclip_tables/company_scope_tables arrays (an explicit, documented
-- exception to "never edit an applied migration", same as every other table
-- added after 0164 -- see packages/db/src/rls-login-roles.test.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "watcher_web_page_snapshots" TO paperclip_app_scoped;
    ALTER TABLE "watcher_web_page_snapshots" ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'watcher_web_page_snapshots' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON "watcher_web_page_snapshots" USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "watcher_web_page_snapshots" TO paperclip_app_bypass_login;
  END IF;
END $$;
