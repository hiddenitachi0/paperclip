-- DUR-206: Filip's answer to DUR-64's Step-0 question was keep_files —
-- deleting a task must not destroy the attachments/documents it produced.
-- Detach instead of cascade-deleting: issue_id becomes nullable and the FK
-- switches from ON DELETE CASCADE to ON DELETE SET NULL, so an orphaned row
-- survives its owning task's deletion and shows up under a "No task" group
-- on the Files page (see server/src/services/company-artifacts.ts). Existing
-- rows are untouched by this migration -- only future deletes behave
-- differently. Rollback: re-add NOT NULL (only safe if no orphaned rows
-- exist yet) and switch the FK back to ON DELETE CASCADE.

ALTER TABLE "issue_attachments" DROP CONSTRAINT "issue_attachments_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_attachments" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "issue_documents" DROP CONSTRAINT "issue_documents_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_documents" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
