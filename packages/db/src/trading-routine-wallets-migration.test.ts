import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0262_trading_routine_wallets (DUR-5026) applies on the
 * embedded-Postgres path (every migration, in journal order), leaves an
 * existing agent wallet exactly as it was (holder 'agent', every new column
 * empty), makes the database itself refuse a code-held wallet on a main
 * network or with an agent, is safe to run twice, and rolls back without
 * losing agent wallets.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0262 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0262_trading_routine_wallets";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));

type Row = Record<string, unknown>;

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d(`migration ${MIGRATION_TAG}`, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let secretId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0262-trading-wallets-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    secretId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRW')`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, role) VALUES (${agentId}, ${companyId}, 'Buyer', 'engineer')`);
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, key, name, kind) VALUES (${secretId}, ${companyId}, 'k', 'k', 'crypto_wallet_key')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function insertWallet(extra: { holder?: string; network?: string; agent?: string | null; maxBalance?: number | null; lossStop?: number | null } = {}): Promise<string> {
    const id = randomUUID();
    const holder = extra.holder ?? "agent";
    const agent = extra.agent === undefined ? agentId : extra.agent;
    await db.execute(sql`
      INSERT INTO crypto_wallets (id, company_id, agent_id, chain, network, address, secret_id, key_origin, label, per_transaction_limit, daily_limit, total_limit, holder, max_balance, daily_loss_stop)
      VALUES (${id}, ${companyId}, ${agent}, 'solana', ${extra.network ?? "testnet"}, ${`addr-${id}`}, ${secretId}, 'generated', 'W', 1, 2, 3, ${holder}, ${extra.maxBalance ?? null}, ${extra.lossStop ?? null})`);
    return id;
  }

  it("gives a wallet written the old way holder 'agent' and no routine settings", async () => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO crypto_wallets (id, company_id, agent_id, chain, network, address, secret_id, key_origin, label, per_transaction_limit, daily_limit, total_limit)
      VALUES (${id}, ${companyId}, ${agentId}, 'solana', 'testnet', ${`addr-${id}`}, ${secretId}, 'generated', 'Old', 1, 2, 3)`);
    const [row] = await rows(sql`SELECT holder, max_balance, daily_loss_stop, sweep_address, pending_sweep_address, top_up_floor, loss_day FROM crypto_wallets WHERE id = ${id}`);
    expect(row).toEqual({ holder: "agent", max_balance: null, daily_loss_stop: null, sweep_address: null, pending_sweep_address: null, top_up_floor: null, loss_day: null });
  });

  it("accepts a code-held wallet only on the test network, with no agent and both hard stops", async () => {
    await expect(insertWallet({ holder: "trading_routine", agent: null, maxBalance: 5, lossStop: 1 })).resolves.toBeTruthy();
    await expect(insertWallet({ holder: "trading_routine", agent: null, network: "mainnet", maxBalance: 5, lossStop: 1 })).rejects.toThrow();
    await expect(insertWallet({ holder: "trading_routine", agent: agentId, maxBalance: 5, lossStop: 1 })).rejects.toThrow();
    await expect(insertWallet({ holder: "trading_routine", agent: null, maxBalance: null, lossStop: 1 })).rejects.toThrow();
    await expect(insertWallet({ holder: "trading_routine", agent: null, maxBalance: 5, lossStop: null })).rejects.toThrow();
    await expect(insertWallet({ holder: "somebody_else", agent: null, maxBalance: 5, lossStop: 1 })).rejects.toThrow();
    await expect(insertWallet({ holder: "agent", network: "mainnet" })).resolves.toBeTruthy();
  });

  it("allows 'routine' as an initiator and a sweep or trade as its action, and nothing else", async () => {
    const walletId = await insertWallet({ holder: "trading_routine", agent: null, maxBalance: 5, lossStop: 1 });
    const insertTx = (initiatedBy: string, action: string | null) =>
      db.execute(sql`
        INSERT INTO crypto_wallet_transactions (company_id, wallet_id, initiated_by, kind, chain, network, asset, amount, purpose, status, routine_action)
        VALUES (${companyId}, ${walletId}, ${initiatedBy}, 'send', 'solana', 'testnet', 'SOL', 1, 'p', 'blocked', ${action})`);
    await expect(insertTx("routine", "sweep")).resolves.toBeDefined();
    await expect(insertTx("routine", "trade")).resolves.toBeDefined();
    await expect(insertTx("owner", null)).resolves.toBeDefined();
    await expect(insertTx("routine", "steal")).rejects.toThrow();
    await expect(insertTx("robot", null)).rejects.toThrow();
  });

  it("is safe to run twice and keeps existing rows untouched", async () => {
    const [before] = await rows(sql`SELECT count(*)::int AS n FROM crypto_wallets`);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [after] = await rows(sql`SELECT count(*)::int AS n FROM crypto_wallets`);
    expect(after?.n).toBe(before?.n);
  });

  it("rolls back as documented, without losing agent wallets, and re-applies cleanly", async () => {
    await db.execute(sql`DELETE FROM crypto_wallet_transactions WHERE initiated_by = 'routine'`);
    await db.execute(sql`DELETE FROM crypto_wallets WHERE holder = 'trading_routine'`);
    await db.execute(sql`DROP TABLE trading_alerts`);
    await db.execute(sql`
      ALTER TABLE crypto_wallets
        DROP CONSTRAINT crypto_wallets_holder_check, DROP CONSTRAINT crypto_wallets_routine_shape_check, DROP CONSTRAINT crypto_wallets_routine_amounts_check,
        DROP COLUMN holder, DROP COLUMN max_balance, DROP COLUMN daily_loss_stop, DROP COLUMN sweep_threshold, DROP COLUMN top_up_floor, DROP COLUMN top_up_target,
        DROP COLUMN sweep_address, DROP COLUMN sweep_address_approved_at, DROP COLUMN pending_sweep_address, DROP COLUMN pending_sweep_approval_id,
        DROP COLUMN top_up_approval_id, DROP COLUMN loss_day, DROP COLUMN loss_day_peak`);
    await db.execute(sql`ALTER TABLE crypto_wallet_transactions DROP CONSTRAINT crypto_wallet_transactions_routine_action_check, DROP COLUMN routine_action`);
    await db.execute(sql`ALTER TABLE crypto_wallet_transactions DROP CONSTRAINT crypto_wallet_transactions_initiated_by_check`);
    await db.execute(sql`ALTER TABLE crypto_wallet_transactions ADD CONSTRAINT crypto_wallet_transactions_initiated_by_check CHECK (initiated_by IN ('agent', 'owner'))`);
    await db.execute(sql`ALTER TABLE company_crypto_settings DROP COLUMN trader_agent_id`);
    const [agentWallets] = await rows(sql`SELECT count(*)::int AS n FROM crypto_wallets WHERE agent_id IS NOT NULL`);
    expect(agentWallets?.n).toBeGreaterThan(0);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [holders] = await rows(sql`SELECT count(*)::int AS n FROM crypto_wallets WHERE holder = 'agent'`);
    expect(holders?.n).toBe(agentWallets?.n);
  });
});
