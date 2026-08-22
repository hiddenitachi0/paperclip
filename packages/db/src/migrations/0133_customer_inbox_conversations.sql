ALTER TABLE "customer_inbox_deliveries" ADD COLUMN "conversation_id" text;
--> statement-breakpoint
CREATE TABLE "customer_inbox_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_trigger_id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"linked_issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_inbox_conversations" ADD CONSTRAINT "customer_inbox_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_inbox_conversations" ADD CONSTRAINT "customer_inbox_conversations_routine_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("routine_trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_inbox_conversations" ADD CONSTRAINT "customer_inbox_conversations_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_inbox_conversations_trigger_conversation_uq" ON "customer_inbox_conversations" USING btree ("routine_trigger_id","conversation_id");
--> statement-breakpoint
CREATE INDEX "customer_inbox_conversations_linked_issue_idx" ON "customer_inbox_conversations" USING btree ("linked_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issues_active_customer_inbox_unreadable_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'customer_inbox_unreadable' and "issues"."origin_id" is not null and "issues"."hidden_at" is null and "issues"."status" not in ('done', 'cancelled');
