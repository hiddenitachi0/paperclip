-- DUR-130: DUR-128 closed the reason a direct-to-database back door existed
-- (a real delegated operator credential now exists). This migration closes
-- the other half: any write to a DUR-128-relevant table that does NOT come
-- from the application's service layer, the migration runner, or the backup
-- restore path is now detected at the database level and recorded so it can
-- be surfaced as an operator-visible alert, instead of leaving no trace the
-- way the original incident (NOR-180/NOR-181) did.
--
-- Mechanism: the app tags every connection it opens with a Postgres
-- `application_name` naming which code path opened it (see
-- packages/db/src/client.ts and packages/db/src/backup-lib.ts). A trigger on
-- each monitored table checks that tag on every INSERT/UPDATE/DELETE; any
-- connection not carrying one of the known-legitimate names is recorded here.
-- `application_name` is a client-set GUC, not access-controlled -- this is a
-- monitoring signal for the ordinary "someone reached for psql instead of
-- the app" case (the actual DUR-128/NOR-180 failure mode), not a hardened
-- security boundary. A determined bypass could still spoof the tag; closing
-- that would need per-path DB roles with REVOKE'd direct grants, a larger
-- change deferred as future work if this signal proves insufficient.

CREATE TABLE "untracked_write_incidents" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "table_name"         text NOT NULL,
  "operation"          text NOT NULL,
  "row_id"             text,
  "company_id"         uuid,
  "application_name"   text,
  "session_user_name"  text NOT NULL,
  "occurred_at"        timestamptz NOT NULL DEFAULT now(),
  "alerted_at"         timestamptz
);
--> statement-breakpoint
CREATE INDEX "untracked_write_incidents_unalerted_idx" ON "untracked_write_incidents" ("occurred_at") WHERE "alerted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "untracked_write_incidents_company_idx" ON "untracked_write_incidents" ("company_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_flag_untracked_write() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_app_name text := current_setting('application_name', true);
  v_row jsonb := to_jsonb(COALESCE(NEW, OLD));
BEGIN
  IF v_app_name IS NULL OR v_app_name NOT IN ('paperclip-app', 'paperclip-migrate', 'paperclip-restore') THEN
    INSERT INTO untracked_write_incidents (
      table_name, operation, row_id, company_id, application_name, session_user_name
    ) VALUES (
      TG_TABLE_NAME,
      TG_OP,
      v_row ->> 'id',
      NULLIF(v_row ->> 'company_id', '')::uuid,
      v_app_name,
      session_user
    );
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_agents AFTER INSERT OR UPDATE OR DELETE ON "agents" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_issues AFTER INSERT OR UPDATE OR DELETE ON "issues" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_approvals AFTER INSERT OR UPDATE OR DELETE ON "approvals" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_activity_log AFTER INSERT OR UPDATE OR DELETE ON "activity_log" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_board_delegate_tokens AFTER INSERT OR UPDATE OR DELETE ON "board_delegate_tokens" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_companies AFTER INSERT OR UPDATE OR DELETE ON "companies" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
--> statement-breakpoint
CREATE TRIGGER trg_flag_untracked_write_instance_settings AFTER INSERT OR UPDATE OR DELETE ON "instance_settings" FOR EACH ROW EXECUTE FUNCTION fn_flag_untracked_write();
