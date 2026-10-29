import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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
  companySecrets,
  createDb,
  cryptoWallets,
  companyCryptoSettings,
  cryptoWalletTransactions,
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
 * Crypto wallets for agents, end to end over HTTP with a real database and
 * real secrets store, and only mocked networks:
 *
 *   - Solana uses the REAL adapter (Node's Ed25519 signer) against a fake
 *     JSON-RPC, so the signing path is exercised for real.
 *   - Hyperliquid uses a fake adapter that records what it was asked to do.
 *   - Prices come from a fake price source (1 SOL = $100).
 *
 * The suite covers: keys never leave the server (API responses, logs,
 * ledger, activity log, approval cards, agent tool output), limits,
 * thresholds and approval cards, real money off by default, the allow-list,
 * the kill switches, company scoping and the ledger entries.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping crypto wallet tests: ${support.reason ?? "unsupported environment"}`);

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

function solanaKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return { secretBase58: base58Encode(new Uint8Array(Buffer.concat([seed, pub]))), seedHex: seed.toString("hex"), address: base58Encode(new Uint8Array(pub)) };
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

d("crypto wallets for agents", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  let cryptoWalletRoutes!: typeof import("../routes/crypto-wallets.js").cryptoWalletRoutes;
  let cryptoWalletService!: typeof import("../services/crypto-wallets.js").cryptoWalletService;
  let errorHandler!: typeof import("../middleware/index.js").errorHandler;
  let logger!: typeof import("../middleware/logger.js").logger;
  let secretService!: typeof import("../services/secrets.js").secretService;
  let approvalService!: typeof import("../services/approvals.js").approvalService;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousRealMoney = process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
  const tmpDir = path.join(os.tmpdir(), `paperclip-crypto-wallets-${randomUUID()}`);

  let solState: FakeSolanaState;
  let hl: FakeHyperliquid;
  let adapters: CryptoChainAdapters;
  const priceSource: CryptoPriceSource = { usdPrice: async (chain) => (chain === "hyperliquid" ? 1 : 100) };
  let now = new Date("2026-10-17T10:00:00Z");
  /** Everything the API sent back, for the "no key anywhere" checks. */
  const responses: string[] = [];
  const logLines: string[] = [];

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    // Most of this suite is about the per-company real-money switch, so the server-wide lock is open for it;
    // the lock's own test below closes it again.
    process.env.PAPERCLIP_CRYPTO_REAL_MONEY = "allowed";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("crypto-wallets");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    ({ cryptoWalletRoutes } = await import("../routes/crypto-wallets.js"));
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
    // The tick is instance-wide: settle every earlier test's open payments
    // so they do not show up in this test's fake network.
    if (db) {
      await db
        .update(cryptoWalletTransactions)
        .set({ status: "confirmed" })
        .where(inArray(cryptoWalletTransactions.status, ["pending_approval", "approved", "submitted"]));
    }
    solState = { balances: new Map(), sent: [], statuses: new Map(), calls: [], genesis: DEVNET_GENESIS, blockHeight: 1_000, sendMode: "ok" };
    hl = fakeHyperliquid();
    adapters = { bitcoin: inertAdapter("bitcoin"), ethereum: inertAdapter("ethereum"), solana: solanaAdapter(), hyperliquid: hl };
    now = new Date("2026-10-17T10:00:00Z");
  });

  function deps() {
    return { adapters, priceSource, now: () => now, fetchFor: () => fakeSolanaRpc(solState) };
  }

  function boardApp(companyId: string, role: MembershipRole, userId = randomUUID()) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }],
      };
      next();
    });
    app.use("/api", cryptoWalletRoutes(db, deps()));
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

  /** supertest, but every response body is kept for the key-leak checks. */
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
      delete: (url: string) => record(request(app).delete(url)),
    };
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Crypto Co ${companyId.slice(0, 6)}`, issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Buyer agent", role: "engineer" });
    return { companyId, agentId };
  }

  async function makeSolanaWallet(companyId: string, agentId: string, extra: Record<string, unknown> = {}) {
    const owner = boardApp(companyId, "owner");
    const res = await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", label: "Purchases", mode: "generate", ...extra });
    expect(res.status).toBe(201);
    return res.body as { id: string; address: string };
  }

  async function allow(companyId: string, walletId: string, address = randomSolAddress(), role: MembershipRole = "admin") {
    const res = await boardApp(companyId, role).post(`/api/companies/${companyId}/crypto/wallets/${walletId}/destinations`, { address, label: "Supplier" });
    expect(res.status).toBe(201);
    return address;
  }

  async function ledgerTypes(walletId: string) {
    const rows = await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.walletId, walletId));
    return rows.map((r) => r.eventType);
  }

  // ─── Real money off by default ─────────────────────────────────────────

  it("starts every company on test networks; only the owner can turn real money on, with the confirm phrase", async () => {
    const { companyId, agentId } = await seed();
    const admin = boardApp(companyId, "admin");
    const owner = boardApp(companyId, "owner");

    const settings = await admin.get(`/api/companies/${companyId}/crypto/settings`);
    expect(settings.body).toMatchObject({ mainnetEnabled: false, allWalletsFrozen: false });

    const created = await admin.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", label: "Default", mode: "generate" });
    expect(created.status).toBe(201);
    expect(created.body.network).toBe("testnet");

    const mainnetWallet = await admin.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", network: "mainnet", label: "Real", mode: "generate" });
    expect(mainnetWallet.status).toBe(403);
    expect(mainnetWallet.body.error).toMatch(/Real money is switched off/);

    expect((await admin.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" })).status).toBe(403);
    expect((await owner.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: true })).status).toBe(422);
    const on = await owner.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" });
    expect(on.status).toBe(200);
    expect(on.body.mainnetEnabled).toBe(true);

    const real = await admin.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", network: "mainnet", label: "Real", mode: "generate" });
    expect(real.status).toBe(201);
    expect(real.body.network).toBe("mainnet");

    // Turning it off again stops the main-network wallet at once.
    expect((await admin.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: false })).body.mainnetEnabled).toBe(false);
    // On a real-money wallet only the owner may add an allowed address.
    expect((await admin.post(`/api/companies/${companyId}/crypto/wallets/${real.body.id}/destinations`, { address: randomSolAddress(), label: "x" })).status).toBe(403);
    const to = await allow(companyId, real.body.id, randomSolAddress(), "owner");
    const tx = await agentApp(companyId, agentId).post(`/api/agent-wallets/${real.body.id}/send`, { to, amount: "0.01", purpose: "Pay a supplier" });
    expect(tx.body.status).toBe("blocked");
    expect(tx.body.blockReason).toMatch(/Real money is switched off/);
    expect(solState.sent).toHaveLength(0);
  });

  // ─── Server-wide real-money lock ───────────────────────────────────────

  it("refuses everything real-money while PAPERCLIP_CRYPTO_REAL_MONEY is not 'allowed', without writing any wallet or settings state", async () => {
    // Set up a company that already has real money on and a funded main-network wallet, while the lock is open.
    const { companyId, agentId } = await seed();
    const owner = boardApp(companyId, "owner");
    const agent = agentApp(companyId, agentId);
    expect((await owner.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" })).status).toBe(200);
    const sol = await makeSolanaWallet(companyId, agentId, { network: "mainnet" });
    const hlWallet = (await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "hyperliquid", network: "mainnet", label: "Trader", mode: "generate" })).body as { id: string };
    solState.genesis = MAINNET_GENESIS;
    solState.balances.set(sol.address, 5_000_000_000);
    const to = await allow(companyId, sol.id, randomSolAddress(), "owner");
    const walletRowsBefore = await db.select().from(cryptoWallets).where(eq(cryptoWallets.companyId, companyId));
    const [settingsBefore] = await db.select().from(companyCryptoSettings).where(eq(companyCryptoSettings.companyId, companyId));
    const txCountBefore = (await db.select({ id: cryptoWalletTransactions.id }).from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.companyId, companyId))).length;

    // A second company with no settings of its own, to try to switch real money on.
    const other = await seed();

    const lockMessage = /Real money is switched off on this server \(administrator setting\)/;
    delete process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
    try {
      const otherOwner = boardApp(other.companyId, "owner");

      // Creating or importing a main-network wallet.
      const created = await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", network: "mainnet", label: "More", mode: "generate" });
      expect(created.status).toBe(403);
      expect(created.body.error).toMatch(lockMessage);
      const imported = await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", network: "mainnet", label: "More", mode: "import", privateKey: solanaKeypair().secretBase58 });
      expect(imported.status).toBe(403);
      expect(imported.body.error).toMatch(lockMessage);

      // Turning the company setting on, even as the owner who types the phrase.
      const turnOn = await otherOwner.patch(`/api/companies/${other.companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" });
      expect(turnOn.status).toBe(403);
      expect(turnOn.body.error).toMatch(lockMessage);
      expect((await otherOwner.get(`/api/companies/${other.companyId}/crypto/settings`)).body).toMatchObject({ mainnetEnabled: false, realMoneyLocked: true });
      expect(await db.select().from(companyCryptoSettings).where(eq(companyCryptoSettings.companyId, other.companyId))).toHaveLength(0);

      // The stored real-money choice is reported as it was, with the lock on top; turning it off still works.
      expect((await owner.get(`/api/companies/${companyId}/crypto/settings`)).body).toMatchObject({ mainnetEnabled: true, realMoneyLocked: true });

      // Sending from the existing main-network wallet: agent, owner and a dry-run quote.
      const send = await agent.post(`/api/agent-wallets/${sol.id}/send`, { to, amount: "0.01", purpose: "Pay a supplier" });
      expect(send.status).toBe(403);
      expect(send.body.error).toMatch(lockMessage);
      const ownerSend = await owner.post(`/api/companies/${companyId}/crypto/wallets/${sol.id}/send`, { to, amount: "0.01", purpose: "Pay a supplier" });
      expect(ownerSend.status).toBe(403);
      expect(ownerSend.body.error).toMatch(lockMessage);
      const quote = await agent.post(`/api/agent-wallets/${sol.id}/quote`, { to, amount: "0.01" });
      expect(quote.body.outcome).toMatch(/refused.*switched off on this server/i);

      // A Hyperliquid order from a main-network wallet.
      const order = await agent.post(`/api/agent-wallets/${hlWallet.id}/hyperliquid-order`, { coin: "BTC", side: "buy", size: "0.05", limitPrice: "100", purpose: "Trade" });
      expect(order.status).toBe(403);
      expect(order.body.error).toMatch(lockMessage);
      expect(hl.orders).toHaveLength(0);

      // Flipping the setting straight in the database changes nothing about signing.
      await db.insert(companyCryptoSettings).values({ companyId: other.companyId, mainnetEnabled: true }).onConflictDoUpdate({ target: companyCryptoSettings.companyId, set: { mainnetEnabled: true } });
      expect((await boardApp(other.companyId, "owner").post(`/api/companies/${other.companyId}/crypto/wallets`, { agentId: other.agentId, chain: "solana", network: "mainnet", label: "x", mode: "generate" })).status).toBe(403);
      const direct = await agent.post(`/api/agent-wallets/${sol.id}/send`, { to, amount: "0.01", purpose: "Direct flip" });
      expect(direct.status).toBe(403);

      // The network was never asked to send anything, and nothing was recorded.
      expect(solState.calls).not.toContain("sendTransaction");
      expect(solState.sent).toHaveLength(0);
      expect((await db.select({ id: cryptoWalletTransactions.id }).from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.companyId, companyId))).length).toBe(txCountBefore);

      // Testnet flows are unchanged.
      const testnet = await makeSolanaWallet(companyId, agentId);
      solState.genesis = DEVNET_GENESIS;
      solState.balances.set(testnet.address, 5_000_000_000);
      const testTo = await allow(companyId, testnet.id);
      const testSend = await agent.post(`/api/agent-wallets/${testnet.id}/send`, { to: testTo, amount: "0.01", purpose: "Test coins" });
      expect(testSend.status).toBe(202);
      expect(testSend.body.status).toBe("submitted");
    } finally {
      process.env.PAPERCLIP_CRYPTO_REAL_MONEY = "allowed";
    }

    // Nothing persisted: no wallet was frozen or changed and the company setting is exactly as before.
    const walletRowsAfter = await db.select().from(cryptoWallets).where(and(eq(cryptoWallets.companyId, companyId), inArray(cryptoWallets.id, [sol.id, hlWallet.id])));
    for (const before of walletRowsBefore) {
      const after = walletRowsAfter.find((w) => w.id === before.id);
      expect(after?.status).toBe(before.status);
      expect(after?.frozenReason).toBe(before.frozenReason);
      expect(after?.frozenAt).toEqual(before.frozenAt);
      expect(after?.status).not.toBe("frozen");
    }
    const [settingsAfter] = await db.select().from(companyCryptoSettings).where(eq(companyCryptoSettings.companyId, companyId));
    expect(settingsAfter).toEqual(settingsBefore);

    // Lifting the lock needs no clean-up: the same wallet sends again.
    solState.genesis = MAINNET_GENESIS;
    const sentBefore = solState.sent.length;
    const resumed = await agent.post(`/api/agent-wallets/${sol.id}/send`, { to, amount: "0.01", purpose: "Back on" });
    expect(resumed.status).toBe(202);
    expect(resumed.body.status).toBe("submitted");
    expect(solState.sent).toHaveLength(sentBefore + 1);
  });

  // ─── Keys never leave the server ───────────────────────────────────────

  it("keeps an imported key out of every API response, log line, ledger row, activity row and approval card", async () => {
    const { companyId, agentId } = await seed();
    const kp = solanaKeypair();
    const owner = boardApp(companyId, "owner");
    const agent = agentApp(companyId, agentId);
    responses.length = 0;
    logLines.length = 0;

    const created = await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", label: "Imported", mode: "import", privateKey: kp.secretBase58 });
    expect(created.status).toBe(201);
    expect(created.body.address).toBe(kp.address);
    expect(created.body.keyOrigin).toBe("imported");
    expect(created.body).not.toHaveProperty("secretId");
    expect(created.body).not.toHaveProperty("privateKey");
    const walletId = created.body.id as string;

    // The key is in the secrets store, as a protected kind, and nowhere else.
    const [walletRow] = await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, walletId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, walletRow!.secretId));
    expect(secret!.kind).toBe("crypto_wallet_key");

    // Exercise every read surface, an approval card, a send, and an error path.
    solState.balances.set(kp.address, 5_000_000_000);
    const to = await allow(companyId, walletId);
    await owner.get(`/api/companies/${companyId}/crypto/wallets`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${walletId}`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${walletId}/balance`);
    await agent.get(`/api/agent-wallets`);
    await agent.get(`/api/agent-wallets/${walletId}/balance`);
    await agent.get(`/api/agent-wallets/${walletId}/destinations`);
    await agent.post(`/api/agent-wallets/${walletId}/quote`, { to, amount: "0.01" });
    const sent = await agent.post(`/api/agent-wallets/${walletId}/send`, { to, amount: "0.01", purpose: "Small purchase" });
    expect(sent.body.status).toBe("submitted");
    const carded = await agent.post(`/api/agent-wallets/${walletId}/send`, { to, amount: "0.1", purpose: "Bigger purchase" });
    expect(carded.body.status).toBe("pending_approval");
    await agent.get(`/api/agent-wallets/transactions/${sent.body.id}`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${walletId}/transactions`);
    await owner.get(`/api/companies/${companyId}/crypto/wallets/${walletId}/ledger`);
    // An import with a bad key must not echo it either.
    const badKey = "zz" + kp.secretBase58.slice(2);
    const bad = await owner.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", label: "Bad", mode: "import", privateKey: badKey });
    expect(bad.status).toBe(422);

    const needles = [kp.seedHex, kp.secretBase58, badKey, walletRow!.secretId];
    const haystacks = {
      responses: responses.join("\n"),
      logs: logLines.join("\n"),
      ledger: JSON.stringify(await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.companyId, companyId))),
      activity: JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))),
      approvals: JSON.stringify(await db.select().from(approvals).where(eq(approvals.companyId, companyId))),
      transactions: JSON.stringify(await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.companyId, companyId))),
      broadcast: JSON.stringify(solState.sent),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of needles) {
        expect(text.includes(needle), `${where} must not contain key material or the secret id`).toBe(false);
      }
    }
    // The signed transaction really came from this key (the server signed it).
    expect(solState.sent).toHaveLength(1);
  });

  it("refuses every generic way to read, rebind, relabel, replace or delete a wallet key", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const [row] = await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, wallet.id));
    const secrets = secretService(db);
    await expect(secrets.resolveSecretValue(companyId, row!.secretId, "latest")).rejects.toThrow(/dedicated reader/);
    await expect(secrets.resolveSecretValueForExport(companyId, row!.secretId, "latest")).rejects.toThrow(/dedicated reader/);
    await expect(
      secrets.createBinding({ companyId, secretId: row!.secretId, targetType: "agent", targetId: agentId, configPath: "env.WALLET_KEY" } as never),
    ).rejects.toThrow(/never be bound/);
    await expect(secrets.update(row!.secretId, { kind: "other" })).rejects.toThrow(/cannot be changed/);
    await expect(secrets.rotate(row!.secretId, { value: "x".repeat(64) })).rejects.toThrow(/cannot be replaced/);
    await expect(secrets.remove(row!.secretId)).rejects.toThrow(/still in use/);
    // The wallet signer's own reader refuses any other kind of secret.
    const other = await secrets.createManagedLocalSecret(companyId, { name: "Some token", key: "some_token", value: "tok" });
    await expect(secrets.resolveSecretValueForWalletSigning(companyId, other.id, { walletId: wallet.id, actorType: "system", actorId: "t" })).rejects.toThrow(
      /Only a crypto wallet key/,
    );
  });

  // ─── Allow-list ────────────────────────────────────────────────────────

  it("only sends to addresses on the wallet's allowed list, and only owners/admins can add them", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const agent = agentApp(companyId, agentId);

    const notListed = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to: randomSolAddress(), amount: "0.01", purpose: "Pay someone" });
    expect(notListed.status).toBe(202);
    expect(notListed.body.status).toBe("blocked");
    expect(notListed.body.blockReason).toMatch(/not on this wallet's allowed list/);
    expect(solState.sent).toHaveLength(0);

    expect((await boardApp(companyId, "operator").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/destinations`, { address: randomSolAddress(), label: "x" })).status).toBe(403);
    const bogus = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/destinations`, { address: "not-a-solana-address!!", label: "x" });
    expect(bogus.status).toBe(422);
    const self = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/destinations`, { address: wallet.address, label: "me" });
    expect(self.status).toBe(422);

    const to = await allow(companyId, wallet.id);
    const ok = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.01", purpose: "Pay the supplier" });
    expect(ok.body.status).toBe("submitted");
    expect(solState.sent).toHaveLength(1);
    expect(await ledgerTypes(wallet.id)).toEqual(expect.arrayContaining(["wallet_created", "wallet_tx_blocked", "wallet_tx_requested", "wallet_tx_submitted"]));
  });

  // ─── Limits, thresholds and approval cards ─────────────────────────────

  it("applies per-payment, daily and agent dollar limits, and files an approval card above the threshold", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const agent = agentApp(companyId, agentId);
    // Defaults: 0.2 SOL per payment, 0.4 per day, approval from 0.08 SOL; agent $25/$50/$200, approval from $10. 1 SOL = $100.

    const tooBig = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.21", purpose: "Too big" });
    expect(tooBig.body).toMatchObject({ status: "blocked" });
    expect(tooBig.body.blockReason).toMatch(/per payment/);

    const card = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.09", purpose: "Needs a yes" });
    expect(card.body.status).toBe("pending_approval");
    expect(card.body.approvalId).toBeTruthy();
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, card.body.approvalId));
    expect(approval!.payload).toMatchObject({ kind: "crypto_wallet_tx", walletId: wallet.id, transactionId: card.body.id });
    expect(String((approval!.payload as Record<string, unknown>).summary)).toMatch(/test network/);
    expect(approval!.requestedByAgentId).toBe(agentId);
    expect(solState.sent).toHaveLength(0);

    // The pending card already reserves its share of the limits.
    for (let i = 0; i < 6; i++) {
      const r = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.05", purpose: `Small ${i}` });
      expect(r.body.status).toBe("submitted");
    }
    // 0.09 + 6 x 0.05 = 0.39 SOL today; one more 0.05 crosses the wallet's 0.4 daily limit.
    const overDaily = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.05", purpose: "One too many" });
    expect(overDaily.body.status).toBe("blocked");
    expect(overDaily.body.blockReason).toMatch(/daily limit/);

    // A new UTC day resets the daily limit.
    now = new Date("2026-10-18T09:00:00Z");
    const nextDay = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.05", purpose: "Next day" });
    expect(nextDay.body.status).toBe("submitted");

    // Agent dollar limits apply across wallets: $44 counted so far ($9 pending + 7 x $5); a $45 total stops the next $5.
    const limits = await boardApp(companyId, "owner").put(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`, { perTransactionUsd: 25, dailyUsd: 45, totalUsd: 45, approvalAboveUsd: 10 });
    expect(limits.status).toBe(200);
    const overAgentTotal = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.05", purpose: "Over the agent total" });
    expect(overAgentTotal.body.status).toBe("blocked");
    expect(overAgentTotal.body.blockReason).toMatch(/agent over its total limit/);
    // The hard ceiling cannot be exceeded through the API.
    expect((await boardApp(companyId, "owner").put(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`, { perTransactionUsd: 5000, dailyUsd: 5000, totalUsd: 5000, approvalAboveUsd: null })).status).toBe(400);
  });

  it("sends an approved card on the next tick, and never sends a turned-down or expired one", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const agent = agentApp(companyId, agentId);
    const svc = cryptoWalletService(db, db, deps());

    const a = (await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Approve me" })).body;
    const b = (await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Reject me" })).body;
    const c = (await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Let me expire" })).body;
    expect([a.status, b.status, c.status]).toEqual(["pending_approval", "pending_approval", "pending_approval"]);

    await db.update(approvals).set({ status: "approved", decidedByUserId: "owner-user" }).where(eq(approvals.id, a.approvalId));
    await db.update(approvals).set({ status: "rejected", decidedByUserId: "owner-user" }).where(eq(approvals.id, b.approvalId));
    await svc.tick(now);
    const statusOf = async (id: string) => (await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.id, id)))[0]!;
    expect((await statusOf(a.id)).status).toBe("submitted");
    expect((await statusOf(b.id)).status).toBe("rejected");
    expect((await statusOf(c.id)).status).toBe("pending_approval");
    expect(solState.sent).toHaveLength(1);

    // An hour later the third card has expired: nothing is sent, even if approved afterwards.
    now = new Date(now.getTime() + 61 * 60_000);
    await svc.tick(now);
    expect((await statusOf(c.id)).status).toBe("expired_approval");
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, c.approvalId));
    await svc.tick(now);
    expect((await statusOf(c.id)).status).toBe("expired_approval");
    // The sent one may be re-sent while unconfirmed, but only ever as the same signed transaction.
    expect(new Set(solState.sent.map((t) => t.raw)).size).toBe(1);

    // The network confirms the sent one; the tick records it with its hash.
    solState.statuses.set(solState.sent[0]!.signature, { confirmationStatus: "confirmed", err: null });
    await svc.tick(now);
    const confirmed = await statusOf(a.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.txHash).toBe(solState.sent[0]!.signature);
    const ledger = await db.select().from(tradingLedgerEntries).where(and(eq(tradingLedgerEntries.walletTransactionId, a.id), eq(tradingLedgerEntries.eventType, "wallet_tx_confirmed")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.txHash).toBe(solState.sent[0]!.signature);
    expect(ledger[0]!.txStatus).toBe("confirmed");
    expect(ledger[0]!.strategyId).toBeNull();
  });

  it("does not let anyone file or approve a wallet card through the generic approval paths", async () => {
    const { companyId } = await seed();
    await expect(
      approvalService(db).create(companyId, { type: "request_board_approval", requestedByAgentId: null, status: "pending", payload: { kind: "crypto_wallet_tx", transactionId: randomUUID() } }),
    ).rejects.toThrow(/can only be filed by the wallet itself/);
    const { isApprovalCardOnlyKind } = await import("../services/approvals.js");
    expect(isApprovalCardOnlyKind({ type: "request_board_approval", payload: { kind: "crypto_wallet_tx" } })).toBe(true);
  });

  // ─── Kill switches ─────────────────────────────────────────────────────

  it("stops payments with the wallet kill switch and the company kill switch, including approved ones", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const agent = agentApp(companyId, agentId);
    const admin = boardApp(companyId, "admin");
    const svc = cryptoWalletService(db, db, deps());

    const pending = (await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Approved later" })).body;

    expect((await admin.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/freeze`, { frozen: true, reason: "Testing" })).body.status).toBe("frozen");
    const frozen = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.01", purpose: "While frozen" });
    expect(frozen.body.status).toBe("blocked");
    expect(frozen.body.blockReason).toMatch(/frozen/);

    // A card approved while the wallet is frozen is still not sent.
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, pending.approvalId));
    await svc.tick(now);
    const [afterTick] = await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.id, pending.id));
    expect(afterTick!.status).toBe("blocked");
    expect(solState.sent).toHaveLength(0);

    await admin.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/freeze`, { frozen: false });
    await admin.patch(`/api/companies/${companyId}/crypto/settings`, { allWalletsFrozen: true });
    const companyFrozen = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.01", purpose: "Company frozen" });
    expect(companyFrozen.body.blockReason).toMatch(/All crypto wallets in this company are frozen/);
    // Owners cannot send around it either.
    const ownerSend = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to, amount: "0.01", purpose: "Owner during freeze" });
    expect(ownerSend.body.status).toBe("blocked");
    expect(solState.sent).toHaveLength(0);

    await admin.patch(`/api/companies/${companyId}/crypto/settings`, { allWalletsFrozen: false });
    expect((await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.01", purpose: "Back on" })).body.status).toBe("submitted");
    expect(await ledgerTypes(wallet.id)).toEqual(expect.arrayContaining(["wallet_kill_switch"]));
  });

  it("freezes a wallet on its own when coins leave that Paperclip did not send", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const owner = boardApp(companyId, "owner");
    solState.balances.set(wallet.address, 1_000_000_000);
    expect((await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/balance`)).body.reconciliation.ok).toBe(true);

    solState.balances.set(wallet.address, 400_000_000); // 0.6 SOL gone, nothing sent by Paperclip
    const check = await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/balance`);
    expect(check.body.reconciliation.ok).toBe(false);
    expect(check.body.reconciliation.note).toMatch(/did not send/);
    const [row] = await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, wallet.id));
    expect(row!.status).toBe("frozen");
  });

  // ─── Company scoping ───────────────────────────────────────────────────

  it("keeps wallets inside their company and their agent", async () => {
    const a = await seed();
    const b = await seed();
    const otherAgentInA = randomUUID();
    await db.insert(agents).values({ id: otherAgentInA, companyId: a.companyId, name: "Other agent", role: "engineer" });
    const wallet = await makeSolanaWallet(a.companyId, a.agentId);
    const to = await allow(a.companyId, wallet.id);

    // Another company's agent, and another agent in the same company, cannot see or use it.
    for (const agent of [agentApp(b.companyId, b.agentId), agentApp(a.companyId, otherAgentInA)]) {
      expect((await agent.get(`/api/agent-wallets`)).body).toEqual([]);
      expect((await agent.get(`/api/agent-wallets/${wallet.id}/balance`)).status).toBe(404);
      expect((await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.01", purpose: "Not mine" })).status).toBe(404);
    }
    // Another company's admin cannot reach it through their own company id or this one.
    const bAdmin = boardApp(b.companyId, "admin");
    expect((await bAdmin.get(`/api/companies/${b.companyId}/crypto/wallets/${wallet.id}`)).status).toBe(404);
    expect((await bAdmin.get(`/api/companies/${a.companyId}/crypto/wallets`)).status).toBe(403);
    // A wallet cannot be created for an agent of another company.
    expect((await bAdmin.post(`/api/companies/${b.companyId}/crypto/wallets`, { agentId: a.agentId, chain: "solana", label: "x", mode: "generate" })).status).toBe(404);
    // Board users (even owners) cannot use the agent tool surface; agents cannot use the owner surface.
    expect((await boardApp(a.companyId, "owner").get(`/api/agent-wallets`)).status).toBe(403);
    expect((await agentApp(a.companyId, a.agentId).get(`/api/companies/${a.companyId}/crypto/wallets`)).status).toBe(403);
    // Operators and viewers cannot see wallets at all.
    expect((await boardApp(a.companyId, "viewer").get(`/api/companies/${a.companyId}/crypto/wallets`)).status).toBe(403);
    expect(solState.sent).toHaveLength(0);
  });

  // ─── Hyperliquid ───────────────────────────────────────────────────────

  it("caps Hyperliquid leverage at 1x by default and never lets a limit block closing a position", async () => {
    const { companyId, agentId } = await seed();
    const created = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "hyperliquid", label: "Trader", mode: "generate" });
    expect(created.status).toBe(201);
    expect(created.body.maxLeverage).toBe(1);
    const walletId = created.body.id as string;
    const agent = agentApp(companyId, agentId);
    hl.state.accountValueUsd = 100;

    const tooBig = await agent.post(`/api/agent-wallets/${walletId}/hyperliquid-order`, { coin: "BTC", side: "buy", size: "1.5", limitPrice: "100", purpose: "Leveraged" });
    expect(tooBig.body.status).toBe("blocked");
    expect(tooBig.body.blockReason).toMatch(/leverage cap/);

    const ok = await agent.post(`/api/agent-wallets/${walletId}/hyperliquid-order`, { coin: "BTC", side: "buy", size: "0.05", limitPrice: "100", purpose: "Small" });
    expect(ok.body.status).toBe("confirmed");
    expect(hl.orders).toEqual([{ coin: "BTC", isBuy: true, size: "0.05", leverage: 1, reduceOnly: false, keySeen: true }]);

    // Use up the agent's limits, then a reduce-only (closing) order still goes through.
    await boardApp(companyId, "owner").put(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`, { perTransactionUsd: 1, dailyUsd: 1, totalUsd: 1, approvalAboveUsd: null });
    const blockedOpen = await agent.post(`/api/agent-wallets/${walletId}/hyperliquid-order`, { coin: "BTC", side: "buy", size: "0.05", limitPrice: "100", purpose: "Opening" });
    expect(blockedOpen.body.status).toBe("blocked");
    const close = await agent.post(`/api/agent-wallets/${walletId}/hyperliquid-order`, { coin: "BTC", side: "sell", size: "0.05", limitPrice: "100", reduceOnly: true, purpose: "Closing" });
    expect(close.body.status).toBe("confirmed");

    // Raising leverage is capped by the hard ceiling, and only on Hyperliquid wallets.
    expect((await boardApp(companyId, "owner").patch(`/api/companies/${companyId}/crypto/wallets/${walletId}`, { maxLeverage: 50 })).status).toBe(400);

    // Withdrawals are sends: allow-list only.
    const notListed = await agent.post(`/api/agent-wallets/${walletId}/send`, { to: `0x${"ab".repeat(20)}`, amount: "1", purpose: "Withdraw" });
    expect(notListed.body.status).toBe("blocked");
  });

  it("deletes a company with test wallets, but refuses while a real-money wallet is still in use", async () => {
    const { companyService } = await import("../services/companies.js");
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    await allow(companyId, wallet.id);
    await companyService(db).remove(companyId);
    expect(await db.select().from(cryptoWallets).where(eq(cryptoWallets.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);

    const other = await seed();
    await boardApp(other.companyId, "owner").patch(`/api/companies/${other.companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" });
    const real = await makeSolanaWallet(other.companyId, other.agentId, { network: "mainnet" });
    await expect(companyService(db).remove(other.companyId)).rejects.toThrow(/real-money crypto wallet/);
    const admin = boardApp(other.companyId, "admin");
    await admin.post(`/api/companies/${other.companyId}/crypto/wallets/${real.id}/freeze`, { frozen: true });
    expect((await admin.post(`/api/companies/${other.companyId}/crypto/wallets/${real.id}/archive`)).body.status).toBe("archived");
    await companyService(db).remove(other.companyId);
    expect(await db.select().from(companies).where(eq(companies.id, other.companyId))).toHaveLength(0);
  });

  // ─── Network fees (B1) ─────────────────────────────────────────────────

  it("reserves the network fee, counts it in the limits and shows it on the approval card", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const agent = agentApp(companyId, agentId);
    // Exactly the per-payment limit (0.2 SOL) is refused once the fee is added on top.
    const atLimit = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.2", purpose: "Exactly the limit" });
    expect(atLimit.body.status).toBe("blocked");
    expect(atLimit.body.blockReason).toMatch(/network fee included/);
    const card = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.09", purpose: "With a fee" });
    expect(card.body.feeUpperBound).toBe("7500"); // 5000 lamports estimate x 1.5 headroom
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, card.body.approvalId));
    expect(String((approval!.payload as Record<string, unknown>).summary)).toMatch(/plus a network fee of at most 0\.0000075 SOL/);
  });

  // ─── Unclear sends never release the limits (B2) ───────────────────────

  it("keeps a payment counted when the node accepts it but answers 502, and only ever re-sends the same signed bytes", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const agent = agentApp(companyId, agentId);
    const svc = cryptoWalletService(db, db, deps());
    // Wallet daily limit 0.4 SOL: a 0.35 SOL payment that "failed" must still block a second one.
    await boardApp(companyId, "owner").patch(`/api/companies/${companyId}/crypto/wallets/${wallet.id}`, {
      limits: { perTransaction: "0.4", daily: "0.4", total: "2", approvalAbove: "1" },
    });
    await boardApp(companyId, "owner").put(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`, { perTransactionUsd: 100, dailyUsd: 100, totalUsd: 200, approvalAboveUsd: 100 });

    solState.sendMode = "accept-then-502";
    const first = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.35", purpose: "First try" });
    expect(first.body.status).toBe("submitted");
    expect(first.body.error).toMatch(/No clear answer/);
    expect(first.body.txHash).toBe(solState.sent[0]!.signature);

    const retry = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.35", purpose: "Retry" });
    expect(retry.body.status).toBe("blocked");
    expect(retry.body.blockReason).toMatch(/daily limit/);
    expect(solState.sent).toHaveLength(1);

    // Not seen yet: after the re-send interval the tick re-sends the SAME transaction.
    solState.sendMode = "already-processed";
    now = new Date(now.getTime() + 6 * 60_000);
    await svc.tick(now);
    expect(solState.sent).toHaveLength(2);
    expect(solState.sent[1]!.raw).toBe(solState.sent[0]!.raw);
    const statusOf = async () => (await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.id, first.body.id)))[0]!;
    expect((await statusOf()).status).toBe("submitted");

    // It landed after all.
    solState.statuses.set(solState.sent[0]!.signature, { confirmationStatus: "confirmed", err: null });
    await svc.tick(now);
    expect((await statusOf()).status).toBe("confirmed");
  });

  it("only gives up on a Solana payment once its block id has expired for sure", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const svc = cryptoWalletService(db, db, deps());
    solState.sendMode = "accept-then-502";
    const tx = (await agentApp(companyId, agentId).post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.05", purpose: "Unclear" })).body;
    const statusOf = async () => (await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.id, tx.id)))[0]!;

    // Hours later but the chain has not moved past its last valid height: still counted.
    now = new Date(now.getTime() + 3 * 60 * 60_000);
    await svc.tick(now);
    expect((await statusOf()).status).toBe("submitted");

    // Now the finalized chain is well past it: it can never land.
    solState.blockHeight += 1_000;
    await svc.tick(now);
    const settled = await statusOf();
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/can never go through/);
  });

  // ─── Solana network check (S2) ─────────────────────────────────────────

  it("refuses to sign a test wallet's payment on a node that is really on the main network", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    solState.genesis = MAINNET_GENESIS;
    const tx = await agentApp(companyId, agentId).post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.05", purpose: "Wrong network" });
    expect(tx.body.status).toBe("failed");
    expect(tx.body.error).toMatch(/Nothing was sent.*not on the test network/);
    expect(solState.sent).toHaveLength(0);
  });

  // ─── Archive and key deletion (S1) ─────────────────────────────────────

  it("will not archive a real-money wallet that still holds coins, nor delete its key", async () => {
    const { companyId, agentId } = await seed();
    const owner = boardApp(companyId, "owner");
    await owner.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" });
    const wallet = await makeSolanaWallet(companyId, agentId, { network: "mainnet" });
    solState.genesis = MAINNET_GENESIS;
    solState.balances.set(wallet.address, 500_000_000);
    await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/freeze`, { frozen: true });
    const refused = await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/archive`);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/still holds 0\.5 SOL/);
    const [row] = await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, wallet.id));
    await expect(secretService(db).remove(row!.secretId)).rejects.toThrow(/may still hold coins/);

    // Even an archived real-money wallet keeps its key while its last balance was above dust.
    await db.update(cryptoWallets).set({ status: "archived" }).where(eq(cryptoWallets.id, wallet.id));
    await expect(secretService(db).remove(row!.secretId)).rejects.toThrow(/may still hold coins/);
    const { companyService } = await import("../services/companies.js");
    await expect(companyService(db).remove(companyId)).rejects.toThrow(/may hold coins/);
  });

  // ─── Owner-only on real money, browser-fill reader ─────────────────────

  it("keeps network addresses owner-only and the browser-fill reader away from wallet keys", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const changed = await boardApp(companyId, "admin").patch(`/api/companies/${companyId}/crypto/settings`, {
      rpcEndpoints: { solana: { testnet: "https://api.mainnet-beta.solana.com" } },
    });
    expect(changed.status).toBe(403);
    const [row] = await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, wallet.id));
    await expect(secretService(db).resolveSecretValueForBrowserFill(companyId, row!.secretId, { actorId: agentId })).rejects.toThrow(
      /Only a payment card or a website login/,
    );
  });

  // ─── Follow-ups (DUR-4808) ──────────────────────────────────────────────

  it("keeps the fee of a payment the receiver rejected counted, and does not mistake it for a stolen key", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const to = await allow(companyId, wallet.id);
    const owner = boardApp(companyId, "owner");
    const agent = agentApp(companyId, agentId);
    const svc = cryptoWalletService(db, db, deps());
    await owner.patch(`/api/companies/${companyId}/crypto/wallets/${wallet.id}`, {
      limits: { perTransaction: "0.1000075", daily: "0.1000075", total: "1", approvalAbove: "1" },
    });
    await owner.put(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`, { perTransactionUsd: 100, dailyUsd: 100, totalUsd: 200, approvalAboveUsd: 100 });
    solState.balances.set(wallet.address, 1_000_000_000);
    expect((await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/balance`)).body.reconciliation.ok).toBe(true);

    const sent = (await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Rejected by the receiver" })).body;
    expect(sent.status).toBe("submitted");
    solState.statuses.set(solState.sent[0]!.signature, { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } });
    await svc.tick(now);
    const [row] = await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.id, sent.id));
    expect(row!.status).toBe("failed");
    expect(row!.error).toMatch(/rejected by the receiving program.*fee .* was still paid/);
    expect((row!.chainDetail as Record<string, unknown>).feePaid).toBe("5000");

    // The paid fee still counts: the same payment again no longer fits today's limit.
    const again = await agent.post(`/api/agent-wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Try again" });
    expect(again.body.status).toBe("blocked");
    expect(again.body.blockReason).toMatch(/daily limit/);

    // Only the fee left the wallet: explained, so no freeze.
    solState.balances.set(wallet.address, 1_000_000_000 - 5_000);
    const check = await owner.get(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/balance`);
    expect(check.body.reconciliation.ok).toBe(true);
    expect((await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, wallet.id)))[0]!.status).toBe("active");
  });

  it("makes real-money limits on creation, unfreezing and the company unfreeze owner-only, and resets agent limits when real money goes on", async () => {
    const { companyId, agentId } = await seed();
    const owner = boardApp(companyId, "owner");
    const admin = boardApp(companyId, "admin");
    // Set while real money is off...
    expect((await admin.put(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`, { perTransactionUsd: 900, dailyUsd: 1900, totalUsd: 9000, approvalAboveUsd: null })).status).toBe(200);
    const on = await owner.patch(`/api/companies/${companyId}/crypto/settings`, { mainnetEnabled: true, confirmPhrase: "REAL MONEY" });
    expect(on.body.agentLimitsReset).toBe(1);
    // ...and back to the safe defaults once real money is on.
    expect((await owner.get(`/api/companies/${companyId}/crypto/agents/${agentId}/limits`)).body).toEqual({ perTransactionUsd: 25, dailyUsd: 50, totalUsd: 200, approvalAboveUsd: 10 });

    const limits = { perTransaction: "5", daily: "5", total: "5", approvalAbove: null };
    expect((await admin.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", network: "mainnet", label: "x", mode: "generate", limits })).status).toBe(403);
    const real = await admin.post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "solana", network: "mainnet", label: "Real", mode: "generate" });
    expect(real.status).toBe(201);

    expect((await admin.post(`/api/companies/${companyId}/crypto/wallets/${real.body.id}/freeze`, { frozen: true })).body.status).toBe("frozen");
    const adminUnfreeze = await admin.post(`/api/companies/${companyId}/crypto/wallets/${real.body.id}/freeze`, { frozen: false });
    expect(adminUnfreeze.status).toBe(403);
    expect((await owner.post(`/api/companies/${companyId}/crypto/wallets/${real.body.id}/freeze`, { frozen: false })).body.status).toBe("active");

    expect((await admin.patch(`/api/companies/${companyId}/crypto/settings`, { allWalletsFrozen: true })).body.allWalletsFrozen).toBe(true);
    expect((await admin.patch(`/api/companies/${companyId}/crypto/settings`, { allWalletsFrozen: false })).status).toBe(403);
    expect((await owner.patch(`/api/companies/${companyId}/crypto/settings`, { allWalletsFrozen: false })).body.allWalletsFrozen).toBe(false);
  });

  it("never re-sends a Hyperliquid order with an unclear answer; it only looks it up until it is found or can no longer be accepted", async () => {
    const { companyId, agentId } = await seed();
    const created = await boardApp(companyId, "owner").post(`/api/companies/${companyId}/crypto/wallets`, { agentId, chain: "hyperliquid", label: "Trader", mode: "generate" });
    const walletId = created.body.id as string;
    const agent = agentApp(companyId, agentId);
    const svc = cryptoWalletService(db, db, deps());
    hl.broadcastMode = "unclear";
    const order = (await agent.post(`/api/agent-wallets/${walletId}/hyperliquid-order`, { coin: "BTC", side: "buy", size: "0.05", limitPrice: "100", purpose: "Unclear" })).body;
    expect(order.status).toBe("submitted");
    expect(hl.broadcasts).toBe(1);

    now = new Date(now.getTime() + 30 * 60_000);
    await svc.tick(now);
    expect(hl.broadcasts).toBe(1); // looked up, never re-sent
    const statusOf = async () => (await db.select().from(cryptoWalletTransactions).where(eq(cryptoWalletTransactions.id, order.id)))[0]!;
    expect((await statusOf()).status).toBe("submitted");

    hl.statusAnswer = "failed"; // the exchange never saw it and the nonce window has passed
    await svc.tick(now);
    const settled = await statusOf();
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/Hyperliquid has no record of this/);
    expect(hl.broadcasts).toBe(1);
  });

  // ─── Owner sends (the recovery path) ───────────────────────────────────

  it("lets an owner/admin move funds out to an allowed address without agent limits, but never to another address", async () => {
    const { companyId, agentId } = await seed();
    const wallet = await makeSolanaWallet(companyId, agentId);
    const owner = boardApp(companyId, "owner");
    const to = await allow(companyId, wallet.id);
    const big = await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to, amount: "1.5", purpose: "Back to my own wallet" });
    expect(big.status).toBe(201);
    expect(big.body).toMatchObject({ status: "submitted", initiatedBy: "owner" });
    const elsewhere = await owner.post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to: randomSolAddress(), amount: "0.1", purpose: "Somewhere else" });
    expect(elsewhere.body.status).toBe("blocked");
    expect((await boardApp(companyId, "viewer").post(`/api/companies/${companyId}/crypto/wallets/${wallet.id}/send`, { to, amount: "0.1", purpose: "Viewer" })).status).toBe(403);
    expect(solState.sent).toHaveLength(1);
    // The signature in the broadcast transaction is from the wallet's own key.
    const tx = Buffer.from(solState.sent[0]!.raw, "base64");
    expect(base58Encode(new Uint8Array(tx.subarray(65 + 4, 65 + 4 + 32)))).toBe(wallet.address);
    expect(base58Decode(wallet.address)).toHaveLength(32);
  });
});
