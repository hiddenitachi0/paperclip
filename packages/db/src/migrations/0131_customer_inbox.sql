ALTER TABLE "routine_triggers" ADD COLUMN "customer_inbox_channel" text;
--> statement-breakpoint
CREATE TABLE "customer_inbox_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"routine_trigger_id" uuid,
	"external_message_id" text,
	"channel" text,
	"from_address" text,
	"from_name" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"outcome_detail" text,
	"linked_routine_run_id" uuid,
	"linked_issue_id" uuid,
	"payload_digest" text,
	"raw_payload_excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_inbox_deliveries" ADD CONSTRAINT "customer_inbox_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_inbox_deliveries" ADD CONSTRAINT "customer_inbox_deliveries_routine_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("routine_trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_inbox_deliveries" ADD CONSTRAINT "customer_inbox_deliveries_linked_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("linked_routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_inbox_deliveries" ADD CONSTRAINT "customer_inbox_deliveries_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "customer_inbox_deliveries_company_created_idx" ON "customer_inbox_deliveries" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "customer_inbox_deliveries_trigger_created_idx" ON "customer_inbox_deliveries" USING btree ("routine_trigger_id","created_at");
--> statement-breakpoint
CREATE INDEX "customer_inbox_deliveries_linked_run_idx" ON "customer_inbox_deliveries" USING btree ("linked_routine_run_id");
--> statement-breakpoint
CREATE INDEX "customer_inbox_deliveries_linked_issue_idx" ON "customer_inbox_deliveries" USING btree ("linked_issue_id");
--> statement-breakpoint
CREATE INDEX "customer_inbox_deliveries_raw_excerpt_sweep_idx" ON "customer_inbox_deliveries" USING btree ("received_at") WHERE "customer_inbox_deliveries"."raw_payload_excerpt" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_inbox_deliveries_accepted_message_uq" ON "customer_inbox_deliveries" USING btree ("company_id","routine_trigger_id","external_message_id") WHERE "customer_inbox_deliveries"."outcome" = 'accepted' and "customer_inbox_deliveries"."external_message_id" is not null;
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
