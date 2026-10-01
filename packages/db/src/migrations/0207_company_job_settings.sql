-- DUR-4142 (Positions/Jobs backend): the company-wide switch for the
-- one-press "Jobs" surface (file-upload variables, position-linked jobs,
-- the Legal Advisor starter pack, Telegram/quick-agent job start). Purely
-- additive, no row written, no existing column touched.
--
-- Same lazy-row pattern as company_payment_settings (0187): one row per
-- company, created only the first time a board owner/admin turns it on
-- (server/src/services/company-job-settings.ts) -- absence reads as "off".
-- Existing routine CRUD/run/trigger behaviour is unaffected either way;
-- this only gates the Jobs-specific endpoints (create, and any run
-- dispatch -- manual, API, Telegram, schedule, webhook, email all funnel
-- through the same chokepoint).
--
-- Rollback: DROP TABLE "company_job_settings" -- loses only each company's
-- on/off choice (default "off" for every company that never touched it,
-- same as never having the row at all).
CREATE TABLE IF NOT EXISTS "company_job_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"jobs_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_job_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_job_settings" ADD CONSTRAINT "company_job_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0187/0197 used.
-- Safe where the 0149/0164 roles are absent -- company isolation does NOT
-- rest on this, every query in the code filters on the caller's company.
--
-- company_job_settings is also added to 0164_rls_login_roles.sql's
-- paperclip_tables/company_scope_tables arrays (an explicit, documented
-- exception to "never edit an applied migration"), so
-- packages/db/src/rls-login-roles.test.ts stays in sync with the schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_job_settings TO paperclip_app_scoped;
    ALTER TABLE company_job_settings ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'company_job_settings' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON company_job_settings USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_job_settings TO paperclip_app_bypass_login;
  END IF;
END $$;
