-- DUR-114: company_agent_roles table (jobs: default instructions, default
-- MCP tool servers, default permission grants) plus the agents.role_id
-- assignment link and role_applied_* snapshot columns used to render
-- "added"/"removed" overrides against what a role applied at assignment
-- time. Rollback: DROP TABLE company_agent_roles (cascade drops its FK from
-- agents.role_id, which is ON DELETE SET NULL so no agent row is deleted);
-- then drop the four new agents columns. No existing rows are modified --
-- all new columns are nullable and default to NULL, so pre-existing agents
-- are simply unassigned from any role until explicitly assigned one.
CREATE TABLE "company_agent_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"default_instructions" text,
	"default_mcp_servers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_permission_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_applied_mcp_server_names" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_applied_permission_grants" jsonb;--> statement-breakpoint
ALTER TABLE "company_agent_roles" ADD CONSTRAINT "company_agent_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_role_id_company_agent_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."company_agent_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_agent_roles_company_key_idx" ON "company_agent_roles" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "agents_role_id_idx" ON "agents" USING btree ("role_id");
