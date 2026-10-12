-- DUR-4583: data-only backfill. (1) every webhook trigger that has a secret
-- gets a 'routine_trigger' "used by" binding; (2) the old machine-named
-- per-trigger secrets (key routine-<uuid>-<12 hex>, name = key) get the
-- readable name/description. No schema change.
-- Rollback (best effort, nothing else depends on it):
--   DELETE FROM "company_secret_bindings" WHERE "target_type" = 'routine_trigger';
--   UPDATE "company_secrets" SET "name" = "key"
--     WHERE "key" ~ '^routine-[0-9a-f-]{36}-[0-9a-f]{12}$' AND "name" LIKE 'Webhook password — routine:%';
-- (descriptions are informational and left as written). Re-running is safe:
-- inserts are ON CONFLICT DO NOTHING and the rename only touches rows whose
-- name still equals their key.
INSERT INTO "company_secret_bindings" ("company_id", "secret_id", "target_type", "target_id", "config_path")
SELECT t."company_id", t."secret_id", 'routine_trigger', t."id"::text, 'webhookSecret'
FROM "routine_triggers" t
WHERE t."secret_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
WITH candidates AS (
  SELECT DISTINCT ON (s."id")
    s."id" AS secret_id,
    s."company_id",
    'Webhook password — routine: ' || left(btrim(r."title"), 120)
      || COALESCE(' (' || NULLIF(btrim(COALESCE(a."name", u."name")), '') || ')', '') AS base_name,
    'Created by Paperclip for the webhook trigger ''' || COALESCE(NULLIF(btrim(t."label"), ''), 'webhook')
      || '''. Used by: [' || btrim(r."title") || '](/routines/' || r."id" || ').' AS new_description
  FROM "company_secrets" s
  JOIN "routine_triggers" t ON t."secret_id" = s."id"
  JOIN "routines" r ON r."id" = t."routine_id"
  LEFT JOIN "agents" a ON a."id" = t."created_by_agent_id"
  LEFT JOIN "user" u ON u."id" = t."created_by_user_id"
  WHERE s."key" ~ '^routine-[0-9a-f-]{36}-[0-9a-f]{12}$'
    AND s."name" = s."key"
    AND s."status" <> 'deleted'
  ORDER BY s."id", t."created_at"
), numbered AS (
  SELECT c.*, row_number() OVER (PARTITION BY c."company_id", c.base_name ORDER BY c.secret_id) AS rn
  FROM candidates c
)
UPDATE "company_secrets" s
SET "name" = CASE
      WHEN n.rn > 1 OR EXISTS (
        SELECT 1 FROM "company_secrets" o
        WHERE o."company_id" = n."company_id" AND o."name" = n.base_name AND o."id" <> n.secret_id
      ) THEN n.base_name || ' #' || substr(n.secret_id::text, 1, 4)
      ELSE n.base_name
    END,
    "description" = n.new_description,
    "updated_at" = now()
FROM numbered n
WHERE s."id" = n.secret_id;
