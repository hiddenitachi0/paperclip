-- DUR-5019 (follow-up DUR-5145): the Trader may apply a walk-forward-tested
-- change to a PAPER strategy itself, with no approval card.
--
-- Until now the database said "an approved version was approved by a person
-- (or is a grandfathered legacy conversion)". That rule is what keeps an agent
-- from approving its own rules, so it is not loosened to "or an agent". It is
-- widened by exactly one new, narrow case: a version that carries BOTH the id
-- of the agent that applied it AND the id of the finished experiment it was
-- applied on, where that agent is the version's own proposer.
--
-- What this migration does (additive; no existing row is read or changed):
--   * trading_strategy_versions.applied_by_agent_id / applied_experiment_id:
--     both NULL for every existing row. Set at insert, never changed (the
--     immutability trigger below now protects them too).
--   * trading_strategy_versions_applied_pair_check: the two columns are set
--     together or not at all.
--   * trading_strategy_versions_approval_pair_check is re-created with the one
--     extra case above. Every existing approved row already satisfies the old
--     condition, which is a subset of the new one, so adding it cannot fail.
--   * trading_strategy_versions_immutable() is re-created to protect the two
--     new columns as well; its other rules are copied unchanged from 0266.
--
-- Rollback (safe for data; read this first): applied versions have no approving
-- user, so the OLD check cannot be restored while any applied version is still
-- 'approved'. Roll back in this order:
--   1. Deploy code that no longer applies versions (or stop the Trader).
--   2. UPDATE "trading_strategy_versions" SET approved_by_user_id = '<an owner user id>'
--        WHERE applied_by_agent_id IS NOT NULL AND approved_by_user_id IS NULL AND status = 'approved';
--      (the trigger refuses this edit: first
--        ALTER TABLE "trading_strategy_versions" DISABLE TRIGGER trading_strategy_versions_immutable;
--       and enable it again after.) This records, truthfully, that an owner accepted the live rules on rollback.
--   3. ALTER TABLE "trading_strategy_versions" DROP CONSTRAINT IF EXISTS "trading_strategy_versions_applied_pair_check";
--      ALTER TABLE "trading_strategy_versions" DROP CONSTRAINT IF EXISTS "trading_strategy_versions_approval_pair_check";
--      ALTER TABLE "trading_strategy_versions" ADD CONSTRAINT "trading_strategy_versions_approval_pair_check" CHECK ("status" <> 'approved' OR ("approved_at" IS NOT NULL AND ("approved_by_user_id" IS NOT NULL OR "grandfathered")));
--   4. Re-create trading_strategy_versions_immutable() from 0266, then
--      ALTER TABLE "trading_strategy_versions" DROP COLUMN IF EXISTS "applied_by_agent_id", DROP COLUMN IF EXISTS "applied_experiment_id";
-- Dropping the columns loses only the record of which versions the Trader
-- applied (the ledger notes with reason strategy_version_applied_by_trader
-- keep that history).
ALTER TABLE "trading_strategy_versions" ADD COLUMN IF NOT EXISTS "applied_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "trading_strategy_versions" ADD COLUMN IF NOT EXISTS "applied_experiment_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategy_versions_applied_pair_check') THEN
    ALTER TABLE "trading_strategy_versions" ADD CONSTRAINT "trading_strategy_versions_applied_pair_check" CHECK (("applied_by_agent_id" IS NULL) = ("applied_experiment_id" IS NULL));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "trading_strategy_versions" DROP CONSTRAINT IF EXISTS "trading_strategy_versions_approval_pair_check";--> statement-breakpoint
ALTER TABLE "trading_strategy_versions" ADD CONSTRAINT "trading_strategy_versions_approval_pair_check" CHECK ("trading_strategy_versions"."status" <> 'approved' OR ("trading_strategy_versions"."approved_at" IS NOT NULL AND ("trading_strategy_versions"."approved_by_user_id" IS NOT NULL OR "trading_strategy_versions"."grandfathered" OR ("trading_strategy_versions"."applied_by_agent_id" IS NOT NULL AND "trading_strategy_versions"."applied_experiment_id" IS NOT NULL AND "trading_strategy_versions"."proposed_by_type" = 'agent' AND "trading_strategy_versions"."proposed_by_id" = "trading_strategy_versions"."applied_by_agent_id"))));--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_strategy_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.spec IS DISTINCT FROM OLD.spec
     OR NEW.guidelines IS DISTINCT FROM OLD.guidelines
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.proposed_by_type IS DISTINCT FROM OLD.proposed_by_type
     OR NEW.proposed_by_id IS DISTINCT FROM OLD.proposed_by_id
     OR NEW.applied_by_agent_id IS DISTINCT FROM OLD.applied_by_agent_id
     OR NEW.applied_experiment_id IS DISTINCT FROM OLD.applied_experiment_id
     OR NEW.grandfathered IS DISTINCT FROM OLD.grandfathered
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'trading_strategy_versions: a version''s rules, guidelines, digest and origin never change; propose a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft' AND NEW.status IN ('approved', 'superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'trading_strategy_versions: a version cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- The card link is set once while the version is a draft (and can only be cleared afterwards, by the card's own deletion).
  IF NEW.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id AND (OLD.approval_id IS NOT NULL OR OLD.status <> 'draft') THEN
    RAISE EXCEPTION 'trading_strategy_versions: the approval card of a version is fixed once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'trading_strategy_versions: who approved a version, and when, never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'trading_strategy_versions: a superseded version is final'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
