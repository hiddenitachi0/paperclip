-- DUR-133 (persona-mcp Ticket B, item 10): a persona layered on top of an
-- agent — her name, face and voice. One persona per agent.

CREATE TABLE "personas" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"       uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id"         uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "display_name"     text NOT NULL,
  "handle"           text,
  "bio"              text,
  "voice"            text,
  "avatar_asset_id"  uuid REFERENCES "assets"("id") ON DELETE SET NULL,
  "status"           text NOT NULL DEFAULT 'active',
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("agent_id")
);
--> statement-breakpoint
CREATE INDEX "personas_company_status_idx" ON "personas"("company_id", "status");
