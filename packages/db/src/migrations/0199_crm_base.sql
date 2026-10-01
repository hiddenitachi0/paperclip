CREATE TABLE "crm_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"email" text,
	"phone" text,
	"website" text,
	"industry" text,
	"employee_count" text,
	"location" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"title" text,
	"notes" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contact_org_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"organization_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"activity_date" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_activities_type_check" CHECK ("crm_activities"."type" IN ('email', 'call', 'meeting', 'note', 'task', 'other'))
);
--> statement-breakpoint
CREATE TABLE "crm_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"organization_id" uuid,
	"fact_key" text NOT NULL,
	"value" text NOT NULL,
	"source_url" text,
	"source_message_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_external_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"organization_id" uuid,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_external_refs_unique" UNIQUE ("company_id", "system", "external_id")
);
--> statement-breakpoint
CREATE INDEX "crm_organizations_company_id_idx" ON "crm_organizations" ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_contacts_company_id_idx" ON "crm_contacts" ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_contacts_email_idx" ON "crm_contacts" ("email");
--> statement-breakpoint
CREATE INDEX "crm_contact_org_roles_contact_id_idx" ON "crm_contact_org_roles" ("contact_id");
--> statement-breakpoint
CREATE INDEX "crm_contact_org_roles_organization_id_idx" ON "crm_contact_org_roles" ("organization_id");
--> statement-breakpoint
CREATE INDEX "crm_activities_company_id_idx" ON "crm_activities" ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_activities_contact_id_idx" ON "crm_activities" ("contact_id");
--> statement-breakpoint
CREATE INDEX "crm_activities_organization_id_idx" ON "crm_activities" ("organization_id");
--> statement-breakpoint
CREATE INDEX "crm_activities_activity_date_idx" ON "crm_activities" ("activity_date");
--> statement-breakpoint
CREATE INDEX "crm_facts_company_id_idx" ON "crm_facts" ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_facts_contact_id_idx" ON "crm_facts" ("contact_id");
--> statement-breakpoint
CREATE INDEX "crm_facts_organization_id_idx" ON "crm_facts" ("organization_id");
--> statement-breakpoint
CREATE INDEX "crm_external_refs_company_id_idx" ON "crm_external_refs" ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_external_refs_contact_id_idx" ON "crm_external_refs" ("contact_id");
--> statement-breakpoint
CREATE INDEX "crm_external_refs_organization_id_idx" ON "crm_external_refs" ("organization_id");
--> statement-breakpoint
ALTER TABLE "crm_organizations" ADD CONSTRAINT "crm_organizations_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_contact_org_roles" ADD CONSTRAINT "crm_contact_org_roles_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_contact_org_roles" ADD CONSTRAINT "crm_contact_org_roles_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm_contacts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_contact_org_roles" ADD CONSTRAINT "crm_contact_org_roles_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "crm_organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm_contacts"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "crm_organizations"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "crm_facts" ADD CONSTRAINT "crm_facts_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_facts" ADD CONSTRAINT "crm_facts_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm_contacts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_facts" ADD CONSTRAINT "crm_facts_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "crm_organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_external_refs" ADD CONSTRAINT "crm_external_refs_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_external_refs" ADD CONSTRAINT "crm_external_refs_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm_contacts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_external_refs" ADD CONSTRAINT "crm_external_refs_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "crm_organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0177/0180/0181 used,
-- so these tables stay in line with the rest of the tenant tables on a
-- database where those roles exist. Company isolation does NOT rest on this:
-- every query in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['crm_organizations', 'crm_contacts', 'crm_contact_org_roles', 'crm_activities', 'crm_facts', 'crm_external_refs'] LOOP
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
    FOREACH t IN ARRAY ARRAY['crm_organizations', 'crm_contacts', 'crm_contact_org_roles', 'crm_activities', 'crm_facts', 'crm_external_refs'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
