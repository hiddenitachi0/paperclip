CREATE TABLE "escalation_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"granted_model" text,
	"granted_effort" text,
	"reason" text NOT NULL,
	"max_spend_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expired_reason" text,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalation_grants" ADD CONSTRAINT "escalation_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "escalation_grants" ADD CONSTRAINT "escalation_grants_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "escalation_grants" ADD CONSTRAINT "escalation_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "escalation_grants" ADD CONSTRAINT "escalation_grants_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "escalation_grants_company_issue_status_idx" ON "escalation_grants" USING btree ("company_id","issue_id","status");
--> statement-breakpoint
CREATE INDEX "escalation_grants_agent_status_idx" ON "escalation_grants" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX "escalation_grants_approval_idx" ON "escalation_grants" USING btree ("approval_id");
