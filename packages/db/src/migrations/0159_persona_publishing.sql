ALTER TABLE "personas" ADD COLUMN "publishing_paused" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "persona_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"account_label" text NOT NULL,
	"external_account_id" text NOT NULL,
	"connection_status" text DEFAULT 'pending' NOT NULL,
	"ai_disclosure_enabled" boolean NOT NULL,
	"autonomy_mode" text DEFAULT 'requires_approval' NOT NULL,
	"daily_post_cap" integer NOT NULL,
	"warmup_posts_required" integer NOT NULL,
	"published_post_count" integer DEFAULT 0 NOT NULL,
	"publishing_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"persona_account_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"caption" text NOT NULL,
	"disclosure_text" text,
	"media_asset_id" uuid,
	"approval_id" uuid,
	"external_post_id" text,
	"publish_attempted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_account_publish_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"persona_account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_publishing_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"publishing_paused" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_accounts" ADD CONSTRAINT "persona_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_accounts" ADD CONSTRAINT "persona_accounts_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_posts" ADD CONSTRAINT "persona_posts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_posts" ADD CONSTRAINT "persona_posts_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_posts" ADD CONSTRAINT "persona_posts_persona_account_id_persona_accounts_id_fk" FOREIGN KEY ("persona_account_id") REFERENCES "public"."persona_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_posts" ADD CONSTRAINT "persona_posts_media_asset_id_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_posts" ADD CONSTRAINT "persona_posts_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_account_publish_counters" ADD CONSTRAINT "persona_account_publish_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_account_publish_counters" ADD CONSTRAINT "persona_account_publish_counters_persona_account_id_persona_accounts_id_fk" FOREIGN KEY ("persona_account_id") REFERENCES "public"."persona_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "persona_publishing_company_settings" ADD CONSTRAINT "persona_publishing_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "persona_accounts_company_idx" ON "persona_accounts" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "persona_accounts_persona_idx" ON "persona_accounts" USING btree ("persona_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "persona_accounts_persona_platform_account_uq" ON "persona_accounts" USING btree ("persona_id","platform","external_account_id");
--> statement-breakpoint
CREATE INDEX "persona_posts_company_idx" ON "persona_posts" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "persona_posts_account_status_idx" ON "persona_posts" USING btree ("persona_account_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "persona_account_publish_counters_account_day_uq" ON "persona_account_publish_counters" USING btree ("persona_account_id","day");
--> statement-breakpoint
CREATE UNIQUE INDEX "persona_publishing_company_settings_company_uq" ON "persona_publishing_company_settings" USING btree ("company_id");
