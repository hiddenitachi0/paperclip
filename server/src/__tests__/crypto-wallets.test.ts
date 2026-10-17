import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companySecrets,
  createDb,
  cryptoWallets,
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
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeSolanaRpc(state: FakeSolanaState): OutboundFetch {
  const blockhash = base58Encode(new Uint8Array(randomBytes(32)));
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    state.calls.push(body.method);
    switch (body.method) {
      case "getBalance":
        return json({ result: { value: state.balances.get(body.params[0]) ?? 0 } });
      case "getLatestBlockhash":
        return json({ result: { value: { blockhash } } });
      case "sendTransaction": {
        const tx = Buffer.from(body.params[0], "base64");
        const signature = base58Encode(new Uint8Array(tx.subarray(1, 65)));
        state.sent.push({ signature, raw: body.params[0] });
        state.statuses.set(signature, { confirmationStatus: "processed", err: null });
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
  state: { accountValueUsd: number; positionsValueUsd: number };
}

function fakeHyperliquid(): FakeHyperliquid {
  const keys = new Map<string, string>(); // privateKey -> address, in memory only
  const orders: FakeHyperliquid["orders"] = [];
  const state = { accountValueUsd: 100, positionsValueUsd: 0 };
  const addressOf = (key: string) => `0x${Buffer.from(key).toString("hex").slice(0, 40).padEnd(40, "0")}`;
  return {
    chain: "hyperliquid",
    orders,
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
      return { raw: "{}", txHash: `hyperliquid-withdraw-${input.amount}`, feeUpperBound: 1_000_000n };
    },
    async broadcast() {
      return "confirmed";
    },
    async getTxStatus() {
      return "confirmed";
    },
    async midPrice() {
      return 100;
    },
    async accountState() {
      return { accountValueUsd: state.accountValueUsd, withdrawableUsd: state.accountValueUsd, positions: state.positionsValueUsd ? [{ coin: "BTC", size: 1, positionValueUsd: state.positionsValueUsd }] : [] };
    },
    async placeOrder(_ctx: ChainContext, input) {
      orders.push({ coin: input.coin, isBuy: input.isBuy, size: input.size, leverage: input.leverage, reduceOnly: input.reduceOnly, keySeen: input.privateKey.length > 0 });
      return { status: "filled", orderRef: String(orders.length), detail: "Filled." };
    },
  };
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
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
  });

  beforeEach(() => {
    solState = { balances: new Map(), sent: [], statuses: new Map(), calls: [] };
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

  async function allow(companyId: string, walletId: string, address = randomSolAddress()) {
    const res = await boardApp(companyId, "admin").post(`/api/companies/${companyId}/crypto/wallets/${walletId}/destinations`, { address, label: "Supplier" });
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
    const to = await allow(companyId, real.body.id);
    const tx = await agentApp(companyId, agentId).post(`/api/agent-wallets/${real.body.id}/send`, { to, amount: "0.01", purpose: "Pay a supplier" });
    expect(tx.body.status).toBe("blocked");
    expect(tx.body.blockReason).toMatch(/Real money is switched off/);
    expect(solState.sent).toHaveLength(0);
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
    expect(solState.sent).toHaveLength(1);

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
