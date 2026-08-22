ALTER TABLE "agents" ADD COLUMN "instructions_reviewed_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE "agent_instructions_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"approval_id" uuid,
	"proposed_by_agent_id" uuid,
	"approved_by_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"relative_path" text NOT NULL,
	"before_content" text NOT NULL,
	"after_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_instructions_revisions_company_agent_created_idx" ON "agent_instructions_revisions" USING btree ("company_id","agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_instructions_revisions_approval_idx" ON "agent_instructions_revisions" USING btree ("approval_id");
