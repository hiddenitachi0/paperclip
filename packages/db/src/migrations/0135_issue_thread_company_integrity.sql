-- DUR-110: a cross-company boundary failure let an agent from one company
-- persist an issue_thread_interactions row (and issue_comments rows) whose
-- company_id was taken from the writing actor instead of the issue it hangs
-- off of. Application code already derives company_id from the parent issue
-- on every known write path, but that guarantee lived entirely in app code,
-- so any path that skipped it (a future route, a plugin, a script with direct
-- DB access) could silently write a mismatched row. This makes the mismatch
-- structurally impossible: company_id is always forced to match the parent
-- issue's company_id, regardless of what the caller supplied.
CREATE OR REPLACE FUNCTION enforce_issue_child_company_id() RETURNS trigger AS $$
DECLARE
  resolved_company_id uuid;
BEGIN
  SELECT company_id INTO resolved_company_id FROM issues WHERE id = NEW.issue_id;
  IF resolved_company_id IS NULL THEN
    RAISE EXCEPTION '% references issue % which does not exist', TG_TABLE_NAME, NEW.issue_id;
  END IF;
  IF NEW.company_id IS DISTINCT FROM resolved_company_id THEN
    RAISE WARNING 'Forcing % company_id to % for issue % to match its issue; caller supplied %',
      TG_TABLE_NAME, resolved_company_id, NEW.issue_id, NEW.company_id;
  END IF;
  NEW.company_id := resolved_company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS issue_comments_enforce_company_id ON "issue_comments";
--> statement-breakpoint
CREATE TRIGGER issue_comments_enforce_company_id
  BEFORE INSERT OR UPDATE OF issue_id, company_id ON "issue_comments"
  FOR EACH ROW EXECUTE FUNCTION enforce_issue_child_company_id();
--> statement-breakpoint
DROP TRIGGER IF EXISTS issue_thread_interactions_enforce_company_id ON "issue_thread_interactions";
--> statement-breakpoint
CREATE TRIGGER issue_thread_interactions_enforce_company_id
  BEFORE INSERT OR UPDATE OF issue_id, company_id ON "issue_thread_interactions"
  FOR EACH ROW EXECUTE FUNCTION enforce_issue_child_company_id();
--> statement-breakpoint
-- Repair the DUR-68 incident rows so they satisfy the invariant this migration
-- now enforces going forward (the trigger only fires on future writes).
UPDATE "issue_comments" c
SET company_id = i.company_id
FROM "issues" i
WHERE c.issue_id = i.id AND c.company_id IS DISTINCT FROM i.company_id;
--> statement-breakpoint
UPDATE "issue_thread_interactions" t
SET company_id = i.company_id
FROM "issues" i
WHERE t.issue_id = i.id AND t.company_id IS DISTINCT FROM i.company_id;
