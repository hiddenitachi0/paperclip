CREATE TABLE "brag_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_repo_url" text,
	"source_url" text,
	"tone" text,
	"format" text DEFAULT 'landscape' NOT NULL,
	"length_seconds" integer DEFAULT 20 NOT NULL,
	"music" boolean DEFAULT false NOT NULL,
	"note" text,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"actual_cost_cents" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brag_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"scene_order" integer NOT NULL,
	"description" text,
	"still_ref" text,
	"approval_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brag_jobs" ADD CONSTRAINT "brag_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brag_jobs" ADD CONSTRAINT "brag_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brag_jobs" ADD CONSTRAINT "brag_jobs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brag_scenes" ADD CONSTRAINT "brag_scenes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brag_scenes" ADD CONSTRAINT "brag_scenes_job_id_brag_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."brag_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brag_jobs_company_project_idx" ON "brag_jobs" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "brag_jobs_company_status_idx" ON "brag_jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "brag_scenes_job_order_idx" ON "brag_scenes" USING btree ("job_id","scene_order");--> statement-breakpoint
CREATE INDEX "brag_scenes_company_idx" ON "brag_scenes" USING btree ("company_id");