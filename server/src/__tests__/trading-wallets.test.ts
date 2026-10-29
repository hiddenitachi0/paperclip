import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyCryptoSettings,
  createDb,
  cryptoWalletDestinations,
  cryptoWallets,
  cryptoWalletTransactions,
  tradingAlerts,
  tradingLedgerEntries,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { base58Decode, base58Encode } from "../services/crypto-wallet-encoding.ts";
import {
  solanaAdapter,
  type ChainContext,
  type CryptoChainAdapter,
  type CryptoChainAdapters,
  type HyperliquidAdapter,
} from "../services/crypto-wallet-chains.ts";
import type { OutboundFetch } from "../services/safe-outbound-fetch.ts";
import type { CryptoPriceSource } from "../services/crypto-wallets.ts";

/**
 * Trading wallets held by code (DUR-5026), end to end over HTTP with a real
 * database and a real secrets store, and only mocked networks (a fake Solana
 * JSON-RPC for the real Solana signer, a fake Hyperliquid for orders). The
 * server-wide real-money lock is left ON for the whole file: everything here
 * is test-network only and must work with it closed.
 *
 * Covered: key never in any response/log/ledger/activity/card/alert; no agent
 * can see or use a code-held wallet; the Trader can only list and ask for a
 * top-up and can never hold a wallet; sends to non-allow-listed addresses are
 * refused; max balance, daily loss stop, per-trade and daily caps trip and
 * pause the wallet with an alert; profit sweep (first sweep and address
 * changes need the owner's card; only to the approved address); top-up cards;
 * test networks only.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping trading wallet tests: ${support.reason ?? "unsupported environment"}`);

type MembershipRole = "owner" | "admin" | "operator" | "viewer";

interface FakeSolanaState {
  balances: Map<string, number>;
  sent: Array<{ signature: string; raw: string }>;
  statuses: Map<string, { confirmationStatus: string; err: unknown } | null>;
  calls: string[];
  genesis: string;
  blockHeight: number;
  /** "accept-then-502": the node takes the transaction, then the load balancer answers 502. */
  sendMode: "ok" | "accept-then-502" | "already-processed";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function fakeSolanaRpc(state: FakeSolanaState): OutboundFetch {
  const blockhash = base58Encode(new Uint8Array(randomBytes(32)));
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    state.calls.push(body.method);
    switch (body.method) {
      case "getGenesisHash":
        return json({ result: state.genesis });
      case "getBalance":
        return json({ result: { value: state.balances.get(body.params[0]) ?? 0 } });
      case "getLatestBlockhash":
        return json({ result: { value: { blockhash, lastValidBlockHeight: state.blockHeight + 150 } } });
      case "getBlockHeight":
        return json({ result: state.blockHeight });
      case "sendTransaction": {
        const tx = Buffer.from(body.params[0], "base64");
        const signature = base58Encode(new Uint8Array(tx.subarray(1, 65)));
        state.sent.push({ signature, raw: body.params[0] });
        if (!state.statuses.has(signature)) state.statuses.set(signature, null);
        if (state.sendMode === "accept-then-502") return new Response("bad gateway", { status: 502 });
        if (state.sendMode === "already-processed") return json({ error: { code: -32002, message: "Transaction simulation failed: This transaction has already been processed" } });
        return json({ result: signature });
      }
      case "getSignatureStatuses":
        return json({ result: { value: [state.statuses.get(body.params[0][0]) ?? null] } });
      default:
        return json({ error: { message: `unexpected ${body.method}` } });
    }
  }) as unknown as OutboundFetch;
}

const randomSolAddress = () => base58Encode(new Uint8Array(randomBytes(32)));

/** A stand-in for chains whose real signer needs libraries tests do not install. Never touches a network. */
function inertAdapter(chain: "bitcoin" | "ethereum"): CryptoChainAdapter {
  const refuse = async () => {
    throw new Error(`${chain} is not used in these tests`);
  };
  return {
    chain,
    generateKey: refuse,
    importKey: refuse,
    deriveAddress: refuse,
    validateAddress: async () => null,
    getBalance: refuse,
    estimateFee: refuse,
    signTransfer: refuse,
    broadcast: refuse,
    getTxStatus: refuse,
  } as CryptoChainAdapter;
}

interface FakeHyperliquid extends HyperliquidAdapter {
  orders: Array<{ coin: string; isBuy: boolean; size: string; leverage: number; reduceOnly: boolean; keySeen: boolean }>;
  leverageCalls: number;
  broadcasts: number;
  broadcastMode: "ok" | "unclear";
  statusAnswer: "unknown" | "failed" | "confirmed";
  state: { accountValueUsd: number; positionsValueUsd: number };
}

function fakeHyperliquid(): FakeHyperliquid {
  const keys = new Map<string, string>(); // privateKey -> address, in memory only
  const orders: FakeHyperliquid["orders"] = [];
  const state = { accountValueUsd: 100, positionsValueUsd: 0 };
  // eslint-disable-next-line prefer-const
  let fake!: FakeHyperliquid;
  const addressOf = (key: string) => `0x${Buffer.from(key).toString("hex").slice(0, 40).padEnd(40, "0")}`;
  fake = {
    chain: "hyperliquid",
    orders,
    leverageCalls: 0,
    broadcasts: 0,
    broadcastMode: "ok",
    statusAnswer: "unknown",
    state,
    async generateKey() {
      const privateKey = randomBytes(32).toString("hex");
      keys.set(privateKey, addressOf(privateKey));
      return { privateKey, address: addressOf(privateKey) };
    },
    async importKey(raw) {
      return { privateKey: raw, address: addressOf(raw) };
    },
    async deriveAddress(privateKey) {
      return addressOf(privateKey);
    },
    async validateAddress(address) {
      return /^0x[0-9a-f]{40}$/.test(address.toLowerCase()) ? address.toLowerCase() : null;
    },
    async getBalance() {
      return { balance: BigInt(Math.round(state.accountValueUsd * 1e6)), withdrawable: 0n };
    },
    async estimateFee() {
      return 1_000_000n;
    },
    async signTransfer(_ctx, input) {
      return { raw: JSON.stringify({ action: { type: "withdraw3" } }), txHash: `hyperliquid-withdraw-${input.amount}`, feeUpperBound: 1_000_000n };
    },
    async broadcast(_ctx, signed) {
      fake.broadcasts++;
      if (fake.broadcastMode === "unclear") throw new Error("socket hang up");
      const parsed = JSON.parse(signed.raw) as { action: { type: string }; order?: FakeHyperliquid["orders"][number] };
      if (parsed.action.type === "order" && parsed.order) orders.push(parsed.order);
      return { status: "confirmed", detail: "Filled." };
    },
    async getTxStatus() {
      return fake.statusAnswer;
    },
    async midPrice() {
      return 100;
    },
    async accountState() {
      return { accountValueUsd: state.accountValueUsd, withdrawableUsd: state.accountValueUsd, positions: state.positionsValueUsd ? [{ coin: "BTC", size: 1, positionValueUsd: state.positionsValueUsd }] : [] };
    },
    async signOrder(_ctx: ChainContext, input) {
      const order = { coin: input.coin, isBuy: input.isBuy, size: input.size, leverage: input.leverage, reduceOnly: input.reduceOnly, keySeen: input.privateKey.length > 0 };
      return {
        leverageRaw: JSON.stringify({ action: { type: "updateLeverage", leverage: input.leverage } }),
        order: { raw: JSON.stringify({ action: { type: "order" }, order }), txHash: `hyperliquid-order-${randomUUID()}`, feeUpperBound: 0n },
      };
    },
    async applyLeverage() {
      fake.leverageCalls++;
    },
  };
  return fake;
}


d("trading wallets held by code", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  let cryptoWalletRoutes!: typeof import("../routes/crypto-wallets.js").cryptoWalletRoutes;
  let approvalRoutes!: typeof import("../routes/approvals.js").approvalRoutes;
  let cryptoWalletService!: typeof import("../services/crypto-wallets.js").cryptoWalletService;
  let errorHandler!: typeof import("../middleware/index.js").errorHandler;
  let logger!: typeof import("../middleware/logger.js").logger;
  let secretService!: typeof import("../services/secrets.js").secretService;
  let approvalService!: typeof import("../services/approvals.js").approvalService;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousRealMoney = process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
  const tmpDir = path.join(os.tmpdir(), `paperclip-trading-wallets-${randomUUID()}`);

  let solState: FakeSolanaState;
  let hl: FakeHyperliquid;
  let adapters: CryptoChainAdapters;
  const priceSource: CryptoPriceSource = { usdPrice: async (chain) => (chain === "hyperliquid" ? 1 : 100) };
  let now = new Date("2026-10-29T10:00:00Z");
  const responses: string[] = [];
  const logLines: string[] = [];

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    // The server-wide real-money lock stays ON (variable absent) for this whole file.
    delete process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("trading-wallets");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    ({ cryptoWalletRoutes } = await import("../routes/crypto-wallets.js"));
    ({ approvalRoutes } = await import("../routes/approvals.js"));
    ({ cryptoWalletService } = await import("../services/crypto-wallets.js"));
    ({ errorHandler } = await import("../middleware/index.js"));
    ({ logger } = await import("../middleware/logger.js"));
    ({ secretService } = await import("../services/secrets.js"));
    ({ approvalService } = await import("../services/approvals.js"));
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logLines.push(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      }) as never);
    }
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await stopDb?.();
    rmSync(tmpDir, { recursive: true, force: true });
    if (previousRealMoney === undefined) delete process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
    else process.env.PAPERCLIP_CRYPTO_REAL_MONEY = previousRealMoney;
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
  });

  beforeEach(async () => {
    if (db) {
      // The tick is instance-wide: park every earlier test's wallets and settle their payments.
      await db.update(cryptoWallets).set({ status: "archived" }).where(eq(cryptoWallets.holder, "trading_routine"));
      await db
        .update(cryptoWalletTransactions)
        .set({ status: "confirmed" })
        .where(inArray(cryptoWalletTransactions.status, ["pending_approval", "approved", "submitted"]));
    }
    solState = { balances: new Map(), sent: [], statuses: new Map(), calls: [], genesis: DEVNET_GENESIS, blockHeight: 1_000, sendMode: "ok" };
    hl = fakeHyperliquid();
    adapters = { bitcoin: inertAdapter("bitcoin"), ethereum: inertAdapter("ethereum"), solana: solanaAdapter(), hyperliquid: hl };
    now = new Date("2026-10-29T10:00:00Z");
  });

  function deps() {
    // The watch interval is 0 here so that every tick looks; its own test sets a real one.
    return { adapters, priceSource, now: () => now, fetchFor: () => fakeSolanaRpc(solState), tradingWatchIntervalMs: 0 };
  }

  function actorFor(companyId: string, role: MembershipRole, userId = randomUUID()) {
    return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }],
      };
      next();
    };
  }

  function boardApp(companyId: string, role: MembershipRole) {
    const app = express();
    app.use(express.json());
    app.use(actorFor(companyId, role));
    app.use("/api", cryptoWalletRoutes(db, deps()));
    app.use(errorHandler);
    return wrap(app);
  }

  /** The approvals routes, mounted for real, to prove who may answer each card. */
  function approvalsApp(companyId: string, role: MembershipRole) {
    const app = express();
    app.use(express.json());
    app.use(actorFor(companyId, role));
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    return wrap(app);
  }

  function agentApp(companyId: string, agentId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_jwt", agentId, companyId, runId: randomUUID() };
      next();
    });
    app.use("/api", cryptoWalletRoutes(db, deps()));
    app.use(errorHandler);
    return wrap(app);
  }

  function wrap(app: express.Express) {
    const record = async (pending: request.Test) => {
      const res = await pending;
      responses.push(res.text ?? "");
      return res;
    };
    return {
      get: (url: string) => record(request(app).get(url)),
      post: (url: string, body: unknown = {}) => record(request(app).post(url).send(body as object)),
      patch: (url: string, body: unknown) => record(request(app).patch(url).send(body as object)),
      put: (url: string, body: unknown) => record(request(app).put(url).send(body as object)),
    };
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Trading Co ${companyId.slice(0, 6)}`, issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    const buyerId = randomUUID();
    const traderId = randomUUID();
    await db.insert(agents).values({ id: buyerId, companyId, name: "Buyer agent", role: "engineer" });
    await db.insert(agents).values({ id: traderId, companyId, name: "Trader", role: "engineer" });
    return { companyId, buyerId, traderId };
  }

  const solLimits = (extra: Record<string, unknown> = {}) => ({
    perTrade: "0.2",
    daily: "0.4",
    total: "10",
    maxBalance: "5",
    dailyLossStop: "0.5",
    sweepThreshold: "1",
    topUpFloor: "0.3",
    topUpTarget: "0.8",
    ...extra,
  });

  async function makeSolWallet(companyId: string, extra: Record<string, unknown> = {}) {
    const res = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "solana", label: "Sol trading", limits: solLimits(), ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; address: string };
  }

  async function makeHlWallet(companyId: string, limits?: Record<string, unknown>) {
    const res = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "hyperliquid", label: "HL trading", ...(limits ? { limits } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; address: string };
  }

  const sol = (n: number) => Math.round(n * 1_000_000_000);
  const svc = () => cryptoWalletService(db, db, deps());
  const alertsOf = async (companyId: string) => (await db.select().from(tradingAlerts).where(eq(tradingAlerts.companyId, companyId))).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const walletRow = async (id: string) => (await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, id)))[0]!;
  const txsOf = async (walletId: string) => db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.walletId, walletId));
  const order = (size: string, extra: Record<string, unknown> = {}) => ({ coin: "BTC", side: "buy" as const, size, limitPrice: "100", reduceOnly: false, purpose: "Paper strategy signal", ...extra });

  // ─── Held by code: key, owner, network ─────────────────────────────────

  it("makes a wallet the server holds: owner only, test network only, no agent, key only in the secrets store", async () => {
    const { companyId, buyerId } = await seed();
    const owner = boardApp(companyId, "owner");

    expect((await boardApp(companyId, "admin").post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "solana", label: "x" })).status).toBe(403);
    // The body has no way to pick a network, an agent, a mode or a key.
    for (const extra of [{ network: "mainnet" }, { network: "testnet" }, { agentId: buyerId }, { mode: "import", privateKey: "abc" }, { privateKey: "abc" }]) {
      expect((await owner.post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "solana", label: "x", ...extra })).status, JSON.stringify(extra)).toBe(400);
    }

    const created = await makeSolWallet(companyId);
    const body = (await owner.get(`/api/companies/${companyId}/crypto/wallets/${created.id}`)).body;
    expect(body).toMatchObject({
      holder: "trading_routine",
      agentId: null,
      network: "testnet",
      keyOrigin: "generated",
      status: "active",
      trading: { maxBalance: "5", dailyLossStop: "0.5", sweepThreshold: "1", topUpFloor: "0.3", topUpTarget: "0.8", sweepAddress: null, pendingSweepAddress: null },
    });
    expect(body).not.toHaveProperty("secretId");
    const row = await walletRow(created.id);
    expect(row.agentId).toBeNull();
    const { companySecrets } = await import("@paperclipai/db");
    const [secretRow] = await db.select().from(companySecrets).where(eq(companySecrets.id, row.secretId));
    expect(secretRow!.kind).toBe("crypto_wallet_key");

    // Creating it needed no real-money switch: the server-wide lock is still on.
    const { isCryptoRealMoneyAllowed } = await import("../services/crypto-real-money-lock.js");
    expect(isCryptoRealMoneyAllowed()).toBe(false);

    // The database itself refuses a code-held wallet on a main network, or with an agent.
    await expect(db.update(cryptoWallets).set({ network: "mainnet" }).where(eq(cryptoWallets.id, created.id))).rejects.toThrow();
    await expect(db.update(cryptoWallets).set({ agentId: buyerId }).where(eq(cryptoWallets.id, created.id))).rejects.toThrow();
    // Default limits are applied when none are given, and bad ones are refused.
    const defaults = await owner.post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "hyperliquid", label: "Defaults" });
    expect(defaults.body.trading).toMatchObject({ maxBalance: "200", dailyLossStop: "10" });
    expect((await owner.post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "solana", label: "Too big", limits: solLimits({ maxBalance: "50" }) })).status).toBe(422);
  });

  it("fixes the test network of a Bitcoin and an Ethereum trading wallet at creation, as the database requires (DUR-5024)", async () => {
    const { companyId } = await seed();
    const owner = boardApp(companyId, "owner");
    // The inert Bitcoin / Ethereum adapters refuse everything; these two can make a key.
    adapters.bitcoin = { ...inertAdapter("bitcoin"), generateKey: async () => ({ privateKey: "btc-test-key", address: "tb1qtradingwalletbitcoin0000000000000000" }) } as CryptoChainAdapter;
    adapters.ethereum = { ...inertAdapter("ethereum"), generateKey: async () => ({ privateKey: "0xeth-test-key", address: "0x00000000000000000000000000000000000000aa" }) } as CryptoChainAdapter;
    const btc = await owner.post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "bitcoin", label: "BTC trader" });
    expect(btc.status, JSON.stringify(btc.body)).toBe(201);
    const eth = await owner.post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "ethereum", label: "ETH trader" });
    expect(eth.status).toBe(201);
    const sol = await owner.post(`/api/companies/${companyId}/crypto/trading-wallets`, { chain: "solana", label: "SOL trader" });
    expect(sol.status).toBe(201);
    expect(await walletRow(btc.body.id)).toMatchObject({ network: "testnet", networkVariant: "signet", evmChainId: null });
    expect(await walletRow(eth.body.id)).toMatchObject({ network: "testnet", networkVariant: null, evmChainId: 11155111 });
    expect(await walletRow(sol.body.id)).toMatchObject({ network: "testnet", networkVariant: null, evmChainId: null });
  });

  it("keeps the key out of every response, log line, ledger row, activity row, approval card, alert and transaction", async () => {
    const { companyId } = await seed();
    const owner = boardApp(companyId, "owner");
    responses.length = 0;
    logLines.length = 0;
    const wallet = await makeSolWallet(companyId);
    const row = await walletRow(wallet.id);
    const key = await secretService(db).resolveSecretValueForWalletSigning(companyId, row.secretId, { walletId: wallet.id, actorType: "system", actorId: "test" });
    expect(key.length).toBeGreaterThan(20);

    // Exercise every surface: reads, limits, a pause, a sweep with its cards, a top-up, an owner send.
    const cold = randomSolAddress();
    expect((await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: cold })).status).toBe(202);
    const pendingCard = (await walletRow(wallet.id)).pendingSweepApprovalId!;
    await db.update(approvals).set({ status: "approved", decidedByUserId: "owner-user" }).where(eq(approvals.id, pendingCard));
    solState.balances.set(wallet.address, sol(2));
    await svc().tick(now);
    await owner.get(`/api/companies/${companyId}/crypto/wallets`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/balance`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/transactions`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/ledger`);
    await owner.put(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/limits`, { limits: solLimits({ sweepThreshold: "1.2" }) });
    await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to: cold, amount: "0.1", purpose: "Back out" });
    solState.balances.set(wallet.address, sol(0.1));
    await svc().tick(now);
    await owner.get(`/api/companies/${companyId}/trading-alerts-outbox`);
    expect(await alertsOf(companyId)).not.toHaveLength(0);

    const haystacks = {
      responses: responses.join("\n"),
      logs: logLines.join("\n"),
      ledger: JSON.stringify(await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.companyId, companyId))),
      activity: JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))),
      approvals: JSON.stringify(await db.select().from(approvals).where(eq(approvals.companyId, companyId))),
      transactions: JSON.stringify(await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.companyId, companyId))),
      alerts: JSON.stringify(await alertsOf(companyId)),
      broadcast: JSON.stringify(solState.sent),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of [key, row.secretId]) {
        expect(text.includes(needle), `${where} must not contain the key or the secret id`).toBe(false);
      }
    }
  });

  // ─── No agent can see or use it ────────────────────────────────────────

  it("hides code-held wallets from every agent, lets the Trader only list and ask for a top-up, and never lets the Trader hold a wallet", async () => {
    const { companyId, buyerId, traderId } = await seed();
    const owner = boardApp(companyId, "owner");
    const wallet = await makeSolWallet(companyId);
    solState.balances.set(wallet.address, sol(2));

    // An ordinary agent sees nothing and can use nothing.
    const buyer = agentApp(companyId, buyerId);
    expect((await buyer.get("/api/agent-wallets")).body).toEqual([]);
    for (const [method, url, body] of [
      ["get", `/api/agent-wallets/${wallet.id}/balance`, undefined],
      ["get", `/api/agent-wallets/${wallet.id}/destinations`, undefined],
      ["post", `/api/agent-wallets/${wallet.id}/quote`, { amount: "0.1" }],
      ["post", `/api/agent-wallets/${wallet.id}/send`, { to: randomSolAddress(), amount: "0.1", purpose: "Steal it" }],
      ["post", `/api/agent-wallets/${wallet.id}/hyperliquid-order`, { coin: "BTC", side: "buy", size: "1", limitPrice: "100", purpose: "Trade" }],
    ] as const) {
      const res = method === "get" ? await buyer.get(url) : await buyer.post(url, body);
      expect(res.status, url).toBe(404);
    }
    expect((await buyer.get("/api/agent-wallets/trading")).status).toBe(403);
    expect((await buyer.post(`/api/agent-wallets/trading/${wallet.id}/top-up-request`, { reason: "I want it" })).status).toBe(403);
    expect(solState.sent).toHaveLength(0);

    // The owner cannot hand a code-held wallet to an agent.
    const handOver = await owner.patch(`/api/companies/${companyId}/crypto/wallets/${wallet.id}`, { agentId: buyerId });
    expect(handOver.status).toBe(422);
    expect(handOver.body.error).toMatch(/can never be given to an agent/);
    expect((await owner.patch(`/api/companies/${companyId}/crypto/wallets/${wallet.id}`, { limits: { perTransaction: "9", daily: "9", total: "9", approvalAbove: null } })).status).toBe(422);

    // Naming the Trader: owner only; an agent that holds a wallet cannot be the Trader.
    expect((await boardApp(companyId, "admin").patch(`/api/companies/${companyId}/crypto/settings`, { traderAgentId: traderId })).status).toBe(403);
    const holder = (await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId: buyerId, chain: "solana", label: "Buyer's", mode: "generate" })).body as { id: string };
    const refused = await owner.patch(`/api/companies/${companyId}/crypto/settings`, { traderAgentId: buyerId });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/holds a wallet, so it cannot be the Trader/);
    const named = await owner.patch(`/api/companies/${companyId}/crypto/settings`, { traderAgentId: traderId });
    expect(named.status).toBe(200);
    expect(named.body.traderAgentId).toBe(traderId);
    // ...and once named, the Trader can never be given a wallet, by creation or by handing one over.
    const toTrader = await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId: traderId, chain: "solana", label: "Trader's", mode: "generate" });
    expect(toTrader.status).toBe(422);
    expect(toTrader.body.error).toMatch(/The Trader never holds a wallet/);
    expect((await owner.patch(`/api/companies/${companyId}/crypto/wallets/${holder.id}`, { agentId: traderId })).status).toBe(422);
    expect((await owner.patch(`/api/companies/${companyId}/crypto/wallets/${wallet.id}`, { agentId: traderId })).status).toBe(422);

    // The Trader can list (no key, no secret id), but still cannot spend or read balances through the old tools.
    const trader = agentApp(companyId, traderId);
    const listed = await trader.get("/api/agent-wallets/trading");
    expect(listed.status).toBe(200);
    expect(listed.body.map((w: { id: string }) => w.id)).toEqual([wallet.id]);
    expect(listed.text).not.toMatch(/secretId|privateKey/);
    expect((await trader.get("/api/agent-wallets")).body).toEqual([]);
    expect((await trader.post(`/api/agent-wallets/${wallet.id}/send`, { to: randomSolAddress(), amount: "0.1", purpose: "Take it" })).status).toBe(404);
    expect((await trader.get(`/api/agent-wallets/${wallet.id}/balance`)).status).toBe(404);
    expect(solState.sent).toHaveLength(0);
  });

  // ─── Sends only to allow-listed addresses ──────────────────────────────

  it("refuses a send to an address that is not on the allow-list, and lets the owner send out to one that is", async () => {
    const { companyId } = await seed();
    const owner = boardApp(companyId, "owner");
    const wallet = await makeSolWallet(companyId);
    solState.balances.set(wallet.address, sol(0.5));

    const elsewhere = await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to: randomSolAddress(), amount: "0.1", purpose: "Somewhere else" });
    expect(elsewhere.body.status).toBe("blocked");
    expect(elsewhere.body.blockReason).toMatch(/not on this wallet's allowed list/);
    expect(solState.sent).toHaveLength(0);

    const own = randomSolAddress();
    expect((await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/destinations`, { address: own, label: "My own" })).status).toBe(201);
    const ok = await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to: own, amount: "0.1", purpose: "Back to me" });
    expect(ok.body.status).toBe("submitted");
    expect(solState.sent).toHaveLength(1);

    // Profit never leaves for anywhere without an approved cold-wallet address, however large the surplus.
    solState.balances.set(wallet.address, sol(3));
    await svc().tick(now);
    expect((await txsOf(wallet.id)).filter((t) => t.routineAction === "sweep")).toHaveLength(0);
  });

  // ─── Hard limits ───────────────────────────────────────────────────────

  it("pauses the wallet and queues a Telegram alert when the balance goes over the maximum", async () => {
    const { companyId } = await seed();
    const wallet = await makeHlWallet(companyId);
    hl.state.accountValueUsd = 250;
    await svc().tick(now);
    const row = await walletRow(wallet.id);
    expect(row.status).toBe("frozen");
    expect(row.frozenReason).toMatch(/Maximum balance exceeded/);
    const alerts = await alertsOf(companyId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "wallet_paused", status: "ready", walletId: wallet.id });
    expect(alerts[0]!.text).toMatch(/Safety stop.*HL trading.*paused/);
    const kills = (await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.walletId, wallet.id))).filter((e) => e.eventType === "wallet_kill_switch");
    expect(kills).toHaveLength(1);
    // A paused wallet takes no trade, and a second tick does not alert again.
    const blocked = await svc().routineHyperliquidOrder(companyId, wallet.id, order("0.1"));
    expect(blocked).toMatchObject({ status: "blocked" });
    expect(blocked.blockReason).toMatch(/frozen/);
    await svc().tick(now);
    expect(await alertsOf(companyId)).toHaveLength(1);
    expect(hl.orders).toHaveLength(0);
  });

  it("pauses the wallet at the daily loss stop, counted from the day's highest balance, and only the owner can start it again", async () => {
    const { companyId } = await seed();
    const wallet = await makeHlWallet(companyId); // loss stop $10
    hl.state.accountValueUsd = 100;
    await svc().tick(now);
    expect((await walletRow(wallet.id)).status).toBe("active");
    hl.state.accountValueUsd = 108; // a gain raises the bar
    await svc().tick(now);
    hl.state.accountValueUsd = 99.5; // down $8.5 from $108: still inside the stop
    await svc().tick(now);
    expect((await walletRow(wallet.id)).status).toBe("active");
    hl.state.accountValueUsd = 98; // down $10 from the day's high: the stop trips
    await svc().tick(now);
    const paused = await walletRow(wallet.id);
    expect(paused.status).toBe("frozen");
    expect(paused.frozenReason).toMatch(/Daily loss stop reached/);
    expect((await alertsOf(companyId)).map((a) => a.kind)).toEqual(["wallet_paused"]);

    // Only the owner starts it again, and the count starts from where it is, so it does not trip again at once.
    expect((await boardApp(companyId, "admin").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/freeze`, { frozen: false })).status).toBe(403);
    expect((await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/freeze`, { frozen: false })).body.status).toBe("active");
    await svc().tick(now);
    expect((await walletRow(wallet.id)).status).toBe("active");
    // A new UTC day also starts a new count.
    now = new Date("2026-10-30T10:00:00Z");
    await svc().tick(now);
    expect((await walletRow(wallet.id)).status).toBe("active");
  });

  it("refuses a trade over the per-trade cap, stops at the daily cap, never blocks an exit, and refuses everything when the balance cannot be read", async () => {
    const { companyId } = await seed();
    const wallet = await makeHlWallet(companyId); // per trade $25, per day $100
    hl.state.accountValueUsd = 100;
    const s = svc();

    const tooBig = await s.routineHyperliquidOrder(companyId, wallet.id, order("0.3")); // $30
    expect(tooBig).toMatchObject({ status: "blocked", initiatedBy: "routine", routineAction: "trade", agentId: null });
    expect(tooBig.blockReason).toMatch(/limit of .* per trade/);
    expect(hl.orders).toHaveLength(0);

    for (let i = 0; i < 4; i++) {
      const ok = await s.routineHyperliquidOrder(companyId, wallet.id, order("0.2")); // $20 each
      expect(ok.status, `trade ${i}`).toBe("confirmed");
    }
    expect(hl.orders).toHaveLength(4);
    expect(hl.orders.every((o) => o.leverage === 1)).toBe(true);
    const overDaily = await s.routineHyperliquidOrder(companyId, wallet.id, order("0.25")); // $25 -> $105 today
    expect(overDaily.status).toBe("blocked");
    expect(overDaily.blockReason).toMatch(/daily limit/);

    // Closing a position is never stopped by a spending cap.
    const exit = await s.routineHyperliquidOrder(companyId, wallet.id, order("0.9", { side: "sell", reduceOnly: true }));
    expect(exit.status).toBe("confirmed");
    expect(hl.orders).toHaveLength(5);

    // No approval card was ever involved in a trade.
    expect((await db.select().from(approvals).where(eq(approvals.companyId, companyId)))).toHaveLength(0);

    // Without a readable balance the hard stops cannot be applied: no new position.
    now = new Date("2026-10-30T10:00:00Z");
    const brokenBalance = hl.getBalance;
    hl.getBalance = async () => {
      throw new Error("exchange down");
    };
    const blind = await s.routineHyperliquidOrder(companyId, wallet.id, order("0.1"));
    expect(blind.status).toBe("blocked");
    expect(blind.blockReason).toMatch(/balance could not be checked/);
    hl.getBalance = brokenBalance;
    expect(hl.orders).toHaveLength(5);
  });

  it("pauses a Solana trading wallet and alerts when coins leave that Paperclip did not send", async () => {
    const { companyId } = await seed();
    const wallet = await makeSolWallet(companyId);
    solState.balances.set(wallet.address, sol(2));
    await svc().tick(now);
    expect((await walletRow(wallet.id)).status).toBe("active");
    solState.balances.set(wallet.address, sol(1.2));
    await svc().tick(now);
    expect((await walletRow(wallet.id)).status).toBe("frozen");
    const alerts = await alertsOf(companyId);
    expect(alerts.map((a) => a.kind)).toEqual(["wallet_paused"]);
    expect(alerts[0]!.text).toMatch(/left this wallet that Paperclip did not send/);
  });

  // ─── Profit sweep ──────────────────────────────────────────────────────

  it("sweeps surplus only to the owner's approved cold wallet; the first sweep and every address change need the owner's card", async () => {
    const { companyId } = await seed();
    const owner = boardApp(companyId, "owner");
    const wallet = await makeSolWallet(companyId); // sweep above 1 SOL
    const cold = randomSolAddress();
    const s = svc();

    // Only the owner can propose; the address is validated; nothing happens before the card is answered.
    expect((await boardApp(companyId, "admin").post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: cold })).status).toBe(403);
    expect((await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: "not an address" })).status).toBe(422);
    expect((await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: wallet.address })).status).toBe(422);
    const proposed = await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: cold });
    expect(proposed.status).toBe(202);
    expect(proposed.body.trading).toMatchObject({ sweepAddress: null, pendingSweepAddress: cold });
    const addressCard = (await walletRow(wallet.id)).pendingSweepApprovalId!;
    const [card] = await db.select().from(approvals).where(eq(approvals.id, addressCard));
    expect(card!.payload).toMatchObject({ kind: "crypto_sweep_address", newAddress: cold, oldAddress: null });

    solState.balances.set(wallet.address, sol(2));
    await s.tick(now);
    expect((await txsOf(wallet.id)).filter((t) => t.routineAction === "sweep")).toHaveLength(0);
    expect(solState.sent).toHaveLength(0);

    // The cold-wallet card can be answered only by the owner, through the real approvals route.
    const adminAnswer = await approvalsApp(companyId, "admin").post(`/api/approvals/${addressCard}/approve`, {});
    expect(adminAnswer.status).toBe(403);
    expect((await approvalsApp(companyId, "owner").post(`/api/approvals/${addressCard}/approve`, {})).status).toBe(200);

    // Approved: the address is in force, on the allow-list, and the first surplus waits for a sweep card.
    await s.tick(now);
    const afterApproval = await walletRow(wallet.id);
    expect(afterApproval).toMatchObject({ sweepAddress: cold, pendingSweepAddress: null, pendingSweepApprovalId: null });
    expect(afterApproval.sweepAddressApprovedAt).not.toBeNull();
    expect((await db.select().from(cryptoWalletDestinations).where(eq(cryptoWalletDestinations.walletId, wallet.id))).map((r) => r.address)).toEqual([cold]);
    const first = (await txsOf(wallet.id)).filter((t) => t.routineAction === "sweep");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "pending_approval", initiatedBy: "routine", destination: cold, kind: "send", countsTowardLimits: false, agentId: null });
    expect(first[0]!.amount).toBe(String(sol(1)));
    expect(solState.sent).toHaveLength(0);
    const [sweepCard] = await db.select().from(approvals).where(eq(approvals.id, first[0]!.approvalId!));
    expect(sweepCard!.payload).toMatchObject({ kind: "crypto_wallet_tx", routineAction: "sweep" });
    expect((await alertsOf(companyId)).map((a) => a.kind)).toContain("sweep_waiting_approval");

    // Another tick does not stack a second sweep on top of the waiting one.
    await s.tick(now);
    expect((await txsOf(wallet.id)).filter((t) => t.routineAction === "sweep")).toHaveLength(1);

    // An admin cannot approve the sweep (it is the owner's money decision); the owner can.
    expect((await approvalsApp(companyId, "admin").post(`/api/approvals/${first[0]!.approvalId}/approve`, {})).status).toBe(403);
    expect((await approvalsApp(companyId, "owner").post(`/api/approvals/${first[0]!.approvalId}/approve`, {})).status).toBe(200);
    await s.tick(now);
    expect(solState.sent).toHaveLength(1);
    const sentTx = Buffer.from(solState.sent[0]!.raw, "base64");
    // The recipient inside the signed transaction is the cold wallet.
    expect(sentTx.includes(Buffer.from(base58Decode(cold)))).toBe(true);
    solState.statuses.set(solState.sent[0]!.signature, { confirmationStatus: "confirmed", err: null });
    solState.balances.set(wallet.address, sol(1) - 5000);
    await s.tick(now);
    expect((await txsOf(wallet.id)).find((t) => t.id === first[0]!.id)!.status).toBe("confirmed");
    expect((await alertsOf(companyId)).map((a) => a.kind)).toContain("sweep_sent");
    expect((await walletRow(wallet.id)).status).toBe("active");

    // Later surplus goes straight out to the same approved address: no card this time.
    solState.balances.set(wallet.address, sol(1.6));
    await s.tick(now);
    const second = (await txsOf(wallet.id)).filter((t) => t.routineAction === "sweep" && t.id !== first[0]!.id);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: "submitted", destination: cold });
    expect(solState.sent).toHaveLength(2);
    solState.statuses.set(solState.sent[1]!.signature, { confirmationStatus: "confirmed", err: null });
    solState.balances.set(wallet.address, sol(1) - 10_000);
    await s.tick(now);

    // Changing the address needs a new card; until it is approved, the old address stays in force.
    const other = randomSolAddress();
    await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: other });
    const changeCard = (await walletRow(wallet.id)).pendingSweepApprovalId!;
    expect((await walletRow(wallet.id)).sweepAddress).toBe(cold);
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, changeCard));
    await s.tick(now);
    expect(await walletRow(wallet.id)).toMatchObject({ sweepAddress: cold, pendingSweepAddress: null });

    await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: other });
    const secondChange = (await walletRow(wallet.id)).pendingSweepApprovalId!;
    await db.update(approvals).set({ status: "approved", decidedByUserId: "owner-user" }).where(eq(approvals.id, secondChange));
    solState.balances.set(wallet.address, sol(1.5));
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    await s.tick(now);
    expect(await walletRow(wallet.id)).toMatchObject({ sweepAddress: other, pendingSweepAddress: null });
    // The old cold wallet left the allow-list, and the first sweep to the new one waits for a card again.
    expect((await db.select().from(cryptoWalletDestinations).where(eq(cryptoWalletDestinations.walletId, wallet.id))).map((r) => r.address)).toEqual([other]);
    const toNew = (await txsOf(wallet.id)).filter((t) => t.destination === other && t.routineAction === "sweep");
    expect(toNew).toHaveLength(1);
    expect(toNew[0]!.status).toBe("pending_approval");

    // A sweep card approved after the address changed again sends nothing.
    const third = randomSolAddress();
    await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: third });
    await db.update(approvals).set({ status: "approved", decidedByUserId: "owner-user" }).where(eq(approvals.id, (await walletRow(wallet.id)).pendingSweepApprovalId!));
    const sentBefore = solState.sent.length;
    await s.tick(now);
    expect((await walletRow(wallet.id)).sweepAddress).toBe(third);
    // Only now does the owner answer the older sweep card, whose address is no longer the one in force.
    await db.update(approvals).set({ status: "approved", decidedByUserId: "owner-user" }).where(eq(approvals.id, toNew[0]!.approvalId!));
    await s.tick(now);
    const stale = (await txsOf(wallet.id)).find((t) => t.id === toNew[0]!.id)!;
    expect(stale.status).toBe("blocked");
    expect(stale.blockReason).toMatch(/cold-wallet address changed/);
    expect(solState.sent.length).toBe(sentBefore);
  });

  it("does not let anyone file, or approve outside the approval card, the sweep-address and top-up cards", async () => {
    const { companyId } = await seed();
    for (const kind of ["crypto_sweep_address", "crypto_topup_request", "crypto_wallet_tx"]) {
      await expect(
        approvalService(db).create(companyId, { type: "request_board_approval", requestedByAgentId: null, status: "pending", payload: { kind, newAddress: randomSolAddress() } }),
      ).rejects.toThrow(/can only be filed by the wallet itself/);
    }
    const { isApprovalCardOnlyKind } = await import("../services/approvals.js");
    for (const kind of ["crypto_sweep_address", "crypto_topup_request"]) {
      expect(isApprovalCardOnlyKind({ type: "request_board_approval", payload: { kind } })).toBe(true);
    }
  });

  // ─── Top-up ────────────────────────────────────────────────────────────

  it("files a plain-language top-up card below the floor, once, with the amount and recent results, and the Trader can ask for one", async () => {
    const { companyId, buyerId, traderId } = await seed();
    const owner = boardApp(companyId, "owner");
    const wallet = await makeSolWallet(companyId); // floor 0.3, target 0.8
    await owner.patch(`/api/companies/${companyId}/crypto/settings`, { traderAgentId: traderId });
    const trader = agentApp(companyId, traderId);
    const s = svc();

    // Above the floor: nothing to ask, and the Trader cannot file one.
    solState.balances.set(wallet.address, sol(0.5));
    await s.tick(now);
    expect((await alertsOf(companyId))).toHaveLength(0);
    const early = await trader.post(`/api/agent-wallets/trading/${wallet.id}/top-up-request`, { reason: "Feeling low" });
    expect(early.status).toBe(422);
    expect(early.body.error).toMatch(/not below the floor/);
    // The wallet spends 0.4 (an owner send to an allowed address, which explains the drop), leaving it under the floor.
    const own = randomSolAddress();
    await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/destinations`, { address: own, label: "My own" });
    expect((await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to: own, amount: "0.4", purpose: "Move funds" })).body.status).toBe("submitted");
    solState.balances.set(wallet.address, sol(0.1));

    // Below the floor: the routine files one card with amount, address and results.
    now = new Date(now.getTime() + 10 * 60_000);
    await s.tick(now);
    const row = await walletRow(wallet.id);
    expect(row.topUpApprovalId).not.toBeNull();
    const [card] = await db.select().from(approvals).where(eq(approvals.id, row.topUpApprovalId!));
    expect(card!.status).toBe("pending");
    expect(card!.payload).toMatchObject({
      kind: "crypto_topup_request",
      walletId: wallet.id,
      address: wallet.address,
      asset: "SOL",
      suggestedAmount: "0.7 SOL",
      balance: "0.1 SOL",
      floor: "0.3 SOL",
      target: "0.8 SOL",
    });
    expect((card!.payload as { plainSummary: string }).plainSummary).toMatch(/send about 0\.7 SOL to .* back to 0\.8 SOL.*Why: The balance fell below the floor.*test coins with no value/);
    expect((card!.payload as { recentResults: string[] }).recentResults.join(" ")).toMatch(/Last 7 days: 0 trades placed/);
    expect((await alertsOf(companyId)).map((a) => a.kind)).toEqual(["top_up_requested"]);

    // One card at a time: another tick and the Trader's own request both return the open card.
    await s.tick(now);
    expect((await db.select().from(approvals).where(and(eq(approvals.companyId, companyId)))).filter((a) => (a.payload as { kind?: string }).kind === "crypto_topup_request")).toHaveLength(1);
    const again = await trader.post(`/api/agent-wallets/trading/${wallet.id}/top-up-request`, { reason: "Still low after yesterday's trades" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ approvalId: row.topUpApprovalId, created: false });
    // Only the Trader may ask; another agent may not.
    expect((await agentApp(companyId, buyerId).post(`/api/agent-wallets/trading/${wallet.id}/top-up-request`, { reason: "Me too" })).status).toBe(403);

    // The owner answers; the next ask waits a day, then a new card (by the Trader this time, with its reason).
    expect((await approvalsApp(companyId, "viewer").post(`/api/approvals/${row.topUpApprovalId}/approve`, {})).status).toBe(403);
    expect((await approvalsApp(companyId, "admin").post(`/api/approvals/${row.topUpApprovalId}/approve`, {})).status).toBe(200);
    await s.tick(now);
    expect((await alertsOf(companyId)).filter((a) => a.kind === "top_up_requested")).toHaveLength(1);
    now = new Date(now.getTime() + 48 * 60 * 60_000); // the card was answered at the real clock time, so jump well past a day
    solState.balances.set(wallet.address, sol(0.1));
    const viaTrader = await trader.post(`/api/agent-wallets/trading/${wallet.id}/top-up-request`, { reason: "Two stops-outs this week; strategy needs more room" });
    expect(viaTrader.status).toBe(201);
    expect(viaTrader.body.created).toBe(true);
    expect(viaTrader.body.approvalId).not.toBe(row.topUpApprovalId);
    const [traderCard] = await db.select().from(approvals).where(eq(approvals.id, viaTrader.body.approvalId));
    expect(traderCard).toMatchObject({ requestedByAgentId: traderId });
    expect((traderCard!.payload as { summary: string }).summary).toMatch(/The Trader says \(its own words, not checked\): "Two stops-outs this week/);
  });

  // ─── Alerts outbox (Telegram bridge) ───────────────────────────────────

  it("hands the Telegram bridge its alerts once, and keeps them inside the company", async () => {
    const { companyId } = await seed();
    const other = await seed();
    const wallet = await makeHlWallet(companyId);
    hl.state.accountValueUsd = 500;
    await svc().tick(now);
    const owner = boardApp(companyId, "owner");
    const outbox = await owner.get(`/api/companies/${companyId}/trading-alerts-outbox`);
    expect(outbox.status).toBe(200);
    expect(outbox.body.alerts).toHaveLength(1);
    expect(outbox.body.alerts[0]).toMatchObject({ kind: "wallet_paused", walletId: wallet.id });
    const alertId = outbox.body.alerts[0].id;
    // Another company's board cannot read or acknowledge it.
    expect((await boardApp(other.companyId, "owner").get(`/api/companies/${companyId}/trading-alerts-outbox`)).status).toBe(403);
    expect((await boardApp(other.companyId, "owner").post(`/api/companies/${other.companyId}/trading-alerts-outbox/${alertId}/ack`, { outcome: "delivered" })).status).toBe(404);
    expect((await owner.post(`/api/companies/${companyId}/trading-alerts-outbox/${alertId}/ack`, { outcome: "delivered" })).body.status).toBe("delivered");
    expect((await owner.post(`/api/companies/${companyId}/trading-alerts-outbox/${alertId}/ack`, { outcome: "failed" })).body.status).toBe("delivered");
    expect((await owner.get(`/api/companies/${companyId}/trading-alerts-outbox`)).body.alerts).toHaveLength(0);
  });

  it("asks the network about a trading wallet only every few minutes, not on every scheduler tick", async () => {
    const { companyId } = await seed();
    await makeHlWallet(companyId);
    hl.state.accountValueUsd = 100;
    const slow = cryptoWalletService(db, db, { ...deps(), tradingWatchIntervalMs: 5 * 60_000 });
    expect((await slow.tick(now)).tradingWalletsChecked).toBe(1);
    expect((await slow.tick(new Date(now.getTime() + 60_000))).tradingWalletsChecked).toBe(0);
    expect((await slow.tick(new Date(now.getTime() + 6 * 60_000))).tradingWalletsChecked).toBe(1);
  });

  it("only sweeps what a Hyperliquid wallet can actually withdraw", async () => {
    const { companyId } = await seed();
    const owner = boardApp(companyId, "owner");
    const wallet = await makeHlWallet(companyId, {
      perTrade: "25", daily: "100", total: "5000", maxBalance: "200", dailyLossStop: "10", sweepThreshold: "150", topUpFloor: "20", topUpTarget: "100",
    });
    const cold = `0x${"ab".repeat(20)}`;
    await owner.post(`/api/companies/${companyId}/crypto/trading-wallets/${wallet.id}/sweep-address`, { address: cold });
    await db.update(approvals).set({ status: "approved", decidedByUserId: "owner-user" }).where(eq(approvals.id, (await walletRow(wallet.id)).pendingSweepApprovalId!));
    // $190 in the account, but most of it is margin for open trades: only $14 can be withdrawn ($13 after the exchange's $1 fee).
    hl.state.accountValueUsd = 190;
    hl.getBalance = async () => ({ balance: 190_000_000n, withdrawable: 14_000_000n });
    await svc().tick(now);
    const sweeps = (await txsOf(wallet.id)).filter((t) => t.routineAction === "sweep");
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.amount).toBe("13000000");
    expect(sweeps[0]!.status).toBe("pending_approval");
  });

  it("keeps the Trader's settings row clean when the company has none, and reports no Trader", async () => {
    const { companyId } = await seed();
    const settings = await boardApp(companyId, "owner").get(`/api/companies/${companyId}/crypto/settings`);
    expect(settings.body).toMatchObject({ traderAgentId: null, mainnetEnabled: false, realMoneyLocked: true });
    expect(await db.select().from(companyCryptoSettings).where(eq(companyCryptoSettings.companyId, companyId))).toHaveLength(0);
  });
});
