ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "linked_approval_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_linked_approval_id_approvals_id_fk" FOREIGN KEY ("linked_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_linked_approval_idx" ON "issue_thread_interactions" USING btree ("linked_approval_id");
