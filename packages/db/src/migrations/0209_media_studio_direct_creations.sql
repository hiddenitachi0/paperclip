-- DUR-4329: Media Studio Create tab direct generation (board user, not an
-- agent run). "media_studio_direct_creations" is the minimal per-action
-- record the ticket calls for alongside cost_events (which has no kind or
-- fileId column) -- see packages/db/src/schema/media_studio_direct_creations.ts
-- for the full rationale.
--
-- cost_events.agent_id becomes nullable and gains created_by_user_id: a
-- board-user-triggered cost has no agent at all. Every existing row already
-- has a non-null agent_id, so widening the column to nullable touches no
-- existing data; created_by_user_id is added NULL-able with no default, so
-- every existing row gets NULL (correct: it was agent-driven).
--
-- Additive only. Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "media_studio_direct_creations" (no other table
-- references it); re-adding NOT NULL on cost_events.agent_id is NOT safely
-- reversible once any row has agent_id NULL (a board-user direct-creation
-- cost row) -- back those rows out or reassign them to a system agent first
-- if a rollback of that column is ever needed. created_by_user_id can be
-- dropped freely (it is informational only).
ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_studio_direct_creations" (
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
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_studio_direct_creations" ADD CONSTRAINT "media_studio_direct_creations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_studio_direct_creations" ADD CONSTRAINT "media_studio_direct_creations_file_id_issue_attachments_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_studio_direct_creations" ADD CONSTRAINT "media_studio_direct_creations_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_studio_direct_creations_company_user_created_idx" ON "media_studio_direct_creations" USING btree ("company_id","created_by_user_id","created_at");
