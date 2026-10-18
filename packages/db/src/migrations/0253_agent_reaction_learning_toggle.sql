-- DUR-4829: per-agent switch for learning from Telegram emoji reactions (DUR-4342).
-- Existing agents keep today's behaviour (learning on). Rollback: ALTER TABLE "agents" DROP COLUMN "reaction_learning_enabled"; (loses only the switch value).
ALTER TABLE "agents" ADD COLUMN "reaction_learning_enabled" boolean DEFAULT true NOT NULL;
