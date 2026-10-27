-- Legal Phase 1 (DUR-4852 under DUR-4851): the contract register.
-- (Numbered 0256: 0255 is board-chat-authenticated.)
--
-- Five new company-scoped tables, see packages/db/src/schema/contracts.ts:
--   * contracts: one row per contract version. supersedes_contract_id (self FK,
--     unique where not null, so the chain is a line) + version_no +
--     change_summary make the version log a walk along the chain.
--   * contract_parties: CRM organisation (set null on delete) and/or free-text name.
--   * contract_deadlines: dates that need an action, with lead_times_days int[].
--   * contract_deadline_reminders: unique (deadline_id, lead_days); Phase 3
--     relies on it to open each reminder issue once.
--   * contract_terms: one value per (contract_id, key).
-- Contracts are confidential. contracts.extracted_text is the only column
-- holding contract text.
-- No existing table or row is changed. Every statement is guarded so a re-run
-- is a no-op. RLS: the guarded grant + paperclip_company_scope policy block at
-- the end, and all five names are in both arrays of 0164_rls_login_roles.sql.
--
-- Rollback: DROP TABLE "contract_deadline_reminders", "contract_terms",
-- "contract_parties", "contract_deadlines", "contracts"; (that order). Nothing
-- else references these tables, so the only data lost is the register itself.
CREATE TABLE IF NOT EXISTS "contract_deadline_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deadline_id" uuid NOT NULL,
	"lead_days" integer NOT NULL,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"due_date" date NOT NULL,
	"lead_times_days" integer[] NOT NULL,
	"clause_ref" text,
	"state" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"organization_id" uuid,
	"role" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_kind" text NOT NULL,
	"number_value" numeric(24, 6),
	"currency" text,
	"text_value" text,
	"bool_value" boolean,
	"clause_ref" text,
	"page_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"asset_id" uuid,
	"extracted_text" text,
	"text_status" text DEFAULT 'pending' NOT NULL,
	"language" text,
	"governing_law" text,
	"effective_date" date,
	"expiry_date" date,
	"auto_renewal" boolean,
	"notice_period_days" integer,
	"summary" text,
	"supersedes_contract_id" uuid,
	"version_no" integer DEFAULT 1 NOT NULL,
	"change_summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"source_issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_deadline_reminders_company_id_companies_id_fk') THEN
    ALTER TABLE "contract_deadline_reminders" ADD CONSTRAINT "contract_deadline_reminders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_deadline_reminders_deadline_id_contract_deadlines_id_fk') THEN
    ALTER TABLE "contract_deadline_reminders" ADD CONSTRAINT "contract_deadline_reminders_deadline_id_contract_deadlines_id_fk" FOREIGN KEY ("deadline_id") REFERENCES "public"."contract_deadlines"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_deadline_reminders_issue_id_issues_id_fk') THEN
    ALTER TABLE "contract_deadline_reminders" ADD CONSTRAINT "contract_deadline_reminders_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_deadlines_company_id_companies_id_fk') THEN
    ALTER TABLE "contract_deadlines" ADD CONSTRAINT "contract_deadlines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_deadlines_contract_id_contracts_id_fk') THEN
    ALTER TABLE "contract_deadlines" ADD CONSTRAINT "contract_deadlines_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_parties_company_id_companies_id_fk') THEN
    ALTER TABLE "contract_parties" ADD CONSTRAINT "contract_parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_parties_contract_id_contracts_id_fk') THEN
    ALTER TABLE "contract_parties" ADD CONSTRAINT "contract_parties_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_parties_organization_id_crm_organizations_id_fk') THEN
    ALTER TABLE "contract_parties" ADD CONSTRAINT "contract_parties_organization_id_crm_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."crm_organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_terms_company_id_companies_id_fk') THEN
    ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_terms_contract_id_contracts_id_fk') THEN
    ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_company_id_companies_id_fk') THEN
    ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_asset_id_assets_id_fk') THEN
    ALTER TABLE "contracts" ADD CONSTRAINT "contracts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_supersedes_contract_id_contracts_id_fk') THEN
    ALTER TABLE "contracts" ADD CONSTRAINT "contracts_supersedes_contract_id_contracts_id_fk" FOREIGN KEY ("supersedes_contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_source_issue_id_issues_id_fk') THEN
    ALTER TABLE "contracts" ADD CONSTRAINT "contracts_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_deadline_reminders_deadline_lead_uq" ON "contract_deadline_reminders" USING btree ("deadline_id","lead_days");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_deadline_reminders_company_idx" ON "contract_deadline_reminders" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_deadlines_contract_idx" ON "contract_deadlines" USING btree ("contract_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_deadlines_company_state_due_idx" ON "contract_deadlines" USING btree ("company_id","state","due_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_parties_contract_idx" ON "contract_parties" USING btree ("contract_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_parties_company_org_idx" ON "contract_parties" USING btree ("company_id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_terms_contract_key_uq" ON "contract_terms" USING btree ("contract_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_terms_company_key_idx" ON "contract_terms" USING btree ("company_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_company_status_idx" ON "contracts" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_company_type_idx" ON "contracts" USING btree ("company_id","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_company_expiry_idx" ON "contracts" USING btree ("company_id","expiry_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_supersedes_idx" ON "contracts" USING btree ("supersedes_contract_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_supersedes_uq" ON "contracts" USING btree ("supersedes_contract_id") WHERE "contracts"."supersedes_contract_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['contracts', 'contract_parties', 'contract_deadlines', 'contract_deadline_reminders', 'contract_terms'] LOOP
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
    FOREACH t IN ARRAY ARRAY['contracts', 'contract_parties', 'contract_deadlines', 'contract_deadline_reminders', 'contract_terms'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
