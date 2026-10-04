-- DUR-4458: let the Costs page show Sogni's "tracked vs. provider says" check
-- the same way Fal's is shown. Additive, nullable columns on an existing
-- table; no existing row is touched.
-- Rollback: ALTER TABLE "cost_reconciliation_runs" DROP COLUMN "mismatch_micro_usd", DROP COLUMN "tracked_micro_usd";
ALTER TABLE "cost_reconciliation_runs" ADD COLUMN "mismatch_micro_usd" double precision;--> statement-breakpoint
ALTER TABLE "cost_reconciliation_runs" ADD COLUMN "tracked_micro_usd" double precision;