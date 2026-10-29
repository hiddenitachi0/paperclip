-- DUR-5024: every test-network wallet remembers, from creation on, which
-- test network it lives on, so a later change of a default can never move it.
--
--   * crypto_wallets.network_variant: Bitcoin test wallets only,
--     'testnet4' | 'signet'. NULL for every other wallet.
--   * crypto_wallets.evm_chain_id: Ethereum test wallets only (signing and the
--     eth_chainId check use it; the code allow-list TEST_EVM_CHAIN_IDS still
--     applies at signing time). NULL for every other wallet.
--
-- Backfill (before the CHECKs, in the same migration): existing Bitcoin
-- test wallets become 'testnet4' (the only Bitcoin test network they could
-- have been on) and existing Ethereum test wallets become 11155111 (Sepolia).
-- Mainnet, Solana and Hyperliquid rows stay NULL. No other column and no row
-- count changes; nothing is deleted.
--
-- Both columns are fixed at creation: a BEFORE UPDATE trigger refuses any
-- change, so not even a future code path can move a wallet to another chain.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: old code ignores both columns and still signs for Sepolia /
-- accepts testnet4 and signet on a 'testnet' wallet; wallets created on
-- signet or Hoodi in the meantime would then be read as testnet4 / Sepolia, so
-- roll back only before any such wallet exists, or archive them first):
--   DROP TRIGGER IF EXISTS crypto_wallets_network_fixed ON "crypto_wallets";
--   DROP FUNCTION IF EXISTS enforce_crypto_wallet_network_fixed();
--   ALTER TABLE "crypto_wallets" DROP CONSTRAINT IF EXISTS "crypto_wallets_network_variant_check",
--     DROP CONSTRAINT IF EXISTS "crypto_wallets_evm_chain_id_check",
--     DROP COLUMN IF EXISTS "network_variant", DROP COLUMN IF EXISTS "evm_chain_id";
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "network_variant" text;--> statement-breakpoint
ALTER TABLE "crypto_wallets" ADD COLUMN IF NOT EXISTS "evm_chain_id" integer;--> statement-breakpoint
UPDATE "crypto_wallets" SET "network_variant" = 'testnet4' WHERE "chain" = 'bitcoin' AND "network" = 'testnet' AND "network_variant" IS NULL;--> statement-breakpoint
UPDATE "crypto_wallets" SET "evm_chain_id" = 11155111 WHERE "chain" = 'ethereum' AND "network" = 'testnet' AND "evm_chain_id" IS NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_network_variant_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_network_variant_check" CHECK (("crypto_wallets"."chain" = 'bitcoin' AND "crypto_wallets"."network" = 'testnet') = ("crypto_wallets"."network_variant" IS NOT NULL) AND ("crypto_wallets"."network_variant" IS NULL OR "crypto_wallets"."network_variant" IN ('testnet4', 'signet')));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_wallets_evm_chain_id_check') THEN
    ALTER TABLE "crypto_wallets" ADD CONSTRAINT "crypto_wallets_evm_chain_id_check" CHECK (("crypto_wallets"."chain" = 'ethereum' AND "crypto_wallets"."network" = 'testnet') = ("crypto_wallets"."evm_chain_id" IS NOT NULL) AND ("crypto_wallets"."evm_chain_id" IS NULL OR "crypto_wallets"."evm_chain_id" > 0));
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_crypto_wallet_network_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW.network_variant IS DISTINCT FROM OLD.network_variant OR NEW.evm_chain_id IS DISTINCT FROM OLD.evm_chain_id THEN
    RAISE EXCEPTION 'crypto_wallets.network_variant and crypto_wallets.evm_chain_id are fixed at creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS crypto_wallets_network_fixed ON "crypto_wallets";
--> statement-breakpoint
CREATE TRIGGER crypto_wallets_network_fixed
  BEFORE UPDATE OF network_variant, evm_chain_id ON "crypto_wallets"
  FOR EACH ROW EXECUTE FUNCTION enforce_crypto_wallet_network_fixed();
