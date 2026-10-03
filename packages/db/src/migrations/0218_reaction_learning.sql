-- DUR-4345: reaction learning. Widens agent_memories.source to allow 'reaction'
-- (notes written by the reaction summariser) and adds the one-time follow-up
-- bookkeeping columns to telegram_message_reactions (both nullable, so existing rows are untouched).
-- Rollback: DELETE FROM "agent_memories" WHERE "source" = 'reaction';
--   ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_source_check";
--   ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_check" CHECK ("source" IN ('agent', 'user'));
--   ALTER TABLE "telegram_message_reactions" DROP COLUMN "follow_up_asked_at", DROP COLUMN "follow_up_answer";
ALTER TABLE "agent_memories" DROP CONSTRAINT IF EXISTS "agent_memories_source_check";
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_check" CHECK ("source" IN ('agent', 'user', 'reaction'));
--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD COLUMN "follow_up_asked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD COLUMN "follow_up_answer" text;
