-- DUR-372 (follow-up to DUR-369/DUR-317): redactHeartbeatRunPatchSecrets
-- (be5d641bb, merged 2026-08-28T11:10:37+02:00, server/src/redaction.ts)
-- only masks secrets on *new* writes to heartbeat_runs via
-- setRunStatus/setRunStatusIfRunning. Rows persisted before that commit --
-- e.g. the flagged 39f285c4-955f-41a8-a2a7-4b26919b24bc row from
-- 2026-08-27T01:51:01.800Z, which still had a raw github_pat sitting in
-- stdout_excerpt -- were never touched by that write-time gate. This is a
-- one-time backfill that reapplies the exact same SECRET_LEAK_PATTERNS
-- regexes from server/src/redaction.ts directly in SQL to every existing
-- row (a full-table sweep, not just rows created before the fix, in case
-- other rows carry undetected leaks of the same shape). Keep this pattern
-- list in sync with SECRET_LEAK_PATTERNS by hand if that list ever changes --
-- there is no shared source of truth between the TS and SQL copies.
--
-- workspace_operations.stdout_excerpt/stderr_excerpt/metadata have the same
-- leak surface (see the DUR-372 code fix to
-- server/src/services/workspace-operations.ts) and are swept here too,
-- since a row already sitting in the DB right now could carry the same
-- class of leaked credential.
--
-- Rollback: this is a lossy, one-way data scrub (redaction is not
-- reversible by design -- the whole point is to destroy the leaked
-- credential text). There is no down-migration; reverting only removes the
-- helper function below, it does not restore scrubbed text. If a redaction
-- turns out to have been a false positive, the source value must be
-- recovered from wherever it was originally issued (e.g. re-fetching from
-- the provider), not from this table.
CREATE OR REPLACE FUNCTION dur372_redact_leaked_secret_patterns(input text) RETURNS text AS $$
DECLARE
  output text := input;
BEGIN
  IF output IS NULL THEN
    RETURN NULL;
  END IF;
  output := regexp_replace(output, 'github_pat_[A-Za-z0-9_]{20,}', '[REDACTED:github_pat]', 'g');
  output := regexp_replace(output, 'ghp_[A-Za-z0-9]{20,}', '[REDACTED:github_token]', 'g');
  output := regexp_replace(output, 'gho_[A-Za-z0-9]{20,}', '[REDACTED:github_oauth_token]', 'g');
  output := regexp_replace(output, 'ghu_[A-Za-z0-9]{20,}', '[REDACTED:github_user_token]', 'g');
  output := regexp_replace(output, 'ghs_[A-Za-z0-9]{20,}', '[REDACTED:github_app_installation_token]', 'g');
  output := regexp_replace(output, 'ghr_[A-Za-z0-9]{20,}', '[REDACTED:github_refresh_token]', 'g');
  output := regexp_replace(output, '\ysk-[A-Za-z0-9_-]{12,}\y', '[REDACTED:openai_key]', 'g');
  output := regexp_replace(output, 'shpss_[A-Za-z0-9]{20,}', '[REDACTED:shopify_shared_secret]', 'g');
  output := regexp_replace(output, 'shpat_[A-Za-z0-9]{20,}', '[REDACTED:shopify_access_token]', 'g');
  output := regexp_replace(output, 'xoxb-[A-Za-z0-9-]{10,}', '[REDACTED:slack_bot_token]', 'g');
  output := regexp_replace(output, 'xoxp-[A-Za-z0-9-]{10,}', '[REDACTED:slack_user_token]', 'g');
  output := regexp_replace(output, 'AKIA[A-Z0-9]{12,}', '[REDACTED:aws_access_key_id]', 'g');
  output := regexp_replace(
    output,
    '-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----.*?-----END[A-Z0-9 ]*PRIVATE KEY-----',
    '[REDACTED:pem_private_key]',
    'g'
  );
  RETURN output;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint
UPDATE "heartbeat_runs"
SET
  "error" = dur372_redact_leaked_secret_patterns("error"),
  "stdout_excerpt" = dur372_redact_leaked_secret_patterns("stdout_excerpt"),
  "stderr_excerpt" = dur372_redact_leaked_secret_patterns("stderr_excerpt"),
  "result_json" = CASE
    WHEN "result_json" IS NULL THEN NULL
    ELSE dur372_redact_leaked_secret_patterns("result_json"::text)::jsonb
  END
WHERE
  dur372_redact_leaked_secret_patterns(
    coalesce("error", '') || coalesce("stdout_excerpt", '') || coalesce("stderr_excerpt", '') || coalesce("result_json"::text, '')
  )
  <> (
    coalesce("error", '') || coalesce("stdout_excerpt", '') || coalesce("stderr_excerpt", '') || coalesce("result_json"::text, '')
  );
--> statement-breakpoint
UPDATE "workspace_operations"
SET
  "stdout_excerpt" = dur372_redact_leaked_secret_patterns("stdout_excerpt"),
  "stderr_excerpt" = dur372_redact_leaked_secret_patterns("stderr_excerpt"),
  "metadata" = CASE
    WHEN "metadata" IS NULL THEN NULL
    ELSE dur372_redact_leaked_secret_patterns("metadata"::text)::jsonb
  END
WHERE
  dur372_redact_leaked_secret_patterns(
    coalesce("stdout_excerpt", '') || coalesce("stderr_excerpt", '') || coalesce("metadata"::text, '')
  )
  <> (
    coalesce("stdout_excerpt", '') || coalesce("stderr_excerpt", '') || coalesce("metadata"::text, '')
  );
--> statement-breakpoint
DROP FUNCTION dur372_redact_leaked_secret_patterns(text);
