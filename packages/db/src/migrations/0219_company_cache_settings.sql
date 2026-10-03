-- DUR-4471: new table, lazy rows (absent = defaults). Rollback: DROP TABLE company_cache_settings; nothing references it.
CREATE TABLE "company_cache_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scheduling_enabled" boolean DEFAULT true NOT NULL,
	"handoff_enabled" boolean DEFAULT true NOT NULL,
	"handoff_token_threshold" integer DEFAULT 150000 NOT NULL,
	"cache_lifetime_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_cache_settings" ADD CONSTRAINT "company_cache_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;