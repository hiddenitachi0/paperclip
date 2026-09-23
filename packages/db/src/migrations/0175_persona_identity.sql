-- DUR-4000 (steps 1 and 2): a persona is a person, an agent is a job.
--
-- Until now a persona was only a handle, a status, a daily picture limit and
-- a pause flag hung on exactly ONE agent. The name, picture, backstory and
-- voice it showed were that agent's own columns, and creating the persona
-- rewrote them: the agent was renamed to the persona everywhere (org chart,
-- approvals, secretary roster) and the job name was lost.
--
-- After this migration:
--   * personas carries its own identity: display_name, pronouns, traits,
--     backstory, voice, avatar_asset_id. Existing personas are filled in from
--     the agent they sat on, so nothing an operator wrote is lost.
--   * agents.persona_id says which person (if any) is doing that job. One
--     persona can be attached to many agents, full and quick. The agent keeps
--     its own name. Backfilled from the old personas.agent_id link.
--   * agents.limits is a general per-agent box ({dailyImageGenerations,
--     dailyPosts, dailyRuns, notes}). The old per-persona picture limit is
--     copied into it.
--   * agent_daily_counters counts per (agent, kind, UTC day); it replaces the
--     per-persona picture counter as the thing the daily image limit reads.
--   * persona_posts.agent_id names which of the persona's agents queued a
--     post, so the publisher can file the approval on that agent's behalf.
--
-- Strictly additive on data: no row is deleted, no column is dropped, and
-- every backfill only ever fills a NULL or a missing key. The structural
-- relaxations (personas.agent_id loses NOT NULL and its unique index, and its
-- ON DELETE CASCADE becomes SET NULL so deleting the old job can no longer
-- delete the person) are what make "one persona, many agents" safe; the
-- column itself stays and keeps its old value so an older server build still
-- reads it. The server stops writing it. Every statement is guarded so a
-- re-run is a no-op.
--
-- Numbered 0175: 0174 is reserved by another change in flight. Gaps are
-- allowed; the migration runner applies by content hash, not position.
--
-- The new table agent_daily_counters is granted and policed here, in its own
-- guarded block (the 0164 table lists are fixed; its name is also added to
-- those lists, which 0164's test keeps equal to the schema).
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "pronouns" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "traits" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "backstory" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "voice" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "avatar_asset_id" uuid;--> statement-breakpoint
-- Same shape 0132 used for agents.avatar_asset_id: declared by hand because a
-- typed reference in the Drizzle schema would be an import cycle
-- (assets.ts already imports agents.ts, which personas.ts imports).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personas_avatar_asset_id_assets_id_fk') THEN
    ALTER TABLE "personas" ADD CONSTRAINT "personas_avatar_asset_id_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Backfill the persona's identity from the agent it sat on. Only a NULL is
-- ever filled; a persona that already has its own value keeps it.
UPDATE "personas" p SET
  "display_name" = COALESCE(p."display_name", a."name"),
  "backstory" = COALESCE(p."backstory", a."personality"),
  "voice" = COALESCE(p."voice", a."tone"),
  "avatar_asset_id" = COALESCE(p."avatar_asset_id", a."avatar_asset_id")
FROM "agents" a
WHERE a."id" = p."agent_id"
  AND (p."display_name" IS NULL OR p."backstory" IS NULL OR p."voice" IS NULL OR p."avatar_asset_id" IS NULL);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "persona_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_persona_id_personas_id_fk') THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_company_persona_idx" ON "agents" USING btree ("company_id","persona_id");--> statement-breakpoint
-- The old link ran persona -> agent; the new one runs agent -> persona.
UPDATE "agents" a SET "persona_id" = p."id"
FROM "personas" p
WHERE p."agent_id" = a."id" AND a."persona_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- The per-persona picture limit becomes the agent's own daily image limit.
-- Only set when the box does not already carry that key.
UPDATE "agents" a SET "limits" = a."limits" || jsonb_build_object('dailyImageGenerations', p."daily_generation_cap")
FROM "personas" p
WHERE p."agent_id" = a."id"
  AND p."daily_generation_cap" IS NOT NULL
  AND NOT (a."limits" ? 'dailyImageGenerations');--> statement-breakpoint
-- One persona, many agents: the persona no longer has to belong to an agent,
-- and two agents may share one. The column stays (still populated for old
-- rows) so nothing that reads it breaks; the server stops writing it.
ALTER TABLE "personas" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "personas_agent_id_uq";--> statement-breakpoint
-- The legacy link was ON DELETE CASCADE (0142): deleting the one agent a
-- persona used to sit on would delete the PERSON, its accounts and its posts,
-- and silently detach every other job the person holds. Re-point it to SET
-- NULL. Guarded on the current delete rule (confdeltype 'c' = cascade), so a
-- re-run finds SET NULL ('n') and does nothing; the constraint is re-added
-- only when it is absent, so this is the one DROP CONSTRAINT in the file and
-- it is always followed by its own ADD.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personas_agent_id_agents_id_fk' AND confdeltype = 'c'
  ) THEN
    ALTER TABLE "personas" DROP CONSTRAINT "personas_agent_id_agents_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personas_agent_id_agents_id_fk') THEN
    ALTER TABLE "personas" ADD CONSTRAINT "personas_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_daily_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_daily_counters_company_id_companies_id_fk') THEN
    ALTER TABLE "agent_daily_counters" ADD CONSTRAINT "agent_daily_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_daily_counters_agent_id_agents_id_fk') THEN
    ALTER TABLE "agent_daily_counters" ADD CONSTRAINT "agent_daily_counters_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_daily_counters_agent_kind_day_uq" ON "agent_daily_counters" USING btree ("agent_id","kind","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_daily_counters_company_idx" ON "agent_daily_counters" USING btree ("company_id");--> statement-breakpoint
-- Row-level security and grants, same guarded shape 0162 gave lane_a_messages
-- and 0169/0170 gave their tables. Safe where the 0149/0164 roles are absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_daily_counters TO paperclip_app_scoped';
    EXECUTE 'ALTER TABLE agent_daily_counters ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'agent_daily_counters' AND policyname = 'paperclip_company_scope'
    ) THEN
      EXECUTE 'CREATE POLICY paperclip_company_scope ON agent_daily_counters USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_daily_counters TO paperclip_app_bypass_login';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "persona_posts" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'persona_posts_agent_id_agents_id_fk') THEN
    ALTER TABLE "persona_posts" ADD CONSTRAINT "persona_posts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
