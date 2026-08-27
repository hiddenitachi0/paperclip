-- DUR-250 (Phase 2 of DUR-247): closes the `company_secret_versions` /
-- `cli_auth_challenges` table-coverage gap flagged in Security Reviewer 2's
-- review of PR #166 -- see migration 0148's header comment, "Deliberately
-- excluded from the table lists below", for the full description of why
-- these two were left out of Phase 1. Both are added here as their own
-- migration (rather than editing 0148) because 0148 already shipped with
-- explicit sign-off from two independent security reviews; changing its
-- content would re-open that review rather than extend it.
--
-- company_secret_versions holds the actual secret material (`material`
-- jsonb, `value_sha256`, `fingerprint_sha256`) and is tenanted only
-- indirectly via secret_id -> company_secrets.company_id, so its policy is
-- a subquery against company_secrets rather than a plain column check --
-- same shape the pipeline_stages/pipeline_transitions exclusion still needs
-- (those remain out of scope for this migration; they are not security
-- material the way company_secret_versions is, and are left for a future
-- pass). company_secrets itself already carries the same paperclip_app_scope
-- policy (added in 0148), so the subquery is itself correctly company-scoped
-- when this role runs it.
--
-- cli_auth_challenges holds requested_company_id directly (nullable, since
-- pre-auth CLI device-auth rows haven't picked a company yet) plus
-- secret_hash/pending_key_hash for in-flight device auth -- same
-- nullable-column policy shape as the second table list in 0148.
--
-- Neither table was previously granted to paperclip_app_scoped at all
-- (company_secret_versions failed closed with a permission-denied error
-- rather than open; cli_auth_challenges was simply unreachable through this
-- role), so this migration is additive-only: it grants access for the first
-- time and immediately gates that new access behind RLS in the same
-- statement group, matching 0148's convention of never having grant-without-
-- policy exist as an intermediate state within a migration.
DO $$
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_secret_versions TO paperclip_app_scoped';
  EXECUTE 'ALTER TABLE company_secret_versions ENABLE ROW LEVEL SECURITY';
  EXECUTE $policy$
    CREATE POLICY paperclip_company_scope ON company_secret_versions
    USING (
      EXISTS (
        SELECT 1 FROM company_secrets cs
        WHERE cs.id = company_secret_versions.secret_id
          AND cs.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      )
      OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')
    )
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM company_secrets cs
        WHERE cs.id = company_secret_versions.secret_id
          AND cs.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      )
      OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')
    )
  $policy$;

  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cli_auth_challenges TO paperclip_app_scoped';
  EXECUTE 'ALTER TABLE cli_auth_challenges ENABLE ROW LEVEL SECURITY';
  EXECUTE $policy$
    CREATE POLICY paperclip_company_scope ON cli_auth_challenges
    USING (
      requested_company_id IS NULL
      OR requested_company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')
    )
    WITH CHECK (
      requested_company_id IS NULL
      OR requested_company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')
    )
  $policy$;
END $$;
