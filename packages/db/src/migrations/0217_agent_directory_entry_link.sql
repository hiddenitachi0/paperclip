-- DUR-4418: points a quick agent at the model-directory entry its main model was saved as.
-- Additive, nullable: every existing agent keeps its lane_a_* columns as the live setup.
-- Rollback: ALTER TABLE "agents" DROP COLUMN "lane_a_directory_entry_id" (the link is
-- re-creatable by the import-agent-settings route; no other data depends on it).
ALTER TABLE "agents" ADD COLUMN "lane_a_directory_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_lane_a_directory_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("lane_a_directory_entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE set null ON UPDATE no action;