-- DUR-4070: two new columns on "agents" for quick-agent (Lane A) security
-- hardening ahead of inviting any employee.
--
--   * lane_a_trust_level (text, NOT NULL, default 'full') -- one of
--     'limited' | 'standard' | 'full'. Every consumer of plugin tools,
--     business data, company files, web search, browser access and memory
--     now reads this first: 'limited' means none of the six, regardless of
--     any other per-tool switch/grant already stored on the row. 'standard'
--     and 'full' both read every other switch exactly as before this column
--     existed.
--   * lane_a_assigned_user_ids (jsonb string[], NOT NULL, default '[]') --
--     company-member userIds (company_memberships.principal_id) this quick
--     agent may answer, besides the company's owner, who can always reach
--     it. Empty (every existing and new agent) means "the owner only".
--
-- Both default to the value that reproduces today's behavior exactly: every
-- existing quick agent keeps answering everyone in its company (until an
-- operator explicitly assigns it) and keeps every tool right it already had
-- (until an operator explicitly turns it down to Standard or Limited). No
-- production behavior changes from this migration alone -- only from the
-- server-side enforcement that reads these columns, and from an operator
-- changing either setting on the agent page.
--
-- Additive only: two defaulted columns and one CHECK constraint. Every
-- statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP CONSTRAINT "agents_lane_a_trust_level_check", then DROP
-- COLUMN "lane_a_trust_level" and DROP COLUMN "lane_a_assigned_user_ids" from
-- "agents". Safe -- no other table references either column (no FK) and no
-- data is generated from them, so a rollback loses only the current position
-- of both dials, not anything an agent did with them.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_trust_level" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_assigned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_lane_a_trust_level_check') THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_lane_a_trust_level_check" CHECK ("lane_a_trust_level" IN ('limited', 'standard', 'full'));
  END IF;
END $$;--> statement-breakpoint
