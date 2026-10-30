import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign } from "node:crypto";
import {
  CRYPTO_CHAIN_INFO,
  CRYPTO_NETWORK_FEE_CEILING,
  EVM_CHAIN_IDS,
  EVM_MAX_FEE_PER_GAS,
  EVM_MAX_PRIORITY_FEE_PER_GAS,
  formatCryptoAmount,
  isTestEvmChainId,
  type BitcoinNetworkVariant,
  type CryptoChain,
  type CryptoNetwork,
} from "@paperclipai/shared";
import type { OutboundFetch } from "./safe-outbound-fetch.js";
import { assertCryptoRealMoneyAllowed } from "./crypto-real-money-lock.js";
import {
  base58Decode,
  base58Encode,
  bigintToBytes,
  bigintToFixedBytes,
  bytesToBigint,
  bytesToHex,
  concatBytes,
  decodeSegwitAddress,
  encodeSegwitAddress,
  hexToBytes,
  msgpackEncode,
  normalizeDecimalString,
  rlpEncode,
  type MsgpackValue,
} from "./crypto-wallet-encoding.js";

/**
 * Chain adapters for agent crypto wallets: key generation/import, address
 * checks, balances, and building + signing + broadcasting a payment.
 *
 * Rules every adapter follows:
 *   - A private key only ever arrives as a function argument from the wallet
 *     service (which resolved it from the secrets store a moment earlier)
 *     and is never logged, never put in an error message, never returned
 *     except by generateKey/importKey to the service that stores it.
 *   - Every network call goes through `ctx.fetch`, which the service builds
 *     with createSafeOutboundFetch (https only, the one configured host,
 *     public addresses only, no redirects, time and size caps).
 *   - Errors are plain sentences without request bodies.
 *
 * Signing libraries: Solana signs with Node's built-in Ed25519 (no extra
 * library). Bitcoin, Ethereum and Hyperliquid need audited secp256k1/keccak
 * libraries that are not yet dependencies of the server; they are loaded at
 * runtime (loadCryptoLibs below) and, until they are installed, those chains
 * refuse to create wallets or sign with a plain message. Tests inject fakes.
 */

export class CryptoChainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CryptoChainError";
    this.code = code;
  }
}

/**
 * Server-wide real-money lock (PAPERCLIP_CRYPTO_REAL_MONEY), enforced where
 * signatures are made so no route, agent tool or future caller can sign for a
 * main network while it is forbidden. Every signTransfer/signOrder checks it
 * first, before a key is touched; the Hyperliquid digests check it again
 * below, so even a new action type built on them cannot sign for Mainnet.
 * It throws a 403 with a plain sentence.
 */
function assertMainnetSigningAllowed(network: CryptoNetwork): void {
  if (network === "mainnet") assertCryptoRealMoneyAllowed();
}

/**
 * Hyperliquid marks the network inside what is signed: L1 actions carry
 * source 'a' for Mainnet ('b' for Testnet), and user-signed actions
 * (withdraw3, usdSend, ...) carry hyperliquidChain 'Mainnet'.
 */
function assertHyperliquidMainnetDigestAllowed(domainName: string, primaryType: string, message: Record<string, string | bigint | Uint8Array>): void {
  if (domainName === "Exchange" && primaryType === "Agent" && message.source === "a") assertCryptoRealMoneyAllowed();
  if (domainName === "HyperliquidSignTransaction" && message.hyperliquidChain === "Mainnet") assertCryptoRealMoneyAllowed();
}

export interface ChainContext {
  network: CryptoNetwork;
  /**
   * Bitcoin test wallets: the test network the wallet was created on. The
   * network service must prove (genesis block) it is that one, not just any
   * test network. Missing = testnet4, what every wallet from before signet is.
   */
  networkVariant?: BitcoinNetworkVariant;
  /** The endpoint for this chain and network (company setting or default). */
  rpcUrl: string;
  fetch: OutboundFetch;
  /**
   * The EVM chain ID stored on the wallet (Ethereum test wallets always have
   * one). It is the chain the wallet signs on, and the provider's chain ID must
   * match it and be on the code allow-list (TEST_EVM_CHAIN_IDS). A test wallet
   * without one is refused, never defaulted, so a default can move no wallet.
   */
  chainId?: number;
}

export interface SignedTransfer {
  /** What broadcast() sends. A signed transaction is public once sent; it never contains the key. */
  raw: string;
  /** Known before broadcast for Bitcoin/Ethereum/Solana; for Hyperliquid an internal reference. */
  txHash: string;
  /** The most this transaction can pay in network fees (never more than the budget it was signed with). */
  feeUpperBound: bigint;
  /** What getTxStatus needs later to tell "still on its way" from "can never land" (nonce, inputs, ...). */
  chainDetail?: Record<string, unknown>;
}

/**
 * "failed" is only ever returned on a definite answer that the transaction
 * did not and can never take effect. Anything unclear is "pending" or
 * "unknown" (keep counting it, keep checking), and trouble reaching the
 * network service is thrown, never reported as failed.
 */
export type ChainTxStatus = "pending" | "confirmed" | "failed" | "unknown";

/**
 * Mined (or confirmed) but the payment itself did not happen: the receiving
 * contract/program rejected it. The coins stayed, but the network fee was
 * paid -- `feePaid` (base units), which must keep counting toward limits.
 */
export interface RevertedTxStatus {
  status: "reverted";
  feePaid: bigint;
}

export type TxStatusCheck = ChainTxStatus | RevertedTxStatus;

export interface BroadcastResult {
  status: "pending" | "confirmed" | "failed";
  detail?: string;
}

export interface StoredTransfer {
  txHash: string;
  raw: string | null;
  chainDetail: Record<string, unknown> | null;
  from: string;
  /** The highest fee this transaction could pay (used when the exact fee is not reported). */
  feeUpperBound: bigint;
  /** When the check runs (tests move the clock). */
  checkedAt: Date;
}

export interface CryptoChainAdapter {
  chain: CryptoChain;
  generateKey(network: CryptoNetwork): Promise<{ privateKey: string; address: string }>;
  /** Accepts the formats wallets export (hex, WIF, base58, JSON byte array). Never echoes the input in an error. */
  importKey(raw: string, network: CryptoNetwork): Promise<{ privateKey: string; address: string }>;
  deriveAddress(privateKey: string, network: CryptoNetwork): Promise<string>;
  /** Normalized address, or null when it is not a valid address for this chain and network. */
  validateAddress(address: string, network: CryptoNetwork): Promise<string | null>;
  getBalance(ctx: ChainContext, address: string): Promise<{ balance: bigint; withdrawable?: bigint }>;
  /** The most a plain payment would cost in network fees right now, already capped by the chain's ceilings. */
  estimateFee(ctx: ChainContext, input: { from: string; to: string; amount: bigint }): Promise<bigint>;
  /** Refuses (CryptoChainError "fee_over_budget") when the fee could exceed maxFee. */
  signTransfer(ctx: ChainContext, input: { privateKey: string; from: string; to: string; amount: bigint; maxFee: bigint }): Promise<SignedTransfer>;
  /**
   * Sends exactly these signed bytes. Safe to call again with the same
   * bytes. Returns "failed" only on a definite rejection; throws when the
   * answer is unclear (the caller then keeps the payment counted and checks).
   */
  broadcast(ctx: ChainContext, signed: SignedTransfer): Promise<BroadcastResult>;
  getTxStatus(ctx: ChainContext, tx: StoredTransfer): Promise<TxStatusCheck>;
}

export interface HyperliquidAccountState {
  accountValueUsd: number;
  withdrawableUsd: number;
  positions: Array<{ coin: string; size: number; positionValueUsd: number }>;
}

export interface HyperliquidAdapter extends CryptoChainAdapter {
  chain: "hyperliquid";
  midPrice(ctx: ChainContext, coin: string): Promise<number | null>;
  /** Throws when the exchange's numbers do not add up (never lets NaN through). */
  accountState(ctx: ChainContext, address: string): Promise<HyperliquidAccountState>;
  /** Signs the leverage-cap action and the order. Sends nothing. */
  signOrder(
    ctx: ChainContext,
    input: { privateKey: string; coin: string; isBuy: boolean; size: string; limitPrice: string; reduceOnly: boolean; leverage: number },
  ): Promise<{ leverageRaw: string; order: SignedTransfer }>;
  /** Sets the leverage cap on the exchange. Throws unless the exchange clearly said yes. */
  applyLeverage(ctx: ChainContext, leverageRaw: string): Promise<void>;
}

export type CryptoChainAdapters = {
  bitcoin: CryptoChainAdapter;
  ethereum: CryptoChainAdapter;
  solana: CryptoChainAdapter;
  hyperliquid: HyperliquidAdapter;
};

// ─── Signing libraries (adapter) ─────────────────────────────────────────────

/**
 * The secp256k1/keccak operations Ethereum and Hyperliquid need, plus
 * Bitcoin's transaction builder. Real implementation: @noble/curves,
 * @noble/hashes and @scure/btc-signer, loaded by loadCryptoLibs().
 */
export interface CryptoLibs {
  keccak256(data: Uint8Array): Uint8Array;
  secp256k1RandomPrivateKey(): Uint8Array;
  secp256k1PublicKey(privateKey: Uint8Array, compressed: boolean): Uint8Array;
  /** ECDSA over a 32-byte digest (no extra hashing), low-S, with the recovery bit. */
  secp256k1SignDigest(digest: Uint8Array, privateKey: Uint8Array): { r: bigint; s: bigint; recovery: number };
  bitcoinSignP2wpkh(input: {
    privateKey: Uint8Array;
    network: CryptoNetwork;
    utxos: Array<{ txid: string; vout: number; value: bigint }>;
    outputs: Array<{ address: string; amount: bigint }>;
  }): { hex: string; txid: string };
}

export type CryptoLibsLoader = () => Promise<CryptoLibs>;

const LIBS_MISSING_MESSAGE =
  "Signing for this coin is not installed on this server yet. Ask the person who runs Paperclip to install the crypto signing libraries.";

async function importOptional(specifier: string): Promise<any> {
  // A variable specifier on purpose: these packages are optional until the
  // server lists them as dependencies, and TypeScript must not require them.
  return import(/* @vite-ignore */ specifier);
}

let cachedLibs: Promise<CryptoLibs> | null = null;

/** Real libraries. Rejects with a plain CryptoChainError when they are not installed. */
export const loadCryptoLibs: CryptoLibsLoader = () => {
  if (!cachedLibs) {
    cachedLibs = (async () => {
      try {
        const [{ secp256k1 }, { keccak_256 }, btc] = await Promise.all([
          importOptional("@noble/curves/secp256k1.js"),
          importOptional("@noble/hashes/sha3.js"),
          importOptional("@scure/btc-signer"),
        ]);
        const libs: CryptoLibs = {
          keccak256: (data) => keccak_256(data),
          secp256k1RandomPrivateKey: () => secp256k1.utils.randomSecretKey(),
          secp256k1PublicKey: (privateKey, compressed) => secp256k1.getPublicKey(privateKey, compressed),
          secp256k1SignDigest: (digest, privateKey) => {
            // noble v2: 'recovered' = [recovery, r(32), s(32)], low-S by default.
            const sig: Uint8Array = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
            return { recovery: sig[0]!, r: bytesToBigint(sig.subarray(1, 33)), s: bytesToBigint(sig.subarray(33, 65)) };
          },
          bitcoinSignP2wpkh: ({ privateKey, network, utxos, outputs }) => {
            const net = network === "mainnet" ? btc.NETWORK : btc.TEST_NETWORK;
            const payment = btc.p2wpkh(secp256k1.getPublicKey(privateKey, true), net);
            const tx = new btc.Transaction();
            for (const utxo of utxos) {
              tx.addInput({ txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: payment.script, amount: utxo.value } });
            }
            for (const output of outputs) tx.addOutputAddress(output.address, output.amount, net);
            tx.sign(privateKey);
            tx.finalize();
            return { hex: tx.hex as string, txid: tx.id as string };
          },
        };
        return libs;
      } catch {
        cachedLibs = null;
        throw new CryptoChainError("libs_missing", LIBS_MISSING_MESSAGE);
      }
    })();
  }
  return cachedLibs;
};

// ─── Shared network helpers ──────────────────────────────────────────────────

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function readJson(response: Response, what: string): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new CryptoChainError("bad_response", `${what} sent back something that is not valid data.`);
  }
}

async function jsonRpc(ctx: ChainContext, method: string, params: unknown[], what: string): Promise<any> {
  const response = await ctx.fetch(ctx.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new CryptoChainError("rpc_http", `${what} answered with an error (HTTP ${response.status}).`);
  const body = await readJson(response, what);
  if (body?.error) {
    const message = typeof body.error?.message === "string" ? body.error.message.slice(0, 200) : "unknown error";
    throw new CryptoChainError("rpc_error", `${what} refused the request: ${message}`);
  }
  return body?.result;
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function hash160(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("ripemd160").update(sha256(data)).digest());
}

function parsePrivateKeyHex(privateKey: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(privateKey);
  } catch {
    throw new CryptoChainError("bad_key", "The stored key is not in the expected format.");
  }
  if (bytes.length !== 32) throw new CryptoChainError("bad_key", "The stored key is not in the expected format.");
  return bytes;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function assertSecp256k1Scalar(bytes: Uint8Array): void {
  const value = bytesToBigint(bytes);
  if (value <= 0n || value >= SECP256K1_N) throw new CryptoChainError("bad_key", "That is not a valid private key.");
}

// ─── Bitcoin (native segwit, P2WPKH) ─────────────────────────────────────────

function btcHrp(network: CryptoNetwork): "bc" | "tb" {
  return network === "mainnet" ? "bc" : "tb";
}

/** Compressed public key from Node's own secp256k1 (no extra library needed for the address). */
function secp256k1CompressedPublicKeyNode(privateKey: Uint8Array): Uint8Array {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privateKey));
  return new Uint8Array(ecdh.getPublicKey(undefined, "compressed") as Buffer);
}

function bitcoinAddressFromKey(privateKey: Uint8Array, network: CryptoNetwork): string {
  return encodeSegwitAddress(btcHrp(network), 0, hash160(secp256k1CompressedPublicKeyNode(privateKey)));
}

function decodeWif(wif: string, network: CryptoNetwork): Uint8Array | null {
  let raw: Uint8Array;
  try {
    raw = base58Decode(wif);
  } catch {
    return null;
  }
  if (raw.length !== 38 && raw.length !== 37) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (Buffer.compare(Buffer.from(checksum), Buffer.from(expected)) !== 0) return null;
  const version = payload[0];
  if (version !== (network === "mainnet" ? 0x80 : 0xef)) return null;
  if (raw.length === 37) {
    throw new CryptoChainError("bad_key", "This is an old-style (uncompressed) bitcoin key. Only modern keys can be imported.");
  }
  if (payload[33] !== 0x01) return null;
  return payload.subarray(1, 33);
}

/** Bytes a P2WPKH spend takes, rounded up: overhead ~11, each input 68, each output 31. */
function p2wpkhVsize(inputs: number, outputs: number): number {
  return 11 + inputs * 68 + outputs * 31;
}

const BTC_DUST = 546n;
const BTC_MAX_FEE_RATE = 100; // sat/vB -- a fee spike above this waits rather than overpays.

const BTC_FEE_CEILING = BigInt(CRYPTO_NETWORK_FEE_CEILING.bitcoin);

/**
 * Genesis block ids: how a bitcoin service proves which network it is on
 * (Esplora answers GET /block-height/0 with the genesis hash). A test wallet
 * accepts only its own test network (testnet4 or signet), so a testnet4
 * wallet never talks to a signet service or the other way round; testnet3
 * (dead) is not accepted.
 */
export const BITCOIN_GENESIS_HASHES: Record<CryptoNetwork, string[]> = {
  testnet: [
    "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043", // testnet4
    "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6", // signet
  ],
  mainnet: ["000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"],
};

export const BITCOIN_TEST_GENESIS_HASHES: Record<BitcoinNetworkVariant, string> = {
  testnet4: BITCOIN_GENESIS_HASHES.testnet[0]!,
  signet: BITCOIN_GENESIS_HASHES.testnet[1]!,
};

function acceptedBitcoinGenesis(ctx: ChainContext): string[] {
  if (ctx.network === "mainnet") return BITCOIN_GENESIS_HASHES.mainnet;
  return [BITCOIN_TEST_GENESIS_HASHES[ctx.networkVariant ?? "testnet4"]];
}

/** Esplora answers for "this exact transaction is already there" -- a re-send of the same bytes, not a failure. */
const BTC_ALREADY_KNOWN = /already in block ?chain|txn-already-known|txn-already-in-mempool|already known/i;

export function bitcoinAdapter(loadLibs: CryptoLibsLoader = loadCryptoLibs): CryptoChainAdapter {
  async function assertGenesis(ctx: ChainContext): Promise<void> {
    const response = await ctx.fetch(joinUrl(ctx.rpcUrl, "/block-height/0"));
    if (!response.ok) throw new CryptoChainError("rpc_http", `The bitcoin network service answered with an error (HTTP ${response.status}).`);
    const genesis = (await response.text()).trim().toLowerCase();
    if (!acceptedBitcoinGenesis(ctx).includes(genesis)) {
      throw new CryptoChainError(
        "wrong_network",
        `The bitcoin network service is not on the ${ctx.network === "mainnet" ? "main network" : `test network (${ctx.networkVariant ?? "testnet4"})`} this wallet belongs to. Check the network address in the crypto settings.`,
      );
    }
  }

  async function feeRate(ctx: ChainContext): Promise<number> {
    try {
      const response = await ctx.fetch(joinUrl(ctx.rpcUrl, "/fee-estimates"));
      if (!response.ok) return 2;
      const estimates = await readJson(response, "The bitcoin network service");
      const rate = Number(estimates?.["3"] ?? estimates?.["2"] ?? estimates?.["6"]);
      if (!Number.isFinite(rate) || rate <= 0) return 2;
      return Math.max(1, Math.ceil(rate));
    } catch {
      return 2;
    }
  }

  async function confirmedUtxos(ctx: ChainContext, address: string) {
    const response = await ctx.fetch(joinUrl(ctx.rpcUrl, `/address/${address}/utxo`));
    if (!response.ok) throw new CryptoChainError("rpc_http", `The bitcoin network service answered with an error (HTTP ${response.status}).`);
    const list = (await readJson(response, "The bitcoin network service")) as Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>;
    if (!Array.isArray(list)) throw new CryptoChainError("bad_response", "The bitcoin network service sent back an unexpected answer.");
    return list
      .filter((u) => u?.status?.confirmed === true && /^[0-9a-f]{64}$/.test(u.txid) && Number.isSafeInteger(u.value) && Number.isSafeInteger(u.vout))
      .map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) }))
      .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  }

  function plan(utxos: Array<{ txid: string; vout: number; value: bigint }>, amount: bigint, rate: number) {
    const chosen: typeof utxos = [];
    let total = 0n;
    for (const utxo of utxos) {
      chosen.push(utxo);
      total += utxo.value;
      const feeWithChange = BigInt(p2wpkhVsize(chosen.length, 2) * rate);
      if (total >= amount + feeWithChange) {
        const change = total - amount - feeWithChange;
        if (change >= BTC_DUST) return { chosen, fee: feeWithChange, change };
        // Change too small to be worth an output: it goes to the network fee.
        return { chosen, fee: total - amount, change: 0n };
      }
    }
    return null;
  }

  return {
    chain: "bitcoin",
    async generateKey(network) {
      let key: Uint8Array;
      do key = new Uint8Array(randomBytes(32));
      while (bytesToBigint(key) === 0n || bytesToBigint(key) >= SECP256K1_N);
      return { privateKey: bytesToHex(key), address: bitcoinAddressFromKey(key, network) };
    },
    async importKey(raw, network) {
      const trimmed = raw.trim();
      let key: Uint8Array | null = null;
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) key = hexToBytes(trimmed);
      else key = decodeWif(trimmed, network);
      if (!key) {
        throw new CryptoChainError(
          "bad_key",
          `That is not a bitcoin private key for the ${network === "mainnet" ? "main" : "test"} network. Paste the key itself (it starts with K, L, c or is 64 letters and digits), not the recovery words.`,
        );
      }
      assertSecp256k1Scalar(key);
      return { privateKey: bytesToHex(key), address: bitcoinAddressFromKey(key, network) };
    },
    async deriveAddress(privateKey, network) {
      return bitcoinAddressFromKey(parsePrivateKeyHex(privateKey), network);
    },
    async validateAddress(address, network) {
      const lower = address.trim().toLowerCase();
      const decoded = decodeSegwitAddress(btcHrp(network), lower);
      return decoded ? lower : null;
    },
    async getBalance(ctx, address) {
      const response = await ctx.fetch(joinUrl(ctx.rpcUrl, `/address/${address}`));
      if (!response.ok) throw new CryptoChainError("rpc_http", `The bitcoin network service answered with an error (HTTP ${response.status}).`);
      const body = await readJson(response, "The bitcoin network service");
      const chain = body?.chain_stats ?? {};
      const mempool = body?.mempool_stats ?? {};
      const balance =
        BigInt(chain.funded_txo_sum ?? 0) - BigInt(chain.spent_txo_sum ?? 0) + BigInt(mempool.funded_txo_sum ?? 0) - BigInt(mempool.spent_txo_sum ?? 0);
      return { balance };
    },
    async estimateFee(ctx, { from, amount }) {
      const rate = await feeRate(ctx);
      if (rate > BTC_MAX_FEE_RATE) {
        throw new CryptoChainError("fee_too_high", "Bitcoin network fees are unusually high right now. Try again later.");
      }
      const utxos = await confirmedUtxos(ctx, from);
      const planned = plan(utxos, amount, rate);
      const fee = planned ? planned.fee : BigInt(p2wpkhVsize(1, 2) * rate);
      if (fee > BTC_FEE_CEILING) throw new CryptoChainError("fee_too_high", "The bitcoin network fee for this payment would be above Paperclip's ceiling.");
      return fee;
    },
    async signTransfer(ctx, { privateKey, from, to, amount, maxFee }) {
      assertMainnetSigningAllowed(ctx.network);
      const libs = await loadLibs();
      await assertGenesis(ctx);
      const rate = await feeRate(ctx);
      if (rate > BTC_MAX_FEE_RATE) {
        throw new CryptoChainError("fee_too_high", "Bitcoin network fees are unusually high right now. Try again later.");
      }
      const utxos = await confirmedUtxos(ctx, from);
      const planned = plan(utxos, amount, rate);
      if (!planned) throw new CryptoChainError("insufficient_funds", "The wallet does not have enough confirmed bitcoin for this payment and its network fee.");
      if (planned.fee > maxFee || planned.fee > BTC_FEE_CEILING) {
        throw new CryptoChainError("fee_over_budget", "The bitcoin network fee went up above what this payment reserved. Nothing was sent; try again.");
      }
      const outputs = [{ address: to, amount }];
      if (planned.change > 0n) outputs.push({ address: from, amount: planned.change });
      const signed = libs.bitcoinSignP2wpkh({ privateKey: parsePrivateKeyHex(privateKey), network: ctx.network, utxos: planned.chosen, outputs });
      return {
        raw: signed.hex,
        txHash: signed.txid,
        feeUpperBound: planned.fee,
        chainDetail: { inputs: planned.chosen.map((u) => ({ txid: u.txid, vout: u.vout })) },
      };
    },
    async broadcast(ctx, signed) {
      const response = await ctx.fetch(joinUrl(ctx.rpcUrl, "/tx"), { method: "POST", headers: { "content-type": "text/plain" }, body: signed.raw });
      const text = (await response.text()).trim();
      if (response.ok) {
        if (text && text !== signed.txHash) throw new CryptoChainError("broadcast_mismatch", "The bitcoin network service answered with a different transaction id.");
        return { status: "pending" };
      }
      if (BTC_ALREADY_KNOWN.test(text)) return { status: "pending" };
      // Any other refusal is not taken as final: the same bytes may already
      // be on their way. The network check decides.
      throw new CryptoChainError("broadcast_unclear", `The bitcoin network service did not accept the payment cleanly: ${text.slice(0, 200)}`);
    },
    async getTxStatus(ctx, tx) {
      const response = await ctx.fetch(joinUrl(ctx.rpcUrl, `/tx/${tx.txHash}/status`));
      if (response.ok) {
        const body = await readJson(response, "The bitcoin network service");
        return body?.confirmed === true ? "confirmed" : "pending";
      }
      if (response.status !== 404) {
        // 5xx, 429 and the like: the service is unwell, not the payment.
        throw new CryptoChainError("rpc_http", `The bitcoin network service answered with an error (HTTP ${response.status}).`);
      }
      // Not seen. It is only dead for sure once one of its inputs has been
      // spent by a DIFFERENT transaction (then it can never be valid).
      const inputs = Array.isArray(tx.chainDetail?.inputs) ? (tx.chainDetail!.inputs as Array<{ txid: string; vout: number }>) : [];
      for (const input of inputs) {
        const out = await ctx.fetch(joinUrl(ctx.rpcUrl, `/tx/${input.txid}/outspend/${input.vout}`));
        if (!out.ok) throw new CryptoChainError("rpc_http", `The bitcoin network service answered with an error (HTTP ${out.status}).`);
        const spend = await readJson(out, "The bitcoin network service");
        if (spend?.spent === true && typeof spend.txid === "string" && spend.txid !== tx.txHash) return "failed";
        if (spend?.spent === true && spend.txid === tx.txHash) return "pending";
      }
      return "unknown";
    },
  };
}

// ─── Ethereum (EVM) ──────────────────────────────────────────────────────────

export function evmAddressFromKey(libs: CryptoLibs, privateKey: Uint8Array): string {
  const pub = libs.secp256k1PublicKey(privateKey, false);
  return `0x${bytesToHex(libs.keccak256(pub.subarray(1)).subarray(12))}`;
}

/** EIP-55 checksum form of a lower-case 0x address. */
export function evmChecksumAddress(libs: CryptoLibs, lowerAddress: string): string {
  const hex = lowerAddress.slice(2);
  const hash = bytesToHex(libs.keccak256(new TextEncoder().encode(hex)));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) out += parseInt(hash[i]!, 16) >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  return out;
}

async function validateEvmAddress(loadLibs: CryptoLibsLoader, address: string): Promise<string | null> {
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  const body = trimmed.slice(2);
  const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixedCase) {
    // A mixed-case address carries a checksum; a typo would break it. Without
    // the hashing library we cannot check it, so we refuse rather than guess.
    const libs = await loadLibs();
    if (evmChecksumAddress(libs, trimmed.toLowerCase()) !== trimmed) return null;
  }
  if (/^0x0{40}$/i.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function evmImport(libs: CryptoLibs, raw: string): { privateKey: string; address: string } {
  const trimmed = raw.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new CryptoChainError(
      "bad_key",
      "That is not an Ethereum private key. Paste the key itself (64 letters and digits, often starting with 0x), not the recovery words.",
    );
  }
  const key = hexToBytes(trimmed);
  assertSecp256k1Scalar(key);
  return { privateKey: bytesToHex(key), address: evmAddressFromKey(libs, key) };
}

function hexQuantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new CryptoChainError("bad_response", `${what} sent back an unexpected number.`);
  }
  return value === "0x" ? 0n : BigInt(value);
}

const EVM_MAX_GAS = 100_000n;

const EVM_FEE_CEILING = BigInt(CRYPTO_NETWORK_FEE_CEILING.ethereum);
/** JSON-RPC answers that mean "this exact transaction is already in the pool" -- not a failure. */
const EVM_ALREADY_KNOWN = /already known|known transaction|already imported|alreadyknown/i;

/**
 * The gas prices the network service reports are never trusted as-is: the
 * tip is clamped to EVM_MAX_PRIORITY_FEE_PER_GAS, the price per gas unit to
 * EVM_MAX_FEE_PER_GAS, and when the network's own base fee is above what
 * that allows, the payment is refused rather than overpaid.
 */
export function cappedEvmFees(baseFee: bigint, reportedPriority: bigint): { maxFee: bigint; priority: bigint } {
  const priority = reportedPriority > EVM_MAX_PRIORITY_FEE_PER_GAS ? EVM_MAX_PRIORITY_FEE_PER_GAS : reportedPriority < 0n ? 0n : reportedPriority;
  const wanted = baseFee * 2n + priority;
  const maxFee = wanted > EVM_MAX_FEE_PER_GAS ? EVM_MAX_FEE_PER_GAS : wanted;
  if (maxFee < baseFee + priority) {
    throw new CryptoChainError("fee_too_high", "Ethereum network fees are unusually high right now. Try again later.");
  }
  return { maxFee, priority };
}

export function ethereumAdapter(loadLibs: CryptoLibsLoader = loadCryptoLibs): CryptoChainAdapter {
  const what = "The Ethereum network service";

  /** Chain ID this wallet signs for: mainnet is fixed; a test wallet uses its stored chain ID (Sepolia until one is stored), which must be on the code allow-list. */
  function expectedChainId(ctx: ChainContext): bigint {
    if (ctx.network === "mainnet") return BigInt(EVM_CHAIN_IDS.mainnet);
    if (ctx.chainId === undefined) {
      throw new CryptoChainError("wrong_network", "This wallet has no stored chain, so nothing was signed.");
    }
    const wanted = BigInt(ctx.chainId);
    if (!isTestEvmChainId(wanted)) {
      throw new CryptoChainError("wrong_network", "This wallet's stored chain is not an allowed test network, so nothing was signed.");
    }
    return wanted;
  }

  /**
   * The provider must be on the very chain the wallet belongs to. For a test
   * wallet that chain must also be on the allow-list, so no RPC override can
   * make a test wallet sign on chain 1, 8453, 42161 or any other real chain.
   * Returns the verified chain ID, which is the one the transaction is signed for.
   */
  async function assertChainId(ctx: ChainContext): Promise<bigint> {
    const expected = expectedChainId(ctx);
    const chainId = hexQuantity(await jsonRpc(ctx, "eth_chainId", [], what), what);
    if (chainId !== expected || (ctx.network === "testnet" && !isTestEvmChainId(chainId))) {
      throw new CryptoChainError(
        "wrong_network",
        `The Ethereum network service is on a different network than this wallet (${ctx.network === "mainnet" ? "main network" : "test network"}). Check the network address in the crypto settings.`,
      );
    }
    return chainId;
  }

  async function feeParams(ctx: ChainContext, from: string, to: string, amount: bigint) {
    const block = await jsonRpc(ctx, "eth_getBlockByNumber", ["latest", false], what);
    const baseFee = hexQuantity(block?.baseFeePerGas, what);
    let reported = 1_500_000_000n;
    try {
      reported = hexQuantity(await jsonRpc(ctx, "eth_maxPriorityFeePerGas", [], what), what);
    } catch {
      // Some endpoints do not offer this; 1.5 gwei is a safe tip.
    }
    const { maxFee, priority } = cappedEvmFees(baseFee, reported);
    const gas = hexQuantity(await jsonRpc(ctx, "eth_estimateGas", [{ from, to, value: `0x${amount.toString(16)}` }], what), what);
    if (gas > EVM_MAX_GAS) {
      throw new CryptoChainError("gas_too_high", "This address is a program that needs more network fee than a plain payment is allowed to use.");
    }
    if (gas < 21_000n) throw new CryptoChainError("bad_response", `${what} reported an impossible gas amount.`);
    const feeUpperBound = gas * maxFee;
    if (feeUpperBound > EVM_FEE_CEILING) {
      throw new CryptoChainError("fee_too_high", "The Ethereum network fee for this payment would be above Paperclip's ceiling.");
    }
    return { maxFee, priority, gas, feeUpperBound };
  }

  return {
    chain: "ethereum",
    async generateKey() {
      const libs = await loadLibs();
      const key = libs.secp256k1RandomPrivateKey();
      return { privateKey: bytesToHex(key), address: evmAddressFromKey(libs, key) };
    },
    async importKey(raw) {
      return evmImport(await loadLibs(), raw);
    },
    async deriveAddress(privateKey) {
      return evmAddressFromKey(await loadLibs(), parsePrivateKeyHex(privateKey));
    },
    async validateAddress(address) {
      return validateEvmAddress(loadLibs, address);
    },
    async getBalance(ctx, address) {
      return { balance: hexQuantity(await jsonRpc(ctx, "eth_getBalance", [address, "latest"], what), what) };
    },
    async estimateFee(ctx, { from, to, amount }) {
      return (await feeParams(ctx, from, to, amount)).feeUpperBound;
    },
    async signTransfer(ctx, { privateKey, from, to, amount, maxFee }) {
      assertMainnetSigningAllowed(ctx.network);
      const libs = await loadLibs();
      const chainId = await assertChainId(ctx);
      const nonce = hexQuantity(await jsonRpc(ctx, "eth_getTransactionCount", [from, "pending"], what), what);
      const fees = await feeParams(ctx, from, to, amount);
      if (fees.feeUpperBound > maxFee) {
        throw new CryptoChainError("fee_over_budget", "The Ethereum network fee went up above what this payment reserved. Nothing was sent; try again.");
      }
      const fields = [
        bigintToBytes(chainId),
        bigintToBytes(nonce),
        bigintToBytes(fees.priority),
        bigintToBytes(fees.maxFee),
        bigintToBytes(fees.gas),
        hexToBytes(to),
        bigintToBytes(amount),
        new Uint8Array(0),
        [],
      ];
      const unsigned = concatBytes(Uint8Array.of(0x02), rlpEncode(fields));
      const sig = libs.secp256k1SignDigest(libs.keccak256(unsigned), parsePrivateKeyHex(privateKey));
      const signed = concatBytes(
        Uint8Array.of(0x02),
        rlpEncode([...fields, bigintToBytes(BigInt(sig.recovery)), bigintToBytes(sig.r), bigintToBytes(sig.s)]),
      );
      return {
        raw: `0x${bytesToHex(signed)}`,
        txHash: `0x${bytesToHex(libs.keccak256(signed))}`,
        feeUpperBound: fees.feeUpperBound,
        chainDetail: { nonce: nonce.toString() },
      };
    },
    async broadcast(ctx, signed) {
      let hash: unknown;
      try {
        hash = await jsonRpc(ctx, "eth_sendRawTransaction", [signed.raw], what);
      } catch (err) {
        if (err instanceof CryptoChainError && err.code === "rpc_error" && EVM_ALREADY_KNOWN.test(err.message)) return { status: "pending" };
        throw err;
      }
      if (typeof hash === "string" && hash.toLowerCase() !== signed.txHash.toLowerCase()) {
        throw new CryptoChainError("broadcast_mismatch", "The Ethereum network service answered with a different transaction id.");
      }
      return { status: "pending" };
    },
    async getTxStatus(ctx, tx) {
      const receipt = await jsonRpc(ctx, "eth_getTransactionReceipt", [tx.txHash], what);
      if (receipt) {
        if (receipt.status === "0x1") return "confirmed";
        if (receipt.status === "0x0") {
          // Mined but reverted by the receiving contract: no ETH moved, but
          // gas was paid. gasUsed x effectiveGasPrice is the exact fee; if the
          // node leaves either out, count the highest it could have been.
          let feePaid = tx.feeUpperBound;
          try {
            const exact = hexQuantity(receipt.gasUsed, what) * hexQuantity(receipt.effectiveGasPrice, what);
            if (exact >= 0n && exact <= tx.feeUpperBound) feePaid = exact;
          } catch {
            // keep the upper bound
          }
          return { status: "reverted", feePaid };
        }
        return "unknown";
      }
      // No receipt. Ethereum transactions never expire, so it is only dead
      // for sure once its nonce has been used by another, mined transaction.
      const nonceText = tx.chainDetail?.nonce;
      if (typeof nonceText !== "string") return "pending";
      const mined = hexQuantity(await jsonRpc(ctx, "eth_getTransactionCount", [tx.from, "latest"], what), what);
      if (mined > BigInt(nonceText)) {
        // Look once more for ours, in case the receipt lookup lagged behind.
        const again = await jsonRpc(ctx, "eth_getTransactionByHash", [tx.txHash], what);
        if (again?.blockNumber) return "pending";
        return "failed";
      }
      return "pending";
    },
  };
}

// ─── Solana (Node's built-in Ed25519, no extra library) ─────────────────────

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SOLANA_SYSTEM_PROGRAM = new Uint8Array(32);
const SOLANA_FEE_LAMPORTS = 5_000n;
/** Genesis block ids: how a Solana service proves which network it is on. */
export const SOLANA_GENESIS_HASHES: Record<CryptoNetwork, string[]> = {
  // devnet (the default test network) and testnet
  testnet: ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"],
  mainnet: ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"],
};
/** Extra blocks past a transaction's last valid height before calling it dead (finalized lags a little). */
const SOLANA_EXPIRY_MARGIN_BLOCKS = 150;
/** A brand-new Solana account must receive at least this much or the network refuses the payment. */
export const SOLANA_RENT_EXEMPT_MINIMUM = 890_880n;

function solanaKeyObject(seed: Uint8Array) {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}

function solanaPublicKey(seed: Uint8Array): Uint8Array {
  const der = createPublicKey(solanaKeyObject(seed)).export({ format: "der", type: "spki" }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function compactU16(n: number): Uint8Array {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      return Uint8Array.from(out);
    }
    elem |= 0x80;
    out.push(elem);
  }
}

/** A legacy Solana message with one System Program transfer. */
export function solanaTransferMessage(from: Uint8Array, to: Uint8Array, lamports: bigint, recentBlockhash: Uint8Array): Uint8Array {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  return concatBytes(
    Uint8Array.of(1, 0, 1), // 1 signer, 0 read-only signed, 1 read-only unsigned (the program)
    compactU16(3),
    from,
    to,
    SOLANA_SYSTEM_PROGRAM,
    recentBlockhash,
    compactU16(1),
    Uint8Array.of(2), // program id index
    compactU16(2),
    Uint8Array.of(0, 1),
    compactU16(data.length),
    data,
  );
}

export function solanaAdapter(): CryptoChainAdapter {
  const what = "The Solana network service";

  function seedOf(privateKey: string): Uint8Array {
    return parsePrivateKeyHex(privateKey);
  }

  return {
    chain: "solana",
    async generateKey() {
      const { privateKey } = generateKeyPairSync("ed25519");
      const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
      const seed = new Uint8Array(der.subarray(der.length - 32));
      return { privateKey: bytesToHex(seed), address: base58Encode(solanaPublicKey(seed)) };
    },
    async importKey(raw) {
      const trimmed = raw.trim();
      let bytes: Uint8Array | null = null;
      try {
        if (trimmed.startsWith("[")) {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Uint8Array.from(arr);
        } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
          bytes = hexToBytes(trimmed);
        } else {
          bytes = base58Decode(trimmed);
        }
      } catch {
        bytes = null;
      }
      if (!bytes || (bytes.length !== 64 && bytes.length !== 32)) {
        throw new CryptoChainError(
          "bad_key",
          "That is not a Solana private key. Paste the exported key (a long base58 text or a list of 64 numbers), not the recovery words.",
        );
      }
      const seed = bytes.subarray(0, 32);
      const pub = solanaPublicKey(seed);
      if (bytes.length === 64 && Buffer.compare(Buffer.from(bytes.subarray(32)), Buffer.from(pub)) !== 0) {
        throw new CryptoChainError("bad_key", "That Solana key does not add up (its two halves do not match). Check you copied all of it.");
      }
      return { privateKey: bytesToHex(seed), address: base58Encode(pub) };
    },
    async deriveAddress(privateKey) {
      return base58Encode(solanaPublicKey(seedOf(privateKey)));
    },
    async validateAddress(address) {
      const trimmed = address.trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return null;
      try {
        const bytes = base58Decode(trimmed);
        if (bytes.length !== 32 || bytes.every((b) => b === 0)) return null;
      } catch {
        return null;
      }
      return trimmed;
    },
    async getBalance(ctx, address) {
      const result = await jsonRpc(ctx, "getBalance", [address, { commitment: "confirmed" }], what);
      const value = result?.value;
      if (!Number.isSafeInteger(value)) throw new CryptoChainError("bad_response", `${what} sent back an unexpected balance.`);
      return { balance: BigInt(value) };
    },
    async estimateFee() {
      // A plain one-signature transfer always costs exactly this; Paperclip
      // never adds a priority fee, so the network service cannot raise it.
      return SOLANA_FEE_LAMPORTS;
    },
    async signTransfer(ctx, { privateKey, from, to, amount, maxFee }) {
      assertMainnetSigningAllowed(ctx.network);
      if (SOLANA_FEE_LAMPORTS > maxFee) {
        throw new CryptoChainError("fee_over_budget", "This payment did not reserve enough for the Solana network fee.");
      }
      const seed = seedOf(privateKey);
      const fromKey = solanaPublicKey(seed);
      if (base58Encode(fromKey) !== from) throw new CryptoChainError("key_mismatch", "The stored key does not belong to this wallet.");
      const toKey = base58Decode(to);
      if (Buffer.compare(Buffer.from(fromKey), Buffer.from(toKey)) === 0) {
        throw new CryptoChainError("self_send", "A wallet cannot send to itself.");
      }
      // Which network is this service really on? A test wallet must never
      // sign on the main network (and the other way round), whatever
      // address the settings point at.
      const genesis = await jsonRpc(ctx, "getGenesisHash", [], what);
      if (typeof genesis !== "string" || !SOLANA_GENESIS_HASHES[ctx.network].includes(genesis)) {
        throw new CryptoChainError(
          "wrong_network",
          `The Solana network service is not on the ${ctx.network === "mainnet" ? "main network" : "test network (devnet)"} this wallet belongs to. Check the network address in the crypto settings.`,
        );
      }
      const target = await jsonRpc(ctx, "getBalance", [to, { commitment: "confirmed" }], what);
      if (Number(target?.value ?? 0) === 0 && amount < SOLANA_RENT_EXEMPT_MINIMUM) {
        throw new CryptoChainError(
          "below_rent_minimum",
          "That address has no SOL yet, and the Solana network refuses a first payment smaller than 0.00089088 SOL.",
        );
      }
      const latest = await jsonRpc(ctx, "getLatestBlockhash", [{ commitment: "finalized" }], what);
      const blockhash = latest?.value?.blockhash;
      const lastValidBlockHeight = latest?.value?.lastValidBlockHeight;
      if (typeof blockhash !== "string" || !Number.isSafeInteger(lastValidBlockHeight)) {
        throw new CryptoChainError("bad_response", `${what} did not send a recent block id.`);
      }
      const message = solanaTransferMessage(fromKey, toKey, amount, base58Decode(blockhash));
      const signature = new Uint8Array(nodeSign(null, Buffer.from(message), solanaKeyObject(seed)));
      const tx = concatBytes(compactU16(1), signature, message);
      return {
        raw: Buffer.from(tx).toString("base64"),
        txHash: base58Encode(signature),
        feeUpperBound: SOLANA_FEE_LAMPORTS,
        chainDetail: { lastValidBlockHeight },
      };
    },
    async broadcast(ctx, signed) {
      let sig: unknown;
      try {
        sig = await jsonRpc(ctx, "sendTransaction", [signed.raw, { encoding: "base64", preflightCommitment: "confirmed" }], what);
      } catch (err) {
        if (err instanceof CryptoChainError && err.code === "rpc_error" && /already been processed|AlreadyProcessed/i.test(err.message)) {
          return { status: "pending" };
        }
        throw err;
      }
      if (typeof sig === "string" && sig !== signed.txHash) {
        throw new CryptoChainError("broadcast_mismatch", "The Solana network service answered with a different transaction id.");
      }
      return { status: "pending" };
    },
    async getTxStatus(ctx, tx) {
      const result = await jsonRpc(ctx, "getSignatureStatuses", [[tx.txHash], { searchTransactionHistory: true }], what);
      const status = result?.value?.[0];
      if (status) {
        const settled = status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
        if (!settled) return "pending";
        // Confirmed with an error: the transfer did not happen, but the
        // fixed signature fee was paid.
        return status.err ? { status: "reverted", feePaid: SOLANA_FEE_LAMPORTS } : "confirmed";
      }
      // Not seen. A Solana transaction can only land while its block id is
      // valid; once the finalized chain is well past that height, it never can.
      const lastValid = Number(tx.chainDetail?.lastValidBlockHeight);
      if (!Number.isSafeInteger(lastValid)) return "unknown";
      const height = await jsonRpc(ctx, "getBlockHeight", [{ commitment: "finalized" }], what);
      if (Number.isSafeInteger(height) && height > lastValid + SOLANA_EXPIRY_MARGIN_BLOCKS) return "failed";
      return "unknown";
    },
  };
}

// ─── EIP-712 (Hyperliquid signatures) ────────────────────────────────────────

type Eip712Field = { name: string; type: "string" | "bytes32" | "uint64" | "uint256" | "address" };

function eip712TypeString(name: string, fields: Eip712Field[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

function eip712Encode(libs: CryptoLibs, name: string, fields: Eip712Field[], values: Record<string, string | bigint | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [libs.keccak256(new TextEncoder().encode(eip712TypeString(name, fields)))];
  for (const field of fields) {
    const value = values[field.name];
    switch (field.type) {
      case "string":
        parts.push(libs.keccak256(new TextEncoder().encode(String(value))));
        break;
      case "bytes32":
        parts.push(value as Uint8Array);
        break;
      case "uint64":
      case "uint256":
        parts.push(bigintToFixedBytes(BigInt(value as bigint | string), 32));
        break;
      case "address":
        parts.push(bigintToFixedBytes(BigInt(value as string), 32));
        break;
    }
  }
  return libs.keccak256(concatBytes(...parts));
}

const EIP712_DOMAIN_FIELDS: Eip712Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export function eip712Digest(
  libs: CryptoLibs,
  domain: { name: string; version: string; chainId: bigint; verifyingContract: string },
  primaryType: string,
  fields: Eip712Field[],
  message: Record<string, string | bigint | Uint8Array>,
): Uint8Array {
  assertHyperliquidMainnetDigestAllowed(domain.name, primaryType, message);
  const domainSeparator = eip712Encode(libs, "EIP712Domain", EIP712_DOMAIN_FIELDS, domain);
  const structHash = eip712Encode(libs, primaryType, fields, message);
  return libs.keccak256(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator, structHash));
}

function rsv(sig: { r: bigint; s: bigint; recovery: number }) {
  return { r: `0x${bytesToHex(bigintToFixedBytes(sig.r, 32))}`, s: `0x${bytesToHex(bigintToFixedBytes(sig.s, 32))}`, v: 27 + sig.recovery };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Hyperliquid's "L1 action" signature: msgpack(action) + nonce + no-vault byte, signed as a phantom agent. */
export function hyperliquidL1ActionDigest(libs: CryptoLibs, action: MsgpackValue, nonce: bigint, network: CryptoNetwork): Uint8Array {
  assertMainnetSigningAllowed(network);
  const connectionId = libs.keccak256(concatBytes(msgpackEncode(action), bigintToFixedBytes(nonce, 8), Uint8Array.of(0)));
  return eip712Digest(
    libs,
    { name: "Exchange", version: "1", chainId: 1337n, verifyingContract: ZERO_ADDRESS },
    "Agent",
    [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
    { source: network === "mainnet" ? "a" : "b", connectionId },
  );
}

export function hyperliquidWithdrawDigest(libs: CryptoLibs, input: { hyperliquidChain: string; destination: string; amount: string; time: bigint }): Uint8Array {
  return eip712Digest(
    libs,
    { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66een, verifyingContract: ZERO_ADDRESS },
    "HyperliquidTransaction:Withdraw",
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
    input,
  );
}

// ─── Hyperliquid ─────────────────────────────────────────────────────────────

function usdcUnits(value: unknown): bigint {
  const text = typeof value === "string" ? value : typeof value === "number" ? value.toFixed(6) : "0";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return 0n;
  const units = BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0") || "0");
  return match[1] === "-" ? -units : units;
}

const HYPERLIQUID_WITHDRAW_FEE = BigInt(CRYPTO_NETWORK_FEE_CEILING.hyperliquid);

/**
 * Hyperliquid only accepts an action whose nonce (a millisecond time) is
 * within two days before the exchange's clock. Past that (plus an hour of
 * margin) an action that was never seen can never be accepted any more.
 */
export const HYPERLIQUID_NONCE_ACCEPTANCE_MS = 2 * 24 * 60 * 60_000;
const HYPERLIQUID_GIVE_UP_AFTER_MS = HYPERLIQUID_NONCE_ACCEPTANCE_MS + 60 * 60_000;

/** Order outcomes Hyperliquid reports for an order that was refused when placed. */
function isRejectedOrderStatus(status: unknown): boolean {
  return typeof status === "string" && /rejected$/i.test(status);
}

// Shared by every adapter instance in this process, so two signed actions
// never carry the same nonce (Hyperliquid treats a nonce as used once).
let lastHyperliquidNonce = 0;

function hyperliquidRejection(response: any): string {
  return typeof response?.response === "string" ? response.response.slice(0, 200) : "no reason given";
}

function finiteNumber(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new CryptoChainError("bad_response", `The Hyperliquid exchange sent back a ${what} that is not a number.`);
  return n;
}

export function hyperliquidAdapter(loadLibs: CryptoLibsLoader = loadCryptoLibs, nowMs: () => number = () => Date.now()): HyperliquidAdapter {
  const nextNonce = () => {
    lastHyperliquidNonce = Math.max(nowMs(), lastHyperliquidNonce + 1);
    return lastHyperliquidNonce;
  };

  async function post(ctx: ChainContext, path: "/info" | "/exchange", body: unknown): Promise<any> {
    const response = await ctx.fetch(joinUrl(ctx.rpcUrl, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new CryptoChainError("rpc_http", `The Hyperliquid exchange answered with an error (HTTP ${response.status}).`);
    }
    return readJson(response, "The Hyperliquid exchange");
  }

  async function assetIndex(ctx: ChainContext, coin: string): Promise<{ index: number; szDecimals: number; maxLeverage: number }> {
    const meta = await post(ctx, "/info", { type: "meta" });
    const universe = Array.isArray(meta?.universe) ? meta.universe : [];
    const index = universe.findIndex((asset: { name?: string }) => asset?.name === coin);
    if (index < 0) throw new CryptoChainError("unknown_coin", `Hyperliquid does not list ${coin} for trading.`);
    const szDecimals = Number(universe[index].szDecimals ?? 0);
    const maxLeverage = Number(universe[index].maxLeverage ?? 1);
    if (!Number.isInteger(szDecimals) || !Number.isFinite(maxLeverage)) {
      throw new CryptoChainError("bad_response", "The Hyperliquid exchange sent back unexpected market details.");
    }
    return { index, szDecimals, maxLeverage };
  }

  async function signL1(ctx: ChainContext, privateKey: string, action: MsgpackValue): Promise<{ body: string; nonce: number }> {
    assertMainnetSigningAllowed(ctx.network);
    const libs = await loadLibs();
    const nonce = nextNonce();
    const digest = hyperliquidL1ActionDigest(libs, action, BigInt(nonce), ctx.network);
    const signature = rsv(libs.secp256k1SignDigest(digest, parsePrivateKeyHex(privateKey)));
    return { body: JSON.stringify({ action, nonce, signature, vaultAddress: null }), nonce };
  }

  const evm = ethereumAdapter(loadLibs);

  return {
    chain: "hyperliquid",
    generateKey: evm.generateKey,
    importKey: evm.importKey,
    deriveAddress: evm.deriveAddress,
    validateAddress: evm.validateAddress,
    async getBalance(ctx, address) {
      const state = await post(ctx, "/info", { type: "clearinghouseState", user: address });
      finiteNumber(state?.marginSummary?.accountValue, "account value");
      return { balance: usdcUnits(state?.marginSummary?.accountValue), withdrawable: usdcUnits(state?.withdrawable) };
    },
    async estimateFee() {
      // Hyperliquid charges a flat 1 USDC withdrawal fee, set by the exchange's rules, not by us.
      return HYPERLIQUID_WITHDRAW_FEE;
    },
    async signTransfer(ctx, { privateKey, to, amount, maxFee }) {
      assertMainnetSigningAllowed(ctx.network);
      if (HYPERLIQUID_WITHDRAW_FEE > maxFee) {
        throw new CryptoChainError("fee_over_budget", "This withdrawal did not reserve enough for Hyperliquid's 1 USDC fee.");
      }
      const libs = await loadLibs();
      const time = BigInt(nextNonce());
      const amountText = formatCryptoAmount(amount, 6);
      const hyperliquidChain = ctx.network === "mainnet" ? "Mainnet" : "Testnet";
      const destination = to.toLowerCase();
      const digest = hyperliquidWithdrawDigest(libs, { hyperliquidChain, destination, amount: amountText, time });
      const signature = rsv(libs.secp256k1SignDigest(digest, parsePrivateKeyHex(privateKey)));
      const body = {
        action: { type: "withdraw3", hyperliquidChain, signatureChainId: "0x66eee", amount: amountText, time: Number(time), destination },
        nonce: Number(time),
        signature,
      };
      return { raw: JSON.stringify(body), txHash: `hyperliquid-withdraw-${time.toString()}`, feeUpperBound: HYPERLIQUID_WITHDRAW_FEE, chainDetail: { nonce: Number(time) } };
    },
    async broadcast(ctx, signed) {
      // HTTP trouble throws (unclear: it may have arrived).
      const response = await post(ctx, "/exchange", JSON.parse(signed.raw));
      if (response?.status !== "ok") {
        const reason = hyperliquidRejection(response);
        // The same signed action sent again: its nonce is already used, so it arrived the first time.
        if (/nonce/i.test(reason) && /(used|duplicate|already)/i.test(reason)) return { status: "confirmed", detail: "Accepted by Hyperliquid on an earlier attempt." };
        return { status: "failed", detail: `Hyperliquid refused it: ${reason}` };
      }
      const kind = (JSON.parse(signed.raw) as { action?: { type?: string } }).action?.type;
      if (kind !== "order") return { status: "confirmed", detail: "Accepted by Hyperliquid; it pays out within minutes." };
      const status = response?.response?.data?.statuses?.[0];
      if (status?.filled) return { status: "confirmed", detail: `Filled ${String(status.filled.totalSz)} at ${String(status.filled.avgPx)}.` };
      if (status?.resting) return { status: "confirmed", detail: "The order is waiting on the order book." };
      if (typeof status?.error === "string") return { status: "failed", detail: `Hyperliquid refused the order: ${status.error.slice(0, 200)}` };
      throw new CryptoChainError("broadcast_unclear", "Hyperliquid did not say what happened to the order.");
    },
    async getTxStatus(ctx, tx) {
      // A real lookup: withdrawals in the account's ledger by their nonce,
      // orders by our own order id (cloid). Network trouble throws.
      const nonce = Number(tx.chainDetail?.nonce);
      if (!Number.isSafeInteger(nonce) || nonce <= 0) return "unknown";
      const kind = tx.raw ? (JSON.parse(tx.raw) as { action?: { type?: string } }).action?.type : undefined;
      const pastWindow = tx.checkedAt.getTime() - nonce > HYPERLIQUID_GIVE_UP_AFTER_MS;
      if (kind === "order") {
        const cloid = tx.chainDetail?.cloid;
        if (typeof cloid !== "string") return pastWindow ? "failed" : "unknown";
        const answer = await post(ctx, "/info", { type: "orderStatus", user: tx.from, oid: cloid });
        if (answer?.status === "order") {
          return isRejectedOrderStatus(answer?.order?.status) ? "failed" : "confirmed";
        }
        if (answer?.status === "unknownOid") return pastWindow ? "failed" : "unknown";
        throw new CryptoChainError("bad_response", "The Hyperliquid exchange sent back an unexpected order status.");
      }
      const updates = await post(ctx, "/info", { type: "userNonFundingLedgerUpdates", user: tx.from, startTime: Math.max(0, nonce - 60 * 60_000) });
      if (!Array.isArray(updates)) throw new CryptoChainError("bad_response", "The Hyperliquid exchange sent back an unexpected account history.");
      const found = updates.some((u: any) => u?.delta?.type === "withdraw" && Number(u.delta.nonce) === nonce);
      if (found) return "confirmed";
      return pastWindow ? "failed" : "unknown";
    },
    async midPrice(ctx, coin) {
      const mids = await post(ctx, "/info", { type: "allMids" });
      const value = Number(mids?.[coin]);
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    async accountState(ctx, address) {
      const state = await post(ctx, "/info", { type: "clearinghouseState", user: address });
      const positions = (Array.isArray(state?.assetPositions) ? state.assetPositions : [])
        .map((entry: any) => entry?.position)
        .filter(Boolean)
        .map((p: any) => ({
          coin: String(p.coin),
          size: finiteNumber(p.szi ?? 0, "position size"),
          positionValueUsd: Math.abs(finiteNumber(p.positionValue ?? 0, "position value")),
        }));
      return {
        accountValueUsd: finiteNumber(state?.marginSummary?.accountValue, "account value"),
        withdrawableUsd: finiteNumber(state?.withdrawable ?? 0, "withdrawable amount"),
        positions,
      };
    },
    async signOrder(ctx, input) {
      assertMainnetSigningAllowed(ctx.network);
      const asset = await assetIndex(ctx, input.coin);
      const sizeDecimals = input.size.includes(".") ? input.size.split(".")[1]!.length : 0;
      if (sizeDecimals > asset.szDecimals) {
        throw new CryptoChainError("bad_size", `${input.coin} sizes can have at most ${asset.szDecimals} decimals on Hyperliquid.`);
      }
      const leverage = Math.max(1, Math.min(input.leverage, asset.maxLeverage));
      // Leverage first, every time, so an order never runs at a higher
      // leverage someone set on the exchange directly.
      const leverageAction: MsgpackValue = { type: "updateLeverage", asset: asset.index, isCross: true, leverage };
      const leverageSigned = await signL1(ctx, input.privateKey, leverageAction);
      const cloid = `0x${randomBytes(16).toString("hex")}`;
      const orderAction: MsgpackValue = {
        type: "order",
        orders: [
          {
            a: asset.index,
            b: input.isBuy,
            p: normalizeDecimalString(input.limitPrice),
            s: normalizeDecimalString(input.size),
            r: input.reduceOnly,
            t: { limit: { tif: "Gtc" } },
            // Our own order id, so the order can be looked up later even if
            // the answer to placing it never arrived.
            c: cloid,
          },
        ],
        grouping: "na",
      };
      const orderSigned = await signL1(ctx, input.privateKey, orderAction);
      return {
        leverageRaw: leverageSigned.body,
        order: { raw: orderSigned.body, txHash: `hyperliquid-order-${orderSigned.nonce}`, feeUpperBound: 0n, chainDetail: { nonce: orderSigned.nonce, leverage, cloid } },
      };
    },
    async applyLeverage(ctx, leverageRaw) {
      const response = await post(ctx, "/exchange", JSON.parse(leverageRaw));
      if (response?.status !== "ok") {
        throw new CryptoChainError("leverage_refused", `Hyperliquid refused to set the leverage cap: ${hyperliquidRejection(response)}`);
      }
    },
  };
}

export function defaultCryptoChainAdapters(loadLibs: CryptoLibsLoader = loadCryptoLibs): CryptoChainAdapters {
  return {
    bitcoin: bitcoinAdapter(loadLibs),
    ethereum: ethereumAdapter(loadLibs),
    solana: solanaAdapter(),
    hyperliquid: hyperliquidAdapter(loadLibs),
  };
}

export function chainDecimals(chain: CryptoChain): number {
  return CRYPTO_CHAIN_INFO[chain].decimals;
}
