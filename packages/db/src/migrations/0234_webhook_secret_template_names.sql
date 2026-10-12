-- DUR-4598: data-only backfill. Secrets whose readable name still carries an
-- unrendered routine-title template (e.g. "{{title}}", from DUR-4583's
-- backfill) get renamed from the routine's assignee agent instead of the raw
-- title. Name-only, company-scoped, idempotent (only touches names that still
-- contain '{{').
-- Rollback: not applicable — the previous names embedded an unrendered
-- template placeholder and are not worth restoring.
WITH candidates AS (
  SELECT DISTINCT ON (s."id")
    s."id" AS secret_id,
    s."company_id",
    CASE
      WHEN NULLIF(btrim(a."name"), '') IS NOT NULL THEN 'Webhook password — ' || btrim(a."name") || '''s routine'
      ELSE 'Webhook password — routine'
    END AS base_name
  FROM "company_secrets" s
  JOIN "routine_triggers" t ON t."secret_id" = s."id"
  JOIN "routines" r ON r."id" = t."routine_id"
  LEFT JOIN "agents" a ON a."id" = r."assignee_agent_id"
  WHERE s."name" LIKE '%{{%'
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
    "updated_at" = now()
FROM numbered n
WHERE s."id" = n.secret_id;
