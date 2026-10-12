-- "Ask Paperclip" helper, Phase 3: deeper investigations by a full agent.
-- An investigation is an ordinary task (issues.origin_kind
-- 'helper_investigation'), so no new table is needed. These columns hold the
-- per-company settings an owner/admin can change under Company settings →
-- General → Helper:
--   investigation_max_running          most investigations one person may
--                                      have running at once (NULL = 3)
--   investigation_max_per_day          most investigations one person may
--                                      start in 24 hours (NULL = 20)
--   investigation_company_max_per_day  most investigations the whole company
--                                      may start in 24 hours (NULL = 50)
--   investigation_agent_write_ack      an owner/admin's confirmation that the
--                                      investigation agent can change things
--                                      ({agentId, capabilities[], userId, at});
--                                      NULL = none given
--
-- Strictly additive: four nullable columns, no existing row changed. Guarded
-- so a re-run is a no-op. company_helper_settings is already in the RLS
-- arrays of 0164_rls_login_roles.sql (added with 0238), so nothing changes
-- there.
--
-- Rollback: ALTER TABLE "company_helper_settings" DROP COLUMN "investigation_max_running";
--           ALTER TABLE "company_helper_settings" DROP COLUMN "investigation_max_per_day";
--           ALTER TABLE "company_helper_settings" DROP COLUMN "investigation_company_max_per_day";
--           ALTER TABLE "company_helper_settings" DROP COLUMN "investigation_agent_write_ack";
-- Safe -- nothing else reads them; a rollback only forgets the limits (the
-- defaults apply again) and the confirmation (a write-capable investigation
-- agent is then refused until an owner/admin confirms again).
ALTER TABLE "company_helper_settings" ADD COLUMN IF NOT EXISTS "investigation_max_running" integer;--> statement-breakpoint
ALTER TABLE "company_helper_settings" ADD COLUMN IF NOT EXISTS "investigation_max_per_day" integer;--> statement-breakpoint
ALTER TABLE "company_helper_settings" ADD COLUMN IF NOT EXISTS "investigation_company_max_per_day" integer;--> statement-breakpoint
ALTER TABLE "company_helper_settings" ADD COLUMN IF NOT EXISTS "investigation_agent_write_ack" jsonb;
