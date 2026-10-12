-- DUR-4345: reaction learning. Additive: 2 nullable columns on agent_memories, 3 nullable columns on
-- telegram_message_reactions, and agent_memories.source also accepts 'reaction'. No existing row is touched.
-- Rollback: DELETE FROM agent_memories WHERE source = 'reaction'; then re-add the old CHECK (source IN ('agent','user'))
-- and DROP COLUMN category, terms (agent_memories) and follow_up_asked_at, follow_up_answer, follow_up_answered_at
-- (telegram_message_reactions). Reaction notes are derived data and regenerate from the reaction rows.
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_source_check";--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "terms" jsonb;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD COLUMN "follow_up_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD COLUMN "follow_up_answer" text;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD COLUMN "follow_up_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_check" CHECK ("agent_memories"."source" IN ('agent', 'user', 'reaction'));
