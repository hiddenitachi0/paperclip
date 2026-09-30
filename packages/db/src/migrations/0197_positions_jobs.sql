-- DUR-4142: Positions and Jobs backend.
--
-- "Positions" (today's "Jobs" page) stays the company_agent_roles table --
-- no rename here, API/UI copy aliases only (see server/src/routes). "Jobs"
-- (today's Routines) gets the extra config a one-press job needs: a run
-- mode, a model profile/effort, an output-format hint, a board-approval
-- gate before done, and links to one or more Positions so the job appears
-- for every agent hired into them.
ALTER TABLE "routines" ADD COLUMN "run_mode" text DEFAULT 'full_agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "model_profile" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "output_format" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "requires_approval_before_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE "routine_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"company_agent_role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_positions" ADD CONSTRAINT "routine_positions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_positions" ADD CONSTRAINT "routine_positions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_positions" ADD CONSTRAINT "routine_positions_company_agent_role_id_company_agent_roles_id_fk" FOREIGN KEY ("company_agent_role_id") REFERENCES "public"."company_agent_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_positions_routine_position_uq" ON "routine_positions" USING btree ("routine_id","company_agent_role_id");--> statement-breakpoint
CREATE INDEX "routine_positions_company_idx" ON "routine_positions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "routine_positions_position_idx" ON "routine_positions" USING btree ("company_agent_role_id");--> statement-breakpoint

-- Event trigger kind 'mail_secretary_rule': "a job can also start on an email
-- matched the secretary's rule" (DUR-4142, replaces the never-built separate
-- "Duties" idea -- there was nothing else to migrate away from). Reuses the
-- mail-secretary's own field/matchType/value rule shape (mailFilterMatches in
-- @paperclipai/shared) so the match stays code-only, no model call. Null for
-- every other trigger kind.
ALTER TABLE "routine_triggers" ADD COLUMN "mail_inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "mail_rule_field" text;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "mail_rule_match_type" text;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "mail_rule_value" text;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_mail_inbox_id_mail_inboxes_id_fk" FOREIGN KEY ("mail_inbox_id") REFERENCES "public"."mail_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_triggers_mail_inbox_idx" ON "routine_triggers" USING btree ("mail_inbox_id","enabled");--> statement-breakpoint

-- mail_secretary_items gains a 'triggered_job' decision and a pointer to the
-- routine_runs row a matching mail_secretary_rule trigger produced. Plain
-- uuid, no FK (keeps packages/db/src/schema/mail_secretary.ts from having to
-- import routines.ts, which already imports mail_secretary.ts for
-- mail_inbox_id above -- avoids a schema-file import cycle).
ALTER TABLE "mail_secretary_items" ADD COLUMN "triggered_routine_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_secretary_items" DROP CONSTRAINT "mail_secretary_items_decision_check";--> statement-breakpoint
ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_decision_check" CHECK ("mail_secretary_items"."decision" IN ('ignored_by_filter', 'ignored_by_classifier', 'kept_for_filip', 'delegated_to_maja', 'triggered_job', 'error'));--> statement-breakpoint

-- Row-level security and grants for the one new table, the same guarded
-- shape 0195_mail_secretary/0196_video_storylines used. Safe where the
-- 0149/0164 roles are absent -- company isolation does NOT rest on this,
-- every query in the code filters on the caller's company.
--
-- routine_positions is also added to the paperclip_tables and
-- company_scope_tables arrays in 0164_rls_login_roles.sql (an explicit,
-- documented exception to "never edit an applied migration"), so
-- packages/db/src/rls-login-roles.test.ts stays in sync with the schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE routine_positions TO paperclip_app_scoped;
    ALTER TABLE routine_positions ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'routine_positions' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON routine_positions USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE routine_positions TO paperclip_app_bypass_login;
  END IF;
END $$;
