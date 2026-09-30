-- DUR-4094: Filip's emergency-access ("break-glass") audit trail for the
-- Employee (light) role and private workspaces.
--
-- New table "private_access_events" -- one append-only row per time an
-- owner or admin reads private content belonging to someone else (a PA
-- conversation transcript or memory notes, read through the new
-- emergency-access route rather than through the subject's own account).
-- "reason" is NOT NULL: it is required even when "notify" is false, so a
-- silent access made during a suspected-misuse review still leaves the
-- written justification behind as evidence. "notify" only controls whether
-- the row is included in the subject's own "My access log" read -- it never
-- suppresses the row itself, which stays visible to owners regardless.
--
-- Same shape as the existing "secret_access_events" ledger: no update or
-- delete route is ever expected to exist for this table.
--
-- Additive only, no existing table touched. Every statement is guarded so a
-- re-run is a no-op.
--
-- Rollback: DROP TABLE "private_access_events". Safe -- nothing references
-- it (no FK from any other table) and dropping it only loses audit history,
-- never anything a person wrote or a PA remembered.
CREATE TABLE IF NOT EXISTS "private_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_user_id" text NOT NULL,
	"accessed_by_user_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text,
	"reason" text NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "private_access_events" ADD CONSTRAINT "private_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "private_access_events_company_created_idx" ON "private_access_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "private_access_events_target_user_idx" ON "private_access_events" USING btree ("company_id","target_user_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0180 used for
-- agent_memories, so this table stays in line with the rest of the tenant
-- tables on a database where those roles exist. Safe where the 0149/0164
-- roles are absent. Company isolation does NOT rest on this: every query in
-- the code filters on the caller's company; this is defense in depth for
-- direct database access, which is exactly the boundary Filip's emergency-
-- access rule is honest about not fully closing (see 3-members-access-
-- privacy.md, "What private can and cannot promise").
--
-- 'private_access_events' is also added to the paperclip_tables and
-- company_scope_tables arrays in 0164_rls_login_roles.sql (an explicit,
-- documented exception to "never edit an applied migration"), so
-- packages/db/src/rls-login-roles.test.ts stays in sync with the schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "private_access_events" TO paperclip_app_scoped';
    EXECUTE 'ALTER TABLE "private_access_events" ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'private_access_events' AND policyname = 'paperclip_company_scope'
    ) THEN
      EXECUTE 'CREATE POLICY paperclip_company_scope ON "private_access_events" USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "private_access_events" TO paperclip_app_bypass_login';
  END IF;
END $$;
