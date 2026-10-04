CREATE TABLE "issue_overlaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_a_id" uuid NOT NULL,
	"issue_b_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail_key" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"warned_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_overlaps" ADD CONSTRAINT "issue_overlaps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_overlaps" ADD CONSTRAINT "issue_overlaps_issue_a_id_issues_id_fk" FOREIGN KEY ("issue_a_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_overlaps" ADD CONSTRAINT "issue_overlaps_issue_b_id_issues_id_fk" FOREIGN KEY ("issue_b_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_overlaps_pair_kind_detail_uq" ON "issue_overlaps" USING btree ("company_id","issue_a_id","issue_b_id","kind","detail_key");--> statement-breakpoint
CREATE INDEX "issue_overlaps_company_status_idx" ON "issue_overlaps" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "issue_overlaps_issue_a_idx" ON "issue_overlaps" USING btree ("issue_a_id");--> statement-breakpoint
CREATE INDEX "issue_overlaps_issue_b_idx" ON "issue_overlaps" USING btree ("issue_b_id");
