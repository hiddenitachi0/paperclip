-- Legal Phase 3 (DUR-4855 under DUR-4851): reminders that cannot be forgotten.
--
--   * issues.due_date (date, nullable): the day the work is due. Nothing reads
--     it except the UI chip and the contract-deadline reminders, which set it
--     to the deadline's date. Existing rows stay NULL.
--   * issues_active_contract_deadline_reminder_uq: at most one open reminder
--     issue per (company, deadline, lead step), like the other origin indexes.
--     The permanent record is contract_deadline_reminders (0256).
--   * contract_deadlines.needs_owner (boolean): the action is the owner's
--     decision, so its reminder shows as "Needs you". Backfilled true for the
--     decision kinds (notice_extend, notice_terminate, renewal), false else.
--   * contract_settings: one row per company with default lead times for
--     notice deadlines and for the rest (NULL = built-in default). Company
--     scoped: guarded grant + paperclip_company_scope policy at the end, and
--     the name is in both arrays of 0164_rls_login_roles.sql.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "contract_settings"; DROP INDEX
-- "issues_active_contract_deadline_reminder_uq"; ALTER TABLE
-- "contract_deadlines" DROP COLUMN "needs_owner"; ALTER TABLE "issues" DROP
-- COLUMN "due_date". The only data lost is what these additions hold (due
-- dates, the needs-owner flag, the settings rows); no existing column changes.
-- Reminder issues already opened stay as ordinary issues.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "due_date" date;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contract_deadlines' AND column_name = 'needs_owner'
  ) THEN
    ALTER TABLE "contract_deadlines" ADD COLUMN "needs_owner" boolean DEFAULT false NOT NULL;
    UPDATE "contract_deadlines" SET "needs_owner" = true WHERE "kind" IN ('notice_extend', 'notice_terminate', 'renewal');
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"notice_lead_times_days" integer[],
	"other_lead_times_days" integer[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "contract_settings" ADD CONSTRAINT "contract_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_settings_company_uq" ON "contract_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_contract_deadline_reminder_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'contract_deadline'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['contract_settings'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format(
          'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
          t
        );
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    FOREACH t IN ARRAY ARRAY['contract_settings'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
