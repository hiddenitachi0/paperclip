CREATE TABLE "agent_work_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_work_summaries_summary_length_check" CHECK (char_length("agent_work_summaries"."summary") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "totp_session_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_totp_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_job_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"jobs_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_studio_direct_creations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text,
	"cost_cents" integer NOT NULL,
	"file_id" uuid,
	"cost_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_connections" DROP CONSTRAINT "data_connections_kind_check";--> statement-breakpoint
ALTER TABLE "data_connections" DROP CONSTRAINT "data_connections_credential_kind_check";--> statement-breakpoint
ALTER TABLE "data_dataset_sources" DROP CONSTRAINT "data_dataset_sources_dataset_check";--> statement-breakpoint
ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "totp_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "totp_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_session_tokens" ADD CONSTRAINT "totp_session_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp_secrets" ADD CONSTRAINT "user_totp_secrets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_job_settings" ADD CONSTRAINT "company_job_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_studio_direct_creations" ADD CONSTRAINT "media_studio_direct_creations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_studio_direct_creations" ADD CONSTRAINT "media_studio_direct_creations_file_id_issue_attachments_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_studio_direct_creations" ADD CONSTRAINT "media_studio_direct_creations_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_work_summaries_company_agent_created_idx" ON "agent_work_summaries" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_work_summaries_run_unique_idx" ON "agent_work_summaries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_totp_session_tokens_user_id" ON "totp_session_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_totp_session_tokens_session_id" ON "totp_session_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_totp_session_tokens_expires_at" ON "totp_session_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_user_recovery_codes_user_id" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_recovery_codes_hash" ON "user_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_user_totp_secrets_user_id" ON "user_totp_secrets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_totp_secrets_verified" ON "user_totp_secrets" USING btree ("verified","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "only_one_active_totp_per_user" ON "user_totp_secrets" USING btree ("user_id") WHERE "user_totp_secrets"."disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "media_studio_direct_creations_company_user_created_idx" ON "media_studio_direct_creations" USING btree ("company_id","created_by_user_id","created_at");--> statement-breakpoint
ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_kind_check" CHECK ("data_connections"."kind" IN ('shopify', 'woocommerce', 'fiken', 'ftp_file', 'ftps_file', 'sftp_file', 'paperless_ngx'));--> statement-breakpoint
ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_credential_kind_check" CHECK (("data_connections"."kind" = 'shopify' AND "data_connections"."credential_kind" IN ('admin_access_token', 'client_credentials')) OR ("data_connections"."kind" = 'woocommerce' AND "data_connections"."credential_kind" = 'consumer_key_secret') OR ("data_connections"."kind" = 'fiken' AND "data_connections"."credential_kind" = 'api_token') OR ("data_connections"."kind" IN ('ftp_file', 'ftps_file') AND "data_connections"."credential_kind" = 'password') OR ("data_connections"."kind" = 'sftp_file' AND "data_connections"."credential_kind" IN ('password', 'private_key')) OR ("data_connections"."kind" = 'paperless_ngx' AND "data_connections"."credential_kind" = 'paperless_api_token'));--> statement-breakpoint
ALTER TABLE "data_dataset_sources" ADD CONSTRAINT "data_dataset_sources_dataset_check" CHECK ("data_dataset_sources"."dataset" IN ('sales', 'finance', 'custom', 'documents'));