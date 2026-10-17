import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign } from "node:crypto";
import {
  CRYPTO_CHAIN_INFO,
  EVM_CHAIN_IDS,
  formatCryptoAmount,
  type CryptoChain,
  type CryptoNetwork,
} from "@paperclipai/shared";
import type { OutboundFetch } from "./safe-outbound-fetch.js";
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

export interface ChainContext {
  network: CryptoNetwork;
  /** The endpoint for this chain and network (company setting or default). */
  rpcUrl: string;
  fetch: OutboundFetch;
}

export interface SignedTransfer {
  /** What broadcast() sends. A signed transaction is public once sent; it never contains the key. */
  raw: string;
  /** Known before broadcast for Bitcoin/Ethereum/Solana; for Hyperliquid an internal reference. */
  txHash: string;
  feeUpperBound: bigint;
}

export type ChainTxStatus = "pending" | "confirmed" | "failed" | "unknown";

export interface CryptoChainAdapter {
  chain: CryptoChain;
  generateKey(network: CryptoNetwork): Promise<{ privateKey: string; address: string }>;
  /** Accepts the formats wallets export (hex, WIF, base58, JSON byte array). Never echoes the input in an error. */
  importKey(raw: string, network: CryptoNetwork): Promise<{ privateKey: string; address: string }>;
  deriveAddress(privateKey: string, network: CryptoNetwork): Promise<string>;
  /** Normalized address, or null when it is not a valid address for this chain and network. */
  validateAddress(address: string, network: CryptoNetwork): Promise<string | null>;
  getBalance(ctx: ChainContext, address: string): Promise<{ balance: bigint; withdrawable?: bigint }>;
  estimateFee(ctx: ChainContext, input: { from: string; to: string; amount: bigint }): Promise<bigint>;
  signTransfer(ctx: ChainContext, input: { privateKey: string; from: string; to: string; amount: bigint }): Promise<SignedTransfer>;
  /** Returns the final status when the network decides at once (Hyperliquid), otherwise "pending". */
  broadcast(ctx: ChainContext, signed: SignedTransfer): Promise<ChainTxStatus>;
  getTxStatus(ctx: ChainContext, txHash: string): Promise<ChainTxStatus>;
}

export interface HyperliquidAccountState {
  accountValueUsd: number;
  withdrawableUsd: number;
  positions: Array<{ coin: string; size: number; positionValueUsd: number }>;
}

export interface HyperliquidOrderResult {
  status: "filled" | "resting" | "error";
  orderRef: string | null;
  detail: string;
}

export interface HyperliquidAdapter extends CryptoChainAdapter {
  chain: "hyperliquid";
  midPrice(ctx: ChainContext, coin: string): Promise<number | null>;
  accountState(ctx: ChainContext, address: string): Promise<HyperliquidAccountState>;
  placeOrder(
    ctx: ChainContext,
    input: { privateKey: string; address: string; coin: string; isBuy: boolean; size: string; limitPrice: string; reduceOnly: boolean; leverage: number },
  ): Promise<HyperliquidOrderResult>;
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

export function bitcoinAdapter(loadLibs: CryptoLibsLoader = loadCryptoLibs): CryptoChainAdapter {
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
      .filter((u) => u?.status?.confirmed === true && /^[0-9a-f]{64}$/.test(u.txid) && Number.isSafeInteger(u.value))
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
      const rate = Math.min(await feeRate(ctx), BTC_MAX_FEE_RATE);
      const utxos = await confirmedUtxos(ctx, from);
      const planned = plan(utxos, amount, rate);
      return planned ? planned.fee : BigInt(p2wpkhVsize(1, 2) * rate);
    },
    async signTransfer(ctx, { privateKey, from, to, amount }) {
      const libs = await loadLibs();
      const rate = await feeRate(ctx);
      if (rate > BTC_MAX_FEE_RATE) {
        throw new CryptoChainError("fee_too_high", "Bitcoin network fees are unusually high right now. Try again later.");
      }
      const utxos = await confirmedUtxos(ctx, from);
      const planned = plan(utxos, amount, rate);
      if (!planned) throw new CryptoChainError("insufficient_funds", "The wallet does not have enough confirmed bitcoin for this payment and its network fee.");
      const outputs = [{ address: to, amount }];
      if (planned.change > 0n) outputs.push({ address: from, amount: planned.change });
      const signed = libs.bitcoinSignP2wpkh({ privateKey: parsePrivateKeyHex(privateKey), network: ctx.network, utxos: planned.chosen, outputs });
      return { raw: signed.hex, txHash: signed.txid, feeUpperBound: planned.fee };
    },
    async broadcast(ctx, signed) {
      const response = await ctx.fetch(joinUrl(ctx.rpcUrl, "/tx"), { method: "POST", headers: { "content-type": "text/plain" }, body: signed.raw });
      const text = (await response.text()).trim();
      if (!response.ok) throw new CryptoChainError("broadcast_refused", `The bitcoin network refused the payment: ${text.slice(0, 200)}`);
      if (text && text !== signed.txHash) throw new CryptoChainError("broadcast_mismatch", "The bitcoin network service answered with a different transaction id.");
      return "pending";
    },
    async getTxStatus(ctx, txHash) {
      const response = await ctx.fetch(joinUrl(ctx.rpcUrl, `/tx/${txHash}/status`));
      if (response.status === 404) return "unknown";
      if (!response.ok) return "unknown";
      const body = await readJson(response, "The bitcoin network service");
      return body?.confirmed === true ? "confirmed" : "pending";
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

export function ethereumAdapter(loadLibs: CryptoLibsLoader = loadCryptoLibs): CryptoChainAdapter {
  const what = "The Ethereum network service";

  async function assertChainId(ctx: ChainContext) {
    const chainId = hexQuantity(await jsonRpc(ctx, "eth_chainId", [], what), what);
    if (chainId !== BigInt(EVM_CHAIN_IDS[ctx.network])) {
      throw new CryptoChainError(
        "wrong_network",
        `The Ethereum network service is on a different network than this wallet (${ctx.network === "mainnet" ? "main network" : "Sepolia test network"}). Check the network address in the crypto settings.`,
      );
    }
  }

  async function feeParams(ctx: ChainContext, from: string, to: string, amount: bigint) {
    const block = await jsonRpc(ctx, "eth_getBlockByNumber", ["latest", false], what);
    const baseFee = hexQuantity(block?.baseFeePerGas, what);
    let priority = 1_500_000_000n;
    try {
      priority = hexQuantity(await jsonRpc(ctx, "eth_maxPriorityFeePerGas", [], what), what);
    } catch {
      // Some endpoints do not offer this; 1.5 gwei is a safe tip.
    }
    const maxFee = baseFee * 2n + priority;
    const gas = hexQuantity(await jsonRpc(ctx, "eth_estimateGas", [{ from, to, value: `0x${amount.toString(16)}` }], what), what);
    if (gas > EVM_MAX_GAS) {
      throw new CryptoChainError("gas_too_high", "This address is a program that needs more network fee than a plain payment is allowed to use.");
    }
    return { maxFee, priority, gas };
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
      const fees = await feeParams(ctx, from, to, amount);
      return fees.gas * fees.maxFee;
    },
    async signTransfer(ctx, { privateKey, from, to, amount }) {
      const libs = await loadLibs();
      await assertChainId(ctx);
      const nonce = hexQuantity(await jsonRpc(ctx, "eth_getTransactionCount", [from, "pending"], what), what);
      const fees = await feeParams(ctx, from, to, amount);
      const chainId = BigInt(EVM_CHAIN_IDS[ctx.network]);
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
      return { raw: `0x${bytesToHex(signed)}`, txHash: `0x${bytesToHex(libs.keccak256(signed))}`, feeUpperBound: fees.gas * fees.maxFee };
    },
    async broadcast(ctx, signed) {
      const hash = await jsonRpc(ctx, "eth_sendRawTransaction", [signed.raw], what);
      if (typeof hash === "string" && hash.toLowerCase() !== signed.txHash.toLowerCase()) {
        throw new CryptoChainError("broadcast_mismatch", "The Ethereum network service answered with a different transaction id.");
      }
      return "pending";
    },
    async getTxStatus(ctx, txHash) {
      const receipt = await jsonRpc(ctx, "eth_getTransactionReceipt", [txHash], what);
      if (!receipt) return "pending";
      if (receipt.status === "0x1") return "confirmed";
      if (receipt.status === "0x0") return "failed";
      return "unknown";
    },
  };
}

// ─── Solana (Node's built-in Ed25519, no extra library) ─────────────────────

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SOLANA_SYSTEM_PROGRAM = new Uint8Array(32);
const SOLANA_FEE_LAMPORTS = 5_000n;
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
      return SOLANA_FEE_LAMPORTS;
    },
    async signTransfer(ctx, { privateKey, from, to, amount }) {
      const seed = seedOf(privateKey);
      const fromKey = solanaPublicKey(seed);
      if (base58Encode(fromKey) !== from) throw new CryptoChainError("key_mismatch", "The stored key does not belong to this wallet.");
      const toKey = base58Decode(to);
      if (Buffer.compare(Buffer.from(fromKey), Buffer.from(toKey)) === 0) {
        throw new CryptoChainError("self_send", "A wallet cannot send to itself.");
      }
      const target = await jsonRpc(ctx, "getBalance", [to, { commitment: "confirmed" }], what);
      if (Number(target?.value ?? 0) === 0 && amount < SOLANA_RENT_EXEMPT_MINIMUM) {
        throw new CryptoChainError(
          "below_rent_minimum",
          "That address has no SOL yet, and the Solana network refuses a first payment smaller than 0.00089088 SOL.",
        );
      }
      const latest = await jsonRpc(ctx, "getLatestBlockhash", [{ commitment: "confirmed" }], what);
      const blockhash = latest?.value?.blockhash;
      if (typeof blockhash !== "string") throw new CryptoChainError("bad_response", `${what} did not send a recent block id.`);
      const message = solanaTransferMessage(fromKey, toKey, amount, base58Decode(blockhash));
      const signature = new Uint8Array(nodeSign(null, Buffer.from(message), solanaKeyObject(seed)));
      const tx = concatBytes(compactU16(1), signature, message);
      return { raw: Buffer.from(tx).toString("base64"), txHash: base58Encode(signature), feeUpperBound: SOLANA_FEE_LAMPORTS };
    },
    async broadcast(ctx, signed) {
      const sig = await jsonRpc(ctx, "sendTransaction", [signed.raw, { encoding: "base64", preflightCommitment: "confirmed" }], what);
      if (typeof sig === "string" && sig !== signed.txHash) {
        throw new CryptoChainError("broadcast_mismatch", "The Solana network service answered with a different transaction id.");
      }
      return "pending";
    },
    async getTxStatus(ctx, txHash) {
      const result = await jsonRpc(ctx, "getSignatureStatuses", [[txHash], { searchTransactionHistory: true }], what);
      const status = result?.value?.[0];
      if (!status) return "unknown";
      if (status.err) return "failed";
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return "confirmed";
      return "pending";
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

export function hyperliquidAdapter(loadLibs: CryptoLibsLoader = loadCryptoLibs, nowMs: () => number = () => Date.now()): HyperliquidAdapter {
  let lastNonce = 0;
  const nextNonce = () => {
    lastNonce = Math.max(nowMs(), lastNonce + 1);
    return lastNonce;
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
    return { index, szDecimals: Number(universe[index].szDecimals ?? 0), maxLeverage: Number(universe[index].maxLeverage ?? 1) };
  }

  async function signAndSendL1(ctx: ChainContext, privateKey: string, action: MsgpackValue): Promise<any> {
    const libs = await loadLibs();
    const nonce = nextNonce();
    const digest = hyperliquidL1ActionDigest(libs, action, BigInt(nonce), ctx.network);
    const signature = rsv(libs.secp256k1SignDigest(digest, parsePrivateKeyHex(privateKey)));
    return post(ctx, "/exchange", { action, nonce, signature, vaultAddress: null });
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
      return { balance: usdcUnits(state?.marginSummary?.accountValue), withdrawable: usdcUnits(state?.withdrawable) };
    },
    async estimateFee() {
      // Hyperliquid charges a flat 1 USDC withdrawal fee.
      return 1_000_000n;
    },
    async signTransfer(ctx, { privateKey, to, amount }) {
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
      return { raw: JSON.stringify(body), txHash: `hyperliquid-withdraw-${time.toString()}`, feeUpperBound: 1_000_000n };
    },
    async broadcast(ctx, signed) {
      const response = await post(ctx, "/exchange", JSON.parse(signed.raw));
      if (response?.status !== "ok") {
        const detail = typeof response?.response === "string" ? response.response.slice(0, 200) : "unknown reason";
        throw new CryptoChainError("broadcast_refused", `Hyperliquid refused the withdrawal: ${detail}`);
      }
      // Accepted by the exchange; it pays out on Arbitrum within minutes.
      return "confirmed";
    },
    async getTxStatus() {
      return "confirmed";
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
        .map((p: any) => ({ coin: String(p.coin), size: Number(p.szi ?? 0), positionValueUsd: Math.abs(Number(p.positionValue ?? 0)) }));
      return {
        accountValueUsd: Number(state?.marginSummary?.accountValue ?? 0),
        withdrawableUsd: Number(state?.withdrawable ?? 0),
        positions,
      };
    },
    async placeOrder(ctx, input) {
      const asset = await assetIndex(ctx, input.coin);
      const sizeDecimals = input.size.includes(".") ? input.size.split(".")[1]!.length : 0;
      if (sizeDecimals > asset.szDecimals) {
        throw new CryptoChainError("bad_size", `${input.coin} sizes can have at most ${asset.szDecimals} decimals on Hyperliquid.`);
      }
      const leverage = Math.max(1, Math.min(input.leverage, asset.maxLeverage));
      // Leverage first, every time, so an order never runs at a higher
      // leverage someone set on the exchange directly.
      const leverageAction: MsgpackValue = { type: "updateLeverage", asset: asset.index, isCross: true, leverage };
      const leverageResult = await signAndSendL1(ctx, input.privateKey, leverageAction);
      if (leverageResult?.status !== "ok") {
        const detail = typeof leverageResult?.response === "string" ? leverageResult.response.slice(0, 200) : "unknown reason";
        return { status: "error", orderRef: null, detail: `Hyperliquid refused to set the leverage cap: ${detail}` };
      }
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
          },
        ],
        grouping: "na",
      };
      const result = await signAndSendL1(ctx, input.privateKey, orderAction);
      if (result?.status !== "ok") {
        const detail = typeof result?.response === "string" ? result.response.slice(0, 200) : "unknown reason";
        return { status: "error", orderRef: null, detail: `Hyperliquid refused the order: ${detail}` };
      }
      const status = result?.response?.data?.statuses?.[0];
      if (status?.filled) return { status: "filled", orderRef: String(status.filled.oid ?? ""), detail: `Filled ${status.filled.totalSz} at ${status.filled.avgPx}.` };
      if (status?.resting) return { status: "resting", orderRef: String(status.resting.oid ?? ""), detail: "The order is waiting on the order book." };
      return { status: "error", orderRef: null, detail: typeof status?.error === "string" ? status.error.slice(0, 200) : "Hyperliquid did not say what happened to the order." };
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
