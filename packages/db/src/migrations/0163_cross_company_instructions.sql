-- Guarded cross-company instruction channel. The ONLY sanctioned path
-- between two companies on one instance: an agent in the sending company
-- files a plain-text instruction for the receiving company's designated
-- liaison agent; the receiving company's board approves a card; on approval
-- the liaison gets the instruction as an issue inside its own company. No
-- data, files, credentials or access cross -- only this text. Every step is
-- written to activity_log on BOTH sides.
--
-- The row belongs to both companies, so unlike the single company_id tables
-- from migration 0149 its row-level-security policy admits either the
-- sending or the receiving company's session claim (plus the usual
-- paperclip_app_bypass membership). Additive only: no existing table changes.
CREATE TABLE "cross_company_instructions" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_company_id"      uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "from_agent_id"        uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "to_company_id"        uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "to_agent_id"          uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "subject"              text NOT NULL,
  "instruction"          text NOT NULL,
  "status"               text NOT NULL DEFAULT 'pending_approval',
  "approval_id"          uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "delivered_issue_id"   uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "decided_by_user_id"   text,
  "decision_note"        text,
  "decided_at"           timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "cross_company_instructions_to_company_status_idx" ON "cross_company_instructions" ("to_company_id", "status");
--> statement-breakpoint
CREATE INDEX "cross_company_instructions_from_company_idx" ON "cross_company_instructions" ("from_company_id");
--> statement-breakpoint
CREATE INDEX "cross_company_instructions_approval_idx" ON "cross_company_instructions" ("approval_id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cross_company_instructions TO paperclip_app_scoped';
  END IF;
  EXECUTE 'ALTER TABLE cross_company_instructions ENABLE ROW LEVEL SECURITY';
  EXECUTE $policy$
    CREATE POLICY paperclip_company_scope ON cross_company_instructions
    USING (
      from_company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      OR to_company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')
    )
    WITH CHECK (
      from_company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      OR to_company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')
    )
  $policy$;
END $$;
